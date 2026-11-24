import pg from "pg";
import { runOnce } from "graphile-worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { type ActorContext, integrations, tenancy } from "@event-manager/domain";
import { FakeHubSpot, HubSpotError, REQUIRED_SCOPES } from "@event-manager/hubspot";
import { defaultHandlers } from "../src/handlers.js";
import { buildTaskList } from "../src/tasks.js";

// HubSpot connector milestone 1 (docs/hubspot.md): the setup job in the portal, token refresh,
// and pausing when HubSpot refuses our access.

let tdb: TestDatabase;
let db: Db;
let admin: pg.Client;
let ctx: ActorContext;
let hubspot: FakeHubSpot;

async function drain() {
  for (let i = 0; i < 3; i++) {
    await admin.query(`update graphile_worker._private_jobs set run_at = now() where locked_at is null`);
    await runOnce({ connectionString: tdb.appUrl, taskList: buildTaskList(db, defaultHandlers, undefined, undefined, { client: hubspot }) });
  }
}

/** What the API does after the owner approves the install in HubSpot. */
async function connect(portalId: string) {
  const t = await hubspot.exchangeCode(hubspot.approve(portalId, [...REQUIRED_SCOPES]));
  return withTenant(db, ctx, (tx) =>
    integrations.saveConnection(tx, ctx, { provider: "hubspot", portalId, scopes: [...REQUIRED_SCOPES], tokens: { ...t, accessExpiresAt: t.expiresAt }, requiredScopes: REQUIRED_SCOPES }),
  );
}
const connection = () => withTenant(db, ctx, (tx) => integrations.getConnection(tx, ctx, "hubspot"));
const failedJobs = async () => (await admin.query(`select count(*)::int as n from graphile_worker._private_jobs where task_id = (select id from graphile_worker._private_tasks where identifier = 'hubspot.setup')`)).rows[0].n as number;

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  admin = new pg.Client({ connectionString: tdb.superuserUrl });
  await admin.connect();
  const account = await tenancy.createAccount(db, { slug: "hs-worker", name: "HS", ownerEmail: "owner@hs.test" });
  const userId = await tenancy.login(db, { issuer: "t", subject: "o", email: "owner@hs.test", name: null });
  ctx = { tenantId: account.id, userId, clientId: null, roles: ["owner"] };
  hubspot = new FakeHubSpot();
});
afterAll(async () => {
  await db?.destroy();
  await admin?.end();
  await tdb?.stop();
});

describe("HubSpot setup", () => {
  it("checks that the token reaches the connected portal once connected", async () => {
    await connect("100");
    const calls = hubspot.calls.length;
    await drain();
    expect(hubspot.calls.slice(calls)).toEqual(["accountDetails"]);
    expect((await connection())?.setup).toMatchObject({ status: "done", error: null });
  });

  it("repairs on request, and refreshes a token about to expire first", async () => {
    await admin.query("update integrations.credential set access_expires_at = now() + interval '1 minute'");
    const before = (await withTenant(db, ctx, (tx) => integrations.loadForSync(tx, ctx.tenantId, "hubspot")))!.tokens.accessToken;
    await withTenant(db, ctx, (tx) => integrations.requestSetup(tx, ctx, "hubspot"));
    expect((await connection())?.setup.status).toBe("pending");
    const calls = hubspot.calls.length;
    await drain();
    expect(hubspot.calls.slice(calls)).toEqual(["refresh", "accountDetails"]);
    expect((await withTenant(db, ctx, (tx) => integrations.loadForSync(tx, ctx.tenantId, "hubspot")))!.tokens.accessToken).not.toBe(before);
    expect((await connection())?.setup.status).toBe("done");
  });

  it("refreshes once and tries again when HubSpot refuses a token we thought was valid", async () => {
    hubspot.expireAccessTokens("100");
    await withTenant(db, ctx, (tx) => integrations.requestSetup(tx, ctx, "hubspot"));
    const calls = hubspot.calls.length;
    await drain();
    expect(hubspot.calls.slice(calls)).toEqual(["accountDetails", "refresh", "accountDetails"]);
    expect(await connection()).toMatchObject({ status: "active", setup: { status: "done" } });
  });

  it("records a refusal on the connection without retrying it", async () => {
    const original = hubspot.accountDetails.bind(hubspot);
    hubspot.accountDetails = async () => {
      throw new HubSpotError("HubSpot GET /account-info/v3/details: 400 bad request", 400);
    };
    try {
      await withTenant(db, ctx, (tx) => integrations.requestSetup(tx, ctx, "hubspot"));
      await drain();
    } finally {
      hubspot.accountDetails = original;
    }
    expect((await connection())?.setup).toMatchObject({ status: "failed", error: expect.stringContaining("400 bad request") });
    expect(await failedJobs()).toBe(0);
  });

  it("pauses the connection when the portal uninstalled the app", async () => {
    hubspot.uninstall("100");
    hubspot.expireAccessTokens("100");
    await withTenant(db, ctx, (tx) => integrations.requestSetup(tx, ctx, "hubspot"));
    await drain();
    expect(await connection()).toMatchObject({ status: "needs_reconnect", statusReason: expect.stringContaining("BAD_REFRESH_TOKEN") });
    expect(await failedJobs()).toBe(0);

    // Reconnecting the portal sets it up again.
    await connect("100");
    await drain();
    expect(await connection()).toMatchObject({ status: "active", setup: { status: "done" } });
  });

  it("a refresh that finishes after a disconnect and reconnect to another portal leaves the new one alone (review on #113)", async () => {
    await admin.query("update integrations.credential set access_expires_at = now() + interval '1 minute'");
    // The refresh for portal 100 succeeds at HubSpot, then stalls before it is stored.
    let entered!: () => void;
    let release!: () => void;
    const inRefresh = new Promise<void>((r) => (entered = r));
    const gate = new Promise<void>((r) => (release = r));
    const original = hubspot.refresh.bind(hubspot);
    hubspot.refresh = async (token) => {
      hubspot.refresh = original;
      const fresh = await original(token);
      entered();
      await gate;
      return fresh;
    };
    await withTenant(db, ctx, (tx) => integrations.requestSetup(tx, ctx, "hubspot"));
    const running = drain();
    await inRefresh;

    // Meanwhile the owner disconnects (revoking at HubSpot, as the API does) and connects portal 200.
    const { refreshToken } = await withTenant(db, ctx, (tx) => integrations.disconnect(tx, ctx, "hubspot"));
    await hubspot.revoke(refreshToken!);
    await connect("200");
    release();
    await running;
    await drain();

    const now = (await withTenant(db, ctx, (tx) => integrations.loadForSync(tx, ctx.tenantId, "hubspot")))!;
    expect(now.connection).toMatchObject({ portalId: "200", status: "active", setup: { status: "done" } });
    // The stored tokens are portal 200's: they work there, and a refresh with them works too.
    await expect(hubspot.tokenInfo(now.tokens.accessToken)).resolves.toMatchObject({ portalId: "200" });
    await expect(hubspot.refresh(now.tokens.refreshToken)).resolves.toBeTruthy();
    expect(await failedJobs()).toBe(0);
  });
});
