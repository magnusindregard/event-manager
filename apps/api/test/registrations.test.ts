import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { tenancy } from "@event-manager/domain";
import { buildApp } from "../src/app.js";
import { DEV_ISSUER, devVerifier } from "../src/auth.js";

const SECRET = "test-secret";
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
  return { status: res.statusCode, headers: res.headers, body: res.body ? res.json() : undefined };
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  app = await buildApp({ db, verifier: devVerifier(SECRET) });
  A = (await tenancy.createAccount(db, { slug: "reg-a", name: "A", ownerEmail: "owner@a.test" })).id;
  B = (await tenancy.createAccount(db, { slug: "reg-b", name: "B", ownerEmail: "owner@b.test" })).id;
  await call("GET", "/v1/me");
  await call("GET", "/v1/me", { as: "owner@b.test", account: B });
});
afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await tdb?.stop();
});

describe("/v1 registrations", () => {
  let occurrenceId: string;
  let registrationId: string;

  it("adds people by hand within the places", async () => {
    const ev = await call("POST", "/v1/events", { body: { translations: { nb: { title: "Gallamiddag" } }, admissionMode: "registration", registration: { capacity: 2 } } });
    expect(ev.status).toBe(201);
    const occ = await call("POST", `/v1/events/${ev.body.id}/occurrences`, { body: { startUtc: new Date(Date.now() + 30 * 86_400_000).toISOString() } });
    occurrenceId = occ.body.id;

    // Staff may add a guest although the event offers none, and on a draft event.
    const kari = await call("POST", `/v1/occurrences/${occurrenceId}/registrations`, { body: { name: "Kari", email: "kari@example.com", partySize: 2 } });
    expect(kari.status).toBe(201);
    expect(kari.body).toMatchObject({ name: "Kari", partySize: 2, status: "confirmed", source: "staff", version: 1 });
    expect(kari.headers.etag).toBe('"1"');
    registrationId = kari.body.id;

    const full = await call("POST", `/v1/occurrences/${occurrenceId}/registrations`, { body: { name: "Ola", email: "ola@example.com" } });
    expect(full).toMatchObject({ status: 409, body: { code: "full" } });

    const list = await call("GET", `/v1/occurrences/${occurrenceId}/registrations`);
    expect(list.body.items.map((r: { email: string }) => r.email)).toEqual(["kari@example.com"]);
    const occAfter = await call("GET", `/v1/occurrences/${occurrenceId}`);
    expect(occAfter.body.pool).toMatchObject({ taken: 2, available: 0 });
  });

  it("edits with If-Match and cancels", async () => {
    const stale = await call("PATCH", `/v1/registrations/${registrationId}`, { body: { partySize: 1 }, headers: { "if-match": '"7"' } });
    expect(stale.status).toBe(412);
    const ok = await call("PATCH", `/v1/registrations/${registrationId}`, { body: { partySize: 1 }, headers: { "if-match": '"1"' } });
    expect(ok.body).toMatchObject({ partySize: 1, version: 2 });
    const cancelled = await call("POST", `/v1/registrations/${registrationId}/cancel`);
    expect(cancelled.body).toMatchObject({ status: "cancelled", cancelledBy: "staff" });
    const active = await call("GET", `/v1/occurrences/${occurrenceId}/registrations?status=confirmed`);
    expect(active.body.items).toEqual([]);
  });

  it("refuses to delete an occurrence with registrations", async () => {
    const occ = await call("GET", `/v1/occurrences/${occurrenceId}`);
    const del = await call("DELETE", `/v1/occurrences/${occurrenceId}`, { headers: { "if-match": occ.headers.etag as string } });
    expect(del).toMatchObject({ status: 409, body: { code: "conflict" } });
  });

  it("keeps other tenants out", async () => {
    const list = await call("GET", `/v1/occurrences/${occurrenceId}/registrations`, { as: "owner@b.test", account: B });
    // Another tenant's occurrence does not exist for B.
    expect(list.status).toBe(404);
    const cancel = await call("POST", `/v1/registrations/${registrationId}/cancel`, { as: "owner@b.test", account: B });
    expect(cancel.status).toBe(404);
  });
});

describe("/v1 forms, answers and the door list", () => {
  let eventId: string;
  let occurrenceId: string;

  it("saves the form and takes answers, with consent for sensitive ones", async () => {
    const ev = await call("POST", "/v1/events", { body: { translations: { nb: { title: "Galla" } }, admissionMode: "registration", registration: { capacity: 50 } } });
    eventId = ev.body.id;
    occurrenceId = (await call("POST", `/v1/events/${eventId}/occurrences`, { body: { startUtc: new Date(Date.now() + 30 * 86_400_000).toISOString() } })).body.id;
    expect((await call("GET", `/v1/events/${eventId}/form`)).body).toEqual({ eventId, version: 0, fields: [] });
    const form = await call("PUT", `/v1/events/${eventId}/form`, {
      body: { version: 0, fields: [{ id: "diet", type: "dietary", label: { nb: "Matbehov" } }, { id: "org", type: "text", label: { nb: "Organisasjon" } }] },
    });
    expect(form.status).toBe(200);
    expect(form.body).toMatchObject({ version: 1, fields: [{ id: "diet", sensitive: true }, { id: "org", sensitive: false }] });
    expect((await call("PUT", `/v1/events/${eventId}/form`, { body: { version: 0, fields: [] } })).status).toBe(412);

    const noConsent = await call("POST", `/v1/occurrences/${occurrenceId}/registrations`, { body: { name: "Per", email: "per@example.com", answers: { diet: "Gluten" } } });
    expect(noConsent).toMatchObject({ status: 422, body: { code: "validation_failed" } });
    const per = await call("POST", `/v1/occurrences/${occurrenceId}/registrations`, {
      body: { name: "Per; Hansen", email: "per@example.com", partySize: 2, answers: { diet: "Gluten", org: "=SUM(A1)" }, consent: true },
    });
    expect(per.status).toBe(201);
    expect(per.body).toMatchObject({ answers: { diet: "Gluten", org: "=SUM(A1)" }, hiddenSensitiveAnswers: false, sensitiveConsentAt: expect.any(String) });
  });

  it("hides sensitive answers and guest data by role", async () => {
    await call("POST", "/v1/account/invitations", { body: { email: "editor@a.test", role: "editor" } });
    await call("POST", "/v1/account/invitations", { body: { email: "manager@a.test", role: "event_manager" } });
    await call("GET", "/v1/me", { as: "editor@a.test" });
    await call("GET", "/v1/me", { as: "manager@a.test" });

    const manager = await call("GET", `/v1/occurrences/${occurrenceId}/registrations`, { as: "manager@a.test" });
    expect(manager.body.fields.map((f: { id: string }) => f.id)).toEqual(["diet", "org"]);
    expect(manager.body.items[0].answers).toEqual({ diet: "Gluten", org: "=SUM(A1)" });

    const editor = await call("GET", `/v1/occurrences/${occurrenceId}/registrations`, { as: "editor@a.test" });
    expect(editor.status).toBe(403);
    // Editors build the form, though.
    expect((await call("GET", `/v1/events/${eventId}/form`, { as: "editor@a.test" })).body.version).toBe(1);
  });

  it("exports the door list as JSON and CSV", async () => {
    const json = await call("GET", `/v1/occurrences/${occurrenceId}/door-list?answers=true`);
    expect(json.body).toMatchObject({ totals: { registrations: 1, people: 2 }, columns: [{ fieldId: "diet", label: "Matbehov", sensitive: true }, { fieldId: "org" }] });
    expect(json.headers["cache-control"]).toBe("no-store");

    const res = await app.inject({
      method: "GET", url: `/v1/occurrences/${occurrenceId}/door-list.csv?answers=true`,
      headers: { authorization: `Bearer ${await token("owner@a.test")}`, "account-id": A },
    });
    expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
    const lines = res.body.replace(/^\uFEFF/, "").trim().split("\r\n");
    expect(lines).toEqual(["name;email;party_size;source;Matbehov;Organisasjon", '"Per; Hansen";per@example.com;2;staff;Gluten;\'=SUM(A1)']);
  });

  it("keeps personal data and decrypted answers out of the idempotency cache", async () => {
    const body = { name: "Ida Idem", email: "ida@example.com", answers: { diet: "Skalldyr", org: "SINTEF" }, consent: true };
    const headers = { "idempotency-key": "reg-sensitive-1" };
    const first = await call("POST", `/v1/occurrences/${occurrenceId}/registrations`, { body, headers });
    expect(first.status).toBe(201);
    const stored = await withTenant(db, { tenantId: A }, (tx) =>
      tx.selectFrom("tenancy.idempotency_key").select("response").where("key", "=", "reg-sensitive-1").executeTakeFirstOrThrow());
    expect(stored.response as unknown).toEqual({ id: first.body.id });

    // The replay is rebuilt from the registration, as the caller may see it now.
    const replay = await call("POST", `/v1/occurrences/${occurrenceId}/registrations`, { body, headers });
    expect(replay).toMatchObject({ status: 201, body: { id: first.body.id, name: "Ida Idem", answers: { diet: "Skalldyr", org: "SINTEF" } } });
    // Keys are per account, so another member can hit the same key; their current access decides.
    expect((await call("POST", `/v1/occurrences/${occurrenceId}/registrations`, { as: "editor@a.test", body, headers })).status).toBe(403);
  });
});

