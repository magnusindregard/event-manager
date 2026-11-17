import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "@event-manager/db";
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
    expect(list.body.items).toEqual([]);
    const cancel = await call("POST", `/v1/registrations/${registrationId}/cancel`, { as: "owner@b.test", account: B });
    expect(cancel.status).toBe(404);
  });
});
