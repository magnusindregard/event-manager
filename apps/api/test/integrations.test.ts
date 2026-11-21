import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { tenancy } from "@event-manager/domain";
import { FakeHubSpot, OPTIONAL_SCOPES, REQUIRED_SCOPES, signState } from "@event-manager/hubspot";
import { buildApp } from "../src/app.js";
import { DEV_ISSUER, devVerifier } from "../src/auth.js";

// HubSpot connector milestone 1 over HTTP (docs/hubspot.md): connecting with OAuth, settings,
// repair and disconnect.

const SECRET = "test-secret";
const APP_SECRET = "hubspot-app-secret";
let tdb: TestDatabase;
let db: Db;
let hubspot: FakeHubSpot;
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

/** Starts connecting as `as` and returns the state from the install URL. */
async function start(as = "owner@a.test", account = A) {
  const r = await call("POST", "/v1/integrations/hubspot/authorize", { as, account });
  expect(r.status).toBe(200);
  return new URL(r.body.url).searchParams.get("state")!;
}

const ALL_SCOPES = [...REQUIRED_SCOPES, ...OPTIONAL_SCOPES];

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  hubspot = new FakeHubSpot();
  app = await buildApp({ db, verifier: devVerifier(SECRET), hubspot: { client: hubspot, clientSecret: APP_SECRET } });
  A = (await tenancy.createAccount(db, { slug: "int-a", name: "A", ownerEmail: "owner@a.test" })).id;
  B = (await tenancy.createAccount(db, { slug: "int-b", name: "B", ownerEmail: "owner@b.test" })).id;
  await call("GET", "/v1/me");
  await call("GET", "/v1/me", { as: "owner@b.test" });
  await call("POST", "/v1/account/invitations", { body: { email: "manager@a.test", role: "event_manager" } });
  await call("POST", "/v1/account/invitations", { body: { email: "owner2@a.test", role: "owner" } });
  await call("GET", "/v1/me", { as: "manager@a.test" });
  await call("GET", "/v1/me", { as: "owner2@a.test" });
});
afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await tdb?.stop();
});

describe("/v1/integrations", () => {
  it("says whether HubSpot is available, and lists nothing before connecting", async () => {
    expect((await call("GET", "/v1/integrations")).body).toEqual({ items: [], available: { hubspot: true } });
    const off = await buildApp({ db, verifier: devVerifier(SECRET) });
    const r = await off.inject({ method: "POST", url: "/v1/integrations/hubspot/authorize", headers: { authorization: `Bearer ${await token("owner@a.test")}`, "account-id": A } });
    expect(r.statusCode).toBe(409);
    await off.close();
  });

  it("gives owners an install URL with our scopes and a signed state", async () => {
    const r = await call("POST", "/v1/integrations/hubspot/authorize");
    expect(r.headers["cache-control"]).toBe("no-store");
    const u = new URL(r.body.url);
    expect(u.searchParams.get("scope")!.split(" ")).toEqual([...REQUIRED_SCOPES]);
    expect(u.searchParams.get("optional_scope")!.split(" ")).toEqual([...OPTIONAL_SCOPES]);
    expect((await call("POST", "/v1/integrations/hubspot/authorize", { as: "manager@a.test" })).status).toBe(403);
  });

  it("refuses a state that is forged, expired, or started by another user or for another account", async () => {
    const code = hubspot.approve("555", ALL_SCOPES);
    const cases = [
      ["garbage", 422],
      [signState("other-secret", { tenantId: A, userId: "x" }), 422],
      [signState(APP_SECRET, { tenantId: A, userId: "x" }, -1), 422],
      [await start("owner2@a.test"), 403],
      [await start("owner@b.test", B), 403],
    ] as const;
    for (const [state, status] of cases) {
      expect((await call("POST", "/v1/integrations/hubspot/callback", { body: { code, state } })).status, state.slice(0, 12)).toBe(status);
    }
    expect((await call("POST", "/v1/integrations/hubspot/callback", { as: "manager@a.test", body: { code, state: await start() } })).status).toBe(403);
    // None of these exchanged the code.
    expect(hubspot.calls).not.toContain("exchangeCode");
    expect((await call("POST", "/v1/integrations/hubspot/callback", { body: { code: "unknown", state: await start() } })).status).toBe(422);
  });

  it("connects with the code and state, and shows the portal, scopes and features", async () => {
    const code = hubspot.approve("4711", REQUIRED_SCOPES.slice());
    const r = await call("POST", "/v1/integrations/hubspot/callback", { body: { code, state: await start() } });
    expect(r.status).toBe(200);
    expect(r.headers.etag).toBe('"1"');
    expect(r.body).toMatchObject({ provider: "hubspot", status: "active", portalId: "4711", features: { customEvents: false }, setup: { status: "pending" }, settings: { syncInvitedGuests: true, syncOpenAttendees: false } });
    const list = await call("GET", "/v1/integrations", { as: "manager@a.test" });
    expect(list.body.items).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toMatch(/rt-|at-/);
    expect((await call("GET", "/v1/integrations", { as: "owner@b.test", account: B })).body.items).toEqual([]);
  });

  it("refuses an install that lacks a required scope, and uninstalls it again", async () => {
    const revokes = hubspot.calls.filter((c) => c === "revoke").length;
    const code = hubspot.approve("999", ["oauth"]);
    expect((await call("POST", "/v1/integrations/hubspot/callback", { as: "owner@b.test", account: B, body: { code, state: await start("owner@b.test", B) } })).status).toBe(422);
    expect(hubspot.calls.filter((c) => c === "revoke").length).toBe(revokes + 1);
  });

  it("changes who to sync with If-Match, owners only", async () => {
    expect((await call("PATCH", "/v1/integrations/hubspot", { body: { syncOpenAttendees: true } })).status).toBe(428);
    expect((await call("PATCH", "/v1/integrations/hubspot", { as: "manager@a.test", body: { syncOpenAttendees: true }, headers: { "if-match": '"1"' } })).status).toBe(403);
    const r = await call("PATCH", "/v1/integrations/hubspot", { body: { syncOpenAttendees: true }, headers: { "if-match": '"1"' } });
    expect(r).toMatchObject({ status: 200, body: { settings: { syncOpenAttendees: true }, version: 2 } });
    expect((await call("PATCH", "/v1/integrations/hubspot", { body: { syncOpenAttendees: false }, headers: { "if-match": '"1"' } })).status).toBe(412);
  });

  it("repairs setup on request, and disconnects, revoking our token at HubSpot", async () => {
    expect((await call("POST", "/v1/integrations/hubspot/setup")).status).toBe(202);
    const revokes = hubspot.calls.filter((c) => c === "revoke").length;
    expect((await call("DELETE", "/v1/integrations/hubspot", { as: "manager@a.test" })).status).toBe(403);
    expect((await call("DELETE", "/v1/integrations/hubspot")).status).toBe(204);
    expect(hubspot.calls.filter((c) => c === "revoke").length).toBe(revokes + 1);
    expect((await call("GET", "/v1/integrations")).body.items[0]).toMatchObject({ status: "disconnected", portalId: "4711" });
    expect((await call("DELETE", "/v1/integrations/hubspot")).status).toBe(404);
    expect((await call("POST", "/v1/integrations/hubspot/setup")).status).toBe(404);
  });
});
