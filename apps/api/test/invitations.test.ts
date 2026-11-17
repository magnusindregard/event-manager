import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { registration, tenancy } from "@event-manager/domain";
import { buildApp } from "../src/app.js";
import { DEV_ISSUER, devVerifier } from "../src/auth.js";
import { csvField } from "../src/routes/invitations.js";

// /v1 guest list (docs/registration.md, milestone 3) and the Postmark delivery webhook.

const SECRET = "test-secret";
const HOOK = { user: "postmark", password: "s3cret-hook" };
let tdb: TestDatabase;
let db: Db;
let app: Awaited<ReturnType<typeof buildApp>>;
let A: string;
let B: string;

const token = (email: string) =>
  new SignJWT({ email }).setProtectedHeader({ alg: "HS256" }).setIssuer(DEV_ISSUER).setSubject(email).setExpirationTime("5m").sign(new TextEncoder().encode(SECRET));

async function call(method: string, url: string, opts: { as?: string; account?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...opts.headers };
  headers.authorization = `Bearer ${await token(opts.as ?? "owner@a.test")}`;
  headers["account-id"] = opts.account ?? A;
  const res = await app.inject({ method: method as "GET", url, headers, ...(opts.body !== undefined ? { payload: opts.body as object } : {}) });
  const json = res.headers["content-type"]?.toString().includes("json");
  return { status: res.statusCode, headers: res.headers, body: res.body && json ? res.json() : res.body };
}

const hook = (payload: object, auth = `Basic ${Buffer.from(`${HOOK.user}:${HOOK.password}`).toString("base64")}`) =>
  app.inject({ method: "POST", url: "/webhooks/postmark", headers: { authorization: auth }, payload });

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  app = await buildApp({ db, verifier: devVerifier(SECRET), attendeeUrl: "https://attend.test/", postmarkWebhook: HOOK });
  A = (await tenancy.createAccount(db, { slug: "inv-a", name: "A", ownerEmail: "owner@a.test" })).id;
  B = (await tenancy.createAccount(db, { slug: "inv-b", name: "B", ownerEmail: "owner@b.test" })).id;
  await call("GET", "/v1/me");
  await call("GET", "/v1/me", { as: "owner@b.test", account: B });
});
afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await tdb?.stop();
});

describe("/v1 guest list", () => {
  let eventId: string;
  let kariId: string;

  it("imports a CSV through upload, preview and commit", async () => {
    const ev = await call("POST", "/v1/events", { body: { translations: { nb: { title: "Galla" } }, admissionMode: "registration", registration: { accessPolicy: "invite_only", capacity: 100 } } });
    eventId = ev.body.id;
    await call("POST", `/v1/events/${eventId}/occurrences`, { body: { startUtc: new Date(Date.now() + 30 * 86_400_000).toISOString() } });

    const csv = "Navn;E-post;Kontakt-ID\nKari Nordmann;kari@example.com;c-1\n=HYPERLINK(\"x\");evil@example.com;\nfeil;ikke-epost;\n";
    const up = await call("POST", `/v1/events/${eventId}/guest-imports`, { body: { fileName: "gjester.csv", content: Buffer.from(csv).toString("base64") } });
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ headers: ["Navn", "E-post", "Kontakt-ID"], rowCount: 3, mapping: { name: 0, email: 1, externalContactId: 2 } });
    const preview = await call("POST", `/v1/guest-imports/${up.body.id}/preview`, { body: { mapping: up.body.mapping } });
    expect(preview.body).toMatchObject({ added: 2, errors: [{ line: 4, code: "invalid_email" }] });
    const commit = await call("POST", `/v1/guest-imports/${up.body.id}/commit`, { body: { mapping: up.body.mapping } });
    expect(commit.body).toMatchObject({ added: 2, skipped: 1 });

    const list = await call("GET", `/v1/events/${eventId}/invitations`);
    expect(list.body.counts).toMatchObject({ total: 2, pending: 2 });
    kariId = list.body.items.find((i: { email: string }) => i.email === "kari@example.com").id;
    expect((await call("GET", `/v1/events/${eventId}/invitations?status=accepted`)).body.items).toEqual([]);
  });

  it("rejects bad files and unknown imports", async () => {
    const bad = await call("POST", `/v1/events/${eventId}/guest-imports`, { body: { fileName: "x.xlsx", content: Buffer.from("PKnot a zip").toString("base64") } });
    expect(bad).toMatchObject({ status: 422, body: { code: "validation_failed" } });
    const gone = await call("POST", `/v1/guest-imports/${crypto.randomUUID()}/commit`, { body: { mapping: { email: 0 } } });
    expect(gone.status).toBe(404);
  });

  it("adds and edits single guests", async () => {
    const add = await call("POST", `/v1/events/${eventId}/invitations`, { body: { email: "Ola@Example.com", name: "Ola", guestAllowed: true } });
    expect(add.status).toBe(201);
    expect(add.body).toMatchObject({ email: "ola@example.com", guestAllowed: true, status: "pending", lastSend: null, registration: null });
    const dup = await call("POST", `/v1/events/${eventId}/invitations`, { body: { email: "ola@example.com" } });
    expect(dup).toMatchObject({ status: 409, body: { code: "conflict" } });
    const patched = await call("PATCH", `/v1/invitations/${add.body.id}`, { body: { locale: "en" }, headers: { "if-match": add.headers.etag as string } });
    expect(patched.body).toMatchObject({ locale: "en", version: 2 });
    const badLocale = await call("PATCH", `/v1/invitations/${add.body.id}`, { body: { locale: "fr" }, headers: { "if-match": '"2"' } });
    expect(badLocale.status).toBe(422);
  });

  it("exports links as CSV, with formulas defused", async () => {
    const res = await call("GET", `/v1/events/${eventId}/invitations/links.csv`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const text = res.body as string;
    expect(text.startsWith("﻿email;name;locale;external_contact_id;status;link\r\n")).toBe(true);
    expect(text).toMatch(/kari@example\.com;Kari Nordmann;;c-1;pending;https:\/\/attend\.test\/i\/[A-Za-z0-9_-]{72}/);
    expect(text).toContain(`evil@example.com;"'=HYPERLINK(""x"")"`);
    expect(csvField("a,b", ",")).toBe('"a,b"');
  });

  it("copies and rotates a guest's link", async () => {
    const a = await call("GET", `/v1/invitations/${kariId}/link`);
    const b = await call("POST", `/v1/invitations/${kariId}/rotate-link`);
    expect(a.body.url).toMatch(/^https:\/\/attend\.test\/i\//);
    expect(b.body.url).not.toBe(a.body.url);
    const old = a.body.url.split("/i/")[1];
    expect(await withTenant(db, { tenantId: A }, (tx) => registration.invitationByToken(tx, old))).toBeNull();
  });

  it("sends only for published events", async () => {
    const draft = await call("POST", `/v1/events/${eventId}/invitations/send`, { body: { kind: "invitation" } });
    expect(draft).toMatchObject({ status: 409, body: { code: "conflict" } });
    const ev = await call("GET", `/v1/events/${eventId}`);
    await call("POST", `/v1/events/${eventId}/publish`, { headers: { "if-match": ev.headers.etag as string } });
    const sent = await call("POST", `/v1/events/${eventId}/invitations/send`, { body: { kind: "invitation" } });
    expect(sent).toMatchObject({ status: 202, body: { queued: 3, skipped: 0 } });
    // A resend while the first email is still queued is skipped.
    const again = await call("POST", `/v1/events/${eventId}/invitations/send`, { body: { kind: "invitation", ids: [kariId] } });
    expect(again.body).toEqual({ queued: 0, skipped: 1 });
  });

  it("keeps guest lists apart between accounts", async () => {
    const other = await call("GET", `/v1/events/${eventId}/invitations`, { as: "owner@b.test", account: B });
    expect(other.body.items).toEqual([]);
    const link = await call("GET", `/v1/invitations/${kariId}/link`, { as: "owner@b.test", account: B });
    expect(link.status).toBe(404);
  });

  it("records Postmark delivery reports on the matching send", async () => {
    const send = await withTenant(db, { tenantId: A }, async (tx) => {
      const s = await tx.selectFrom("registration.invitation_send").select("id").where("invitation_id", "=", kariId).orderBy("requested_at").executeTakeFirstOrThrow();
      await registration.recordSent(tx, A, s.id, "pm-123");
      return s;
    });
    const meta = { tenantId: A, sendId: send.id };
    expect((await hook({ RecordType: "Delivery", MessageID: "pm-123", Metadata: meta }, "Basic bm8=")).statusCode).toBe(401);
    expect((await hook({ RecordType: "Open", MessageID: "pm-123", Metadata: meta })).json()).toMatchObject({ ignored: true });
    expect((await hook({ RecordType: "Bounce", Type: "Transient", MessageID: "pm-123", Metadata: meta })).json()).toMatchObject({ ignored: true });
    // The wrong tenant finds nothing.
    expect((await hook({ RecordType: "Delivery", MessageID: "pm-123", Metadata: { ...meta, tenantId: B } })).json()).toMatchObject({ matched: false });
    expect((await hook({ RecordType: "Bounce", Type: "HardBounce", Description: "Unknown user", MessageID: "pm-123", BouncedAt: "2027-01-01T10:00:00Z", Metadata: meta })).json()).toMatchObject({ matched: true });
    const list = await call("GET", `/v1/events/${eventId}/invitations`);
    const kari = list.body.items.find((i: { id: string }) => i.id === kariId);
    expect(kari.lastSend).toMatchObject({ deliveryStatus: "bounced", deliveryDetail: "HardBounce: Unknown user" });
    expect(list.body.counts.undeliverable).toBe(1);
    const first = await withTenant(db, { tenantId: A }, (tx) => tx.selectFrom("registration.invitation_send").select(["delivery_status", "delivery_detail"]).where("id", "=", send.id).executeTakeFirstOrThrow());
    expect(first).toEqual({ delivery_status: "bounced", delivery_detail: "HardBounce: Unknown user" });
  });
});
