import pg from "pg";
import { runOnce } from "graphile-worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { type ActorContext, integrations, tenancy } from "@event-manager/domain";
import { FakeHubSpot, GUEST_KEY_PROPERTY, HubSpotError, PROPERTY_GROUP, REQUIRED_SCOPES } from "@event-manager/hubspot";
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
  it("creates the property group and the guest key property once connected", async () => {
    await connect("100");
    await drain();
    const portal = hubspot.portals.get("100")!;
    expect(portal.groups.get(PROPERTY_GROUP.name)).toBe("Event manager");
    expect(portal.properties.get(GUEST_KEY_PROPERTY.name)).toMatchObject({ groupName: PROPERTY_GROUP.name });
    expect((await connection())?.setup).toMatchObject({ status: "done", error: null });
  });

  it("repairs on request, leaving what exists, and refreshes a token about to expire first", async () => {
    await admin.query("update integrations.credential set access_expires_at = now() + interval '1 minute'");
    const before = (await withTenant(db, ctx, (tx) => integrations.loadForSync(tx, ctx.tenantId, "hubspot")))!.tokens.accessToken;
    await withTenant(db, ctx, (tx) => integrations.requestSetup(tx, ctx, "hubspot"));
    expect((await connection())?.setup.status).toBe("pending");
    const calls = hubspot.calls.length;
    await drain();
    expect(hubspot.calls.slice(calls)).toEqual(["refresh", "ensureContactPropertyGroup:event_manager", "ensureContactProperty:em_guest_key"]);
    expect((await withTenant(db, ctx, (tx) => integrations.loadForSync(tx, ctx.tenantId, "hubspot")))!.tokens.accessToken).not.toBe(before);
    expect((await connection())?.setup.status).toBe("done");
  });

  it("refreshes once and tries again when HubSpot refuses a token we thought was valid", async () => {
    hubspot.expireAccessTokens("100");
    await withTenant(db, ctx, (tx) => integrations.requestSetup(tx, ctx, "hubspot"));
    const calls = hubspot.calls.length;
    await drain();
    expect(hubspot.calls.slice(calls)).toEqual(["ensureContactPropertyGroup:event_manager", "refresh", "ensureContactPropertyGroup:event_manager", "ensureContactProperty:em_guest_key"]);
    expect(await connection()).toMatchObject({ status: "active", setup: { status: "done" } });
  });

  it("records a refusal on the connection without retrying it", async () => {
    const original = hubspot.ensureContactProperty.bind(hubspot);
    hubspot.ensureContactProperty = async () => {
      throw new HubSpotError("HubSpot POST /crm/v3/properties/contacts: 400 bad name", 400);
    };
    try {
      await withTenant(db, ctx, (tx) => integrations.requestSetup(tx, ctx, "hubspot"));
      await drain();
    } finally {
      hubspot.ensureContactProperty = original;
    }
    expect((await connection())?.setup).toMatchObject({ status: "failed", error: expect.stringContaining("400 bad name") });
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
});
