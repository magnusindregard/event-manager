import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, type Tx, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { type ActorContext, DomainError, integrations, tenancy } from "../../src/index.js";

// HubSpot connector milestone 1 (docs/hubspot.md): a connection per account, its tokens
// encrypted with the account's data key, reconnect and disconnect rules.

let tdb: TestDatabase;
let db: Db;
let su: pg.Client;
let ctx: ActorContext;
let other: ActorContext;

const as = (roles: string[]): ActorContext => ({ ...ctx, roles });
const run = <T>(fn: (tx: Tx) => Promise<T>, c: ActorContext = ctx) => withTenant(db, c, fn);
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof DomainError ? e.code : String(e)));
const REQUIRED = ["oauth", "crm.objects.contacts.write"];
const tokens = (n: number): integrations.Tokens => ({ accessToken: `at-${n}`, refreshToken: `rt-${n}`, accessExpiresAt: new Date(Date.now() + 1800_000) });
const connect = (portalId: string, n = 1, c: ActorContext = ctx, scopes = REQUIRED) =>
  run((tx) => integrations.saveConnection(tx, c, { provider: "hubspot", portalId, scopes, tokens: tokens(n), requiredScopes: REQUIRED }), c);
const events = async (type: string) =>
  (await su.query<{ data: Record<string, unknown> }>("select data from outbox.event where type = $1 and tenant_id = $2 order by created_at", [type, ctx.tenantId])).rows.map((r) => r.data);

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl, { max: 5 });
  su = new pg.Client({ connectionString: tdb.superuserUrl });
  await su.connect();
  const a = await tenancy.createAccount(db, { slug: "hs", name: "HS", ownerEmail: "owner@hs.test" });
  const userId = await tenancy.login(db, { issuer: "https://idp.test", subject: "owner@hs.test", email: "owner@hs.test", name: null });
  ctx = { tenantId: a.id, userId, clientId: null, roles: ["owner"] };
  const b = await tenancy.createAccount(db, { slug: "hs-other", name: "Other", ownerEmail: "owner@other.test" });
  other = { tenantId: b.id, userId: null, clientId: null, roles: ["owner"] };
});
afterAll(async () => {
  await db?.destroy();
  await su?.end();
  await tdb?.stop();
});

describe("integrations", () => {
  it("connects an account to a portal, owner only, and refuses an install without the required scopes", async () => {
    expect(await code(connect("111", 1, as(["event_manager"])))).toBe("forbidden");
    expect(await code(connect("111", 1, ctx, ["oauth"]))).toBe("validation_failed");

    const c = await connect("111");
    expect(c).toMatchObject({ provider: "hubspot", status: "active", portalId: "111", scopes: ["crm.objects.contacts.write", "oauth"], setup: { status: "pending" }, connectedBy: ctx.userId, version: 1 });
    expect(c.settings).toEqual({ syncInvitedGuests: true, syncOpenAttendees: false, eventSubscriptionTypeId: null, cleanupGraceDays: 7, deleteMirroredContacts: true });
    expect(await events("integration.connected.v1")).toEqual([{ connectionId: c.id, provider: "hubspot", portalId: "111" }]);
    // Members read it; another account sees nothing.
    expect(await run((tx) => integrations.listConnections(tx, as(["editor"])))).toHaveLength(1);
    expect(await run((tx) => integrations.listConnections(tx, other), other)).toEqual([]);
  });

  it("keeps the tokens encrypted and bound to the connection", async () => {
    const raw = await su.query<{ ciphertext: Buffer }>("select ciphertext from integrations.credential");
    expect(raw.rows).toHaveLength(1);
    expect(raw.rows[0]!.ciphertext.toString("latin1")).not.toContain("rt-1");
    const loaded = await run((tx) => integrations.loadForSync(tx, ctx.tenantId, "hubspot"));
    expect(loaded?.tokens).toMatchObject({ accessToken: "at-1", refreshToken: "rt-1" });

    await run((tx) => integrations.storeRefreshedTokens(tx, ctx.tenantId, loaded!.connection, tokens(2)));
    expect((await run((tx) => integrations.loadForSync(tx, ctx.tenantId, "hubspot")))?.tokens.accessToken).toBe("at-2");
  });

  it("records setup, and pauses on a refused token until the owner reconnects the same portal", async () => {
    const { connection } = (await run((tx) => integrations.loadForSync(tx, ctx.tenantId, "hubspot")))!;
    await run((tx) => integrations.recordSetup(tx, connection, { ok: false, error: "boom" }));
    expect((await run((tx) => integrations.getConnection(tx, ctx, "hubspot")))?.setup).toMatchObject({ status: "failed", error: "boom" });

    await run((tx) => integrations.markNeedsReconnect(tx, ctx.tenantId, connection, "401 expired"));
    expect(await run((tx) => integrations.getConnection(tx, ctx, "hubspot"))).toMatchObject({ status: "needs_reconnect", statusReason: "401 expired" });
    expect(await run((tx) => integrations.loadForSync(tx, ctx.tenantId, "hubspot"))).toBeNull();
    expect(await code(run((tx) => integrations.requestSetup(tx, ctx, "hubspot")))).toBe("conflict");
    // Refreshed tokens from a job that was running are dropped.
    expect(await run((tx) => integrations.storeRefreshedTokens(tx, ctx.tenantId, connection, tokens(9)))).toBe(false);

    // Another portal is refused while connected; the same one reconnects in place.
    expect(await code(connect("222", 3))).toBe("conflict");
    const back = await connect("111", 3);
    expect(back).toMatchObject({ id: connection.id, status: "active", statusReason: null, setup: { status: "pending", error: null } });
    expect((await run((tx) => integrations.loadForSync(tx, ctx.tenantId, "hubspot")))?.tokens.refreshToken).toBe("rt-3");
  });

  it("changes settings with the version it was read at", async () => {
    const c = (await run((tx) => integrations.getConnection(tx, ctx, "hubspot")))!;
    expect(await code(run((tx) => integrations.updateSettings(tx, ctx, "hubspot", c.version - 1, { syncOpenAttendees: true })))).toBe("version_conflict");
    expect(await code(run((tx) => integrations.updateSettings(tx, as(["event_manager"]), "hubspot", c.version, { syncOpenAttendees: true })))).toBe("forbidden");
    const after = await run((tx) => integrations.updateSettings(tx, ctx, "hubspot", c.version, { syncOpenAttendees: true }));
    expect(after).toMatchObject({ settings: { syncInvitedGuests: true, syncOpenAttendees: true }, version: c.version + 1 });
  });

  it("disconnects: tokens deleted, the row kept, and then another portal can be connected", async () => {
    expect(await run((tx) => integrations.disconnect(tx, ctx, "hubspot"))).toEqual({ refreshToken: "rt-3" });
    expect((await su.query("select 1 from integrations.credential")).rowCount).toBe(0);
    expect(await run((tx) => integrations.getConnection(tx, ctx, "hubspot"))).toMatchObject({ status: "disconnected", portalId: "111" });
    expect(await code(run((tx) => integrations.disconnect(tx, ctx, "hubspot")))).toBe("not_found");
    expect(await events("integration.disconnected.v1")).toHaveLength(1);

    expect(await connect("222", 4)).toMatchObject({ status: "active", portalId: "222", disconnectedAt: null });
    const audit = await su.query<{ action: string }>("select action from tenancy.audit_log where tenant_id = $1 and action like 'integration.%' order by at, id", [ctx.tenantId]);
    expect(audit.rows.map((r) => r.action)).toEqual(["integration.connected", "integration.connected", "integration.updated", "integration.disconnected", "integration.connected"]);
  });

  it("drops what a job loaded before a disconnect and reconnect would write back (review on #113)", async () => {
    // A refresh starts for portal 222 …
    const stale = (await run((tx) => integrations.loadForSync(tx, ctx.tenantId, "hubspot")))!.connection;
    expect(stale.portalId).toBe("222");
    // … meanwhile the owner disconnects and connects portal 333, which reuses the row.
    await run((tx) => integrations.disconnect(tx, ctx, "hubspot"));
    const now = await connect("333", 5);
    expect(now.id).toBe(stale.id);
    expect(now.generation).toBeGreaterThan(stale.generation);

    // The refresh for 222 finishes: none of its results reach 333.
    expect(await run((tx) => integrations.storeRefreshedTokens(tx, ctx.tenantId, stale, tokens(6)))).toBe(false);
    await run((tx) => integrations.markNeedsReconnect(tx, ctx.tenantId, stale, "400 BAD_REFRESH_TOKEN"));
    await run((tx) => integrations.recordSetup(tx, stale, { ok: true }));
    const after = (await run((tx) => integrations.loadForSync(tx, ctx.tenantId, "hubspot")))!;
    expect(after.connection).toMatchObject({ portalId: "333", status: "active", setup: { status: "pending" } });
    expect(after.tokens).toMatchObject({ accessToken: "at-5", refreshToken: "rt-5" });

    // The current generation still writes.
    expect(await run((tx) => integrations.storeRefreshedTokens(tx, ctx.tenantId, after.connection, tokens(7)))).toBe(true);
  });
});
