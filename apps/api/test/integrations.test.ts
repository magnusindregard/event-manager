import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, sql } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { tenancy } from "@event-manager/domain";
import { CLEANUP_SCOPES, FakeHubSpot, OPTIONAL_SCOPES, REQUIRED_SCOPES, signState } from "@event-manager/hubspot";
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

  it("shows the sync log to everyone, and lets owners retry refused items and resync", async () => {
    const empty = await call("GET", "/v1/integrations/hubspot/sync", { as: "manager@a.test" });
    expect(empty).toMatchObject({ status: 200, body: { counts: { contact: { synced: 0, pending: 0, failed: 0 } }, lastSyncedAt: null, issues: [] } });

    // An item HubSpot refused five times (the worker would have recorded this).
    const conn = (await call("GET", "/v1/integrations")).body.items[0];
    const su = createDb(tdb.superuserUrl, { max: 1 });
    await sql`insert into integrations.sync_item (tenant_id, connection_id, kind, local_key, data, dirty, attempts, last_error)
      values (${A}, ${conn.id}, 'contact', 'bad@example', '{"email":"bad@example"}', true, 5, 'Property values were not valid: email')`.execute(su);
    await su.destroy();

    const log = await call("GET", "/v1/integrations/hubspot/sync");
    expect(log.body.counts.contact).toEqual({ synced: 0, pending: 0, failed: 1 });
    expect(log.body.issues).toEqual([expect.objectContaining({ kind: "contact", label: "bad@example", givenUp: true, lastError: "Property values were not valid: email" })]);

    expect((await call("POST", "/v1/integrations/hubspot/sync/retry", { as: "manager@a.test" })).status).toBe(403);
    expect(await call("POST", "/v1/integrations/hubspot/sync/retry")).toMatchObject({ status: 202, body: { retried: 1 } });
    expect((await call("GET", "/v1/integrations/hubspot/sync")).body.counts.contact).toEqual({ synced: 0, pending: 1, failed: 0 });

    expect((await call("POST", "/v1/integrations/hubspot/resync", { as: "manager@a.test" })).status).toBe(403);
    expect((await call("POST", "/v1/integrations/hubspot/resync")).status).toBe(202);
    expect((await call("GET", "/v1/integrations/hubspot/sync", { as: "owner@b.test", account: B })).status).toBe(404);
  });

  it("shows the cleanup, takes its settings, and queues Clean up and disconnect for owners", async () => {
    const c = (await call("GET", "/v1/integrations")).body.items[0];
    // Connected with the required scopes only: the cleanup scopes are missing and nothing is set up.
    expect(c.cleanup).toEqual({ missingScopes: [...CLEANUP_SCOPES], subscriptionTypes: [], workflowEnabled: null, nonMarketingWaiting: null, disconnectRequestedAt: null });
    expect(c.settings).toMatchObject({ eventSubscriptionTypeId: null, cleanupGraceDays: 7, deleteMirroredContacts: true });
    const etag = { "if-match": `"${c.version}"` };
    expect((await call("PATCH", "/v1/integrations/hubspot", { body: { cleanupGraceDays: 91 }, headers: etag })).status).toBe(400);
    expect((await call("PATCH", "/v1/integrations/hubspot", { body: { eventSubscriptionTypeId: "123" }, headers: etag })).status).toBe(422);
    const r = await call("PATCH", "/v1/integrations/hubspot", { body: { cleanupGraceDays: 14, deleteMirroredContacts: false }, headers: etag });
    expect(r).toMatchObject({ status: 200, body: { settings: { cleanupGraceDays: 14, deleteMirroredContacts: false } } });
    expect((await call("GET", "/v1/integrations/hubspot/sync")).body.cleanup).toEqual({ pending: 0, kept: 0, failed: 0, last: null });

    expect((await call("POST", "/v1/integrations/hubspot/cleanup-and-disconnect", { as: "manager@a.test" })).status).toBe(403);
    const q = await call("POST", "/v1/integrations/hubspot/cleanup-and-disconnect");
    expect(q.status).toBe(202);
    expect(q.body.cleanup.disconnectRequestedAt).not.toBeNull();
    // The worker does the rest; here the connection stays until it has.
    expect(q.body.status).toBe("active");
  });

  it("offers HubSpot sending for an event only when the account is ready for it, and takes the event's choice with If-Match", async () => {
    const ev = await call("POST", "/v1/events", { body: { translations: { nb: { title: "Gallamiddag" } }, admissionMode: "registration" } });
    expect(ev.status).toBe(201);
    const url = `/v1/events/${ev.body.id}/sending`;
    const first = await call("GET", url, { as: "manager@a.test" });
    expect(first).toMatchObject({ status: 200, body: { channel: "platform", version: 0, locked: false, emails: [], texts: { invitation: { subject: "Invitasjon: Gallamiddag" } } } });
    expect(first.headers.etag).toBe('"0"');
    // Without the cleanup scopes, HubSpot cannot be chosen.
    expect(first.body.hubspotBlocker).toMatch(/cleanup scopes/);
    expect((await call("PATCH", url, { body: { channel: "hubspot" }, headers: { "if-match": '"0"' } })).status).toBe(409);

    // The worker's setup found everything (as it would with the cleanup scopes and a single-send email).
    const su = createDb(tdb.superuserUrl, { max: 1 });
    const setup = { portalId: "4711", temporaryListId: "1", nonMarketingListId: "2", workflowId: "3", workflowEnabled: true, subscriptionTypes: [{ id: "11", name: "Arrangementer", active: true }],
      singleSendEmails: [{ id: "900", name: "Invitasjon (mal)", subscriptionId: "11", hasInvitationLink: true, hasManageLink: false }] };
    await sql`update integrations.connection set scopes = ${[...REQUIRED_SCOPES, ...CLEANUP_SCOPES]}::text[], portal_setup = ${JSON.stringify(setup)}::jsonb where tenant_id = ${A}`.execute(su);
    await su.destroy();
    let c = (await call("GET", "/v1/integrations")).body.items[0];
    expect(c.sending).toMatchObject({ blocker: expect.stringMatching(/subscription type/), templates: [expect.objectContaining({ id: "900" })] });
    c = (await call("PATCH", "/v1/integrations/hubspot", { body: { eventSubscriptionTypeId: "11" }, headers: { "if-match": `"${c.version}"` } })).body;
    expect((await call("PATCH", "/v1/integrations/hubspot", { body: { invitationTemplateId: "901" }, headers: { "if-match": `"${c.version}"` } })).status).toBe(422);
    c = (await call("PATCH", "/v1/integrations/hubspot", { body: { invitationTemplateId: "900" }, headers: { "if-match": `"${c.version}"` } })).body;
    expect(c).toMatchObject({ features: { sending: true }, sending: { blocker: null }, settings: { invitationTemplateId: "900" } });

    expect((await call("PATCH", url, { body: { channel: "hubspot" } })).status).toBe(428);
    const r = await call("PATCH", url, { as: "manager@a.test", body: { channel: "hubspot", texts: { invitation: { subject: "Velkommen", previewText: "Lørdag" } } }, headers: { "if-match": '"0"' } });
    expect(r).toMatchObject({ status: 200, body: { channel: "hubspot", version: 1, effectiveTemplates: { invitation: "900" }, texts: { invitation: { subject: "Velkommen", previewText: "Lørdag" } }, customTexts: ["invitation"] } });
    expect(r.headers.etag).toBe('"1"');
    expect((await call("PATCH", url, { body: { templates: { reminder: "901" } }, headers: { "if-match": '"1"' } })).status).toBe(422);
    expect((await call("PATCH", url, { body: { channel: "platform" }, headers: { "if-match": '"0"' } })).status).toBe(412);
    expect((await call("POST", `${url}/check`, { as: "manager@a.test" })).status).toBe(202);
    expect((await call("GET", url, { as: "owner@b.test", account: B })).status).toBe(404);
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
    expect((await call("GET", "/v1/integrations/hubspot/sync")).status).toBe(404);
  });
});
