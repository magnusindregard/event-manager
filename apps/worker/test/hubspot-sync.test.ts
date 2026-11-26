import pg from "pg";
import { runOnce } from "graphile-worker";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { type ActorContext, catalog, integrations, registration, tenancy } from "@event-manager/domain";
import { FakeHubSpot, HubSpotError, REQUIRED_SCOPES } from "@event-manager/hubspot";
import { defaultHandlers } from "../src/handlers.js";
import { FakeDirectory } from "../src/identity/directory.js";
import { FakeMailer } from "../src/identity/mailer.js";
import { buildTaskList } from "../src/tasks.js";

// HubSpot connector milestone 2 (docs/hubspot.md): contacts, marketing events and attendance,
// through the outbox and graphile-worker as in production, against a fake portal.

let tdb: TestDatabase;
let db: Db;
let admin: pg.Client;
let ctx: ActorContext;
let hubspot: FakeHubSpot;
const PORTAL = "100";
const DAY = 86_400_000;

async function drain() {
  const mailer = new FakeMailer();
  for (let i = 0; i < 6; i++) {
    await admin.query(`update graphile_worker._private_jobs set run_at = now() where locked_at is null and run_at > now()`);
    await runOnce({
      connectionString: tdb.appUrl,
      taskList: buildTaskList(db, defaultHandlers, { directory: new FakeDirectory(), mailer, adminUrl: "https://admin.test/" }, { mailer, attendeeUrl: "https://attend.test/" }, { client: hubspot }),
    });
  }
}

const run = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db, ctx, fn);
const portal = () => hubspot.portals.get(PORTAL)!;
const items = (kind: string) =>
  run((tx) => tx.selectFrom("integrations.sync_item").select(["local_key", "remote_id", "created_by_us", "synced_state", "dirty", "last_error"]).where("kind", "=", kind as "contact").orderBy("local_key").execute());

async function connect() {
  const t = await hubspot.exchangeCode(hubspot.approve(PORTAL, [...REQUIRED_SCOPES]));
  await run((tx) => integrations.saveConnection(tx, ctx, { provider: "hubspot", portalId: PORTAL, scopes: [...REQUIRED_SCOPES], tokens: { ...t, accessExpiresAt: t.expiresAt }, requiredScopes: REQUIRED_SCOPES }));
}

async function gala(title = "Sommerfest", accessPolicy: "invite_only" | "open" = "invite_only") {
  return run(async (tx) => {
    let e = await catalog.createEvent(tx, ctx, {
      translations: { nb: { title } }, admissionMode: "registration", registration: { accessPolicy, capacity: 100, guestAllowed: false },
    });
    e = await catalog.transitionEvent(tx, ctx, e.id, e.version, "publish");
    const occ = await catalog.createOccurrence(tx, ctx, e.id, { startUtc: new Date(Date.now() + 14 * DAY) });
    return { event: e, occ };
  });
}

async function invite(eventId: string, email: string, name?: string) {
  const inv = await run((tx) => registration.createInvitation(tx, ctx, eventId, { email, name }));
  await run((tx) => registration.requestSends(tx, ctx, eventId, { kind: "invitation" }));
  return inv;
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  admin = new pg.Client({ connectionString: tdb.superuserUrl });
  await admin.connect();
  const account = await tenancy.createAccount(db, { slug: "hs-sync", name: "MUNCH", ownerEmail: "owner@munch.test", locales: ["nb"] });
  const userId = await tenancy.login(db, { issuer: "t", subject: "o", email: "owner@munch.test", name: null });
  ctx = { tenantId: account.id, userId, clientId: null, roles: ["owner"] };
});
beforeEach(async () => {
  // Every test starts disconnected, with an empty portal and no events from earlier tests.
  await admin.query(`update catalog.event set status = 'archived' where status <> 'archived'`);
  const c = await run((tx) => integrations.getConnection(tx, ctx, "hubspot"));
  if (c && c.status !== "disconnected") await run((tx) => integrations.disconnect(tx, ctx, "hubspot"));
  hubspot = new FakeHubSpot();
  await drain();
});
afterAll(async () => {
  await db?.destroy();
  await admin?.end();
  await tdb?.stop();
});

describe("backfill after connecting", () => {
  it("brings published events, invited guests and attendance into the portal, and records who created each contact", async () => {
    const { event, occ } = await gala("Backfill");
    await invite(event.id, "kari@example.com", "Kari Nordmann");
    const ola = await invite(event.id, "ola@example.com", "Ola");
    await drain();
    await run((tx) => registration.acceptInvitation(tx, ctx.tenantId, ola.id, { occurrenceId: occ.id }));
    await drain();
    // Ola is already in the client's portal, with a name of their own.
    hubspot.approve(PORTAL, [...REQUIRED_SCOPES]);
    portal().contacts.set("ola@example.com", { id: "77", email: "ola@example.com", firstname: "Ole", lastname: null });

    await connect();
    await drain();

    expect(portal().events.get(occ.id)).toMatchObject({ externalAccountId: ctx.tenantId, eventName: "Backfill", eventOrganizer: "MUNCH", eventCancelled: false });
    expect(portal().contacts.get("kari@example.com")).toMatchObject({ firstname: "Kari", lastname: "Nordmann" });
    // The client's name for Ola stays; only the empty last name would be filled, and Ola has none.
    expect(portal().contacts.get("ola@example.com")).toMatchObject({ id: "77", firstname: "Ole" });
    expect(portal().attendance).toEqual([{ externalEventId: occ.id, state: "register", email: "ola@example.com" }]);
    expect(await items("contact")).toEqual([
      expect.objectContaining({ local_key: "kari@example.com", created_by_us: true, dirty: false }),
      expect.objectContaining({ local_key: "ola@example.com", remote_id: "77", created_by_us: false, dirty: false }),
    ]);
  });
});

describe("keeping in step", () => {
  it("upserts a guest when the invitation is sent, registers and cancels attendance, and changes nothing on a replay", async () => {
    await connect();
    const { event, occ } = await gala("Vernissage");
    const inv = await invite(event.id, "anne@example.com", "Anne");
    await drain();
    expect(portal().contacts.get("anne@example.com")).toMatchObject({ firstname: "Anne" });
    expect(portal().events.get(occ.id)).toMatchObject({ eventName: "Vernissage" });

    const reg = await run((tx) => registration.acceptInvitation(tx, ctx.tenantId, inv.id, { occurrenceId: occ.id }));
    await drain();
    expect(portal().attendance).toEqual([{ externalEventId: occ.id, state: "register", email: "anne@example.com" }]);

    const calls = hubspot.calls.length;
    await drain();
    expect(hubspot.calls.slice(calls)).toEqual([]);

    await run((tx) => registration.cancelRegistration(tx, ctx.tenantId, reg.id, { kind: "staff", ctx }));
    await drain();
    expect(portal().attendance.at(-1)).toEqual({ externalEventId: occ.id, state: "cancel", email: "anne@example.com" });
    expect((await items("attendance"))[0]).toMatchObject({ synced_state: "cancelled", dirty: false });
  });

  it("collects many changes into batch calls", async () => {
    await connect();
    const { event } = await gala("Stor fest");
    await run(async (tx) => {
      for (let i = 0; i < 30; i++) await registration.createInvitation(tx, ctx, event.id, { email: `g${i}@example.com` });
      await registration.requestSends(tx, ctx, event.id, { kind: "invitation" });
    });
    await drain();
    expect(portal().contacts.size).toBe(30);
    expect(hubspot.calls.filter((c) => c.startsWith("upsertContacts:"))).toEqual(["upsertContacts:30"]);
  });

  it("marks the marketing event cancelled when the event is cancelled, and when an occurrence is deleted", async () => {
    await connect();
    const { event, occ } = await gala("Avlyst");
    await drain();
    expect(portal().events.get(occ.id)?.eventCancelled).toBe(false);
    const extra = await run((tx) => catalog.createOccurrence(tx, ctx, event.id, { startUtc: new Date(Date.now() + 21 * DAY) }));
    await drain();
    expect(portal().events.has(extra.id)).toBe(true);

    await run((tx) => catalog.deleteOccurrence(tx, ctx, extra.id, extra.version));
    await drain();
    expect(hubspot.calls).toContain(`cancelMarketingEvent:${extra.id}`);
    expect(portal().events.get(extra.id)?.eventCancelled).toBe(true);

    const current = await run((tx) => catalog.getEvent(tx, event.id));
    await run((tx) => catalog.transitionEvent(tx, ctx, event.id, current.version, "cancel"));
    await drain();
    expect(portal().events.get(occ.id)?.eventCancelled).toBe(true);
  });

  it("leaves attendees of open registration out unless the account syncs them", async () => {
    await connect();
    const { occ } = await gala("Åpent hus", "open");
    await run((tx) => registration.register(tx, ctx.tenantId, occ.id, { name: "Per", email: "per@example.com" }, { kind: "attendee" }));
    await drain();
    expect(portal().contacts.has("per@example.com")).toBe(false);
    expect(portal().attendance).toEqual([]);

    const c = (await run((tx) => integrations.getConnection(tx, ctx, "hubspot")))!;
    await run((tx) => integrations.updateSettings(tx, ctx, "hubspot", c.version, { syncOpenAttendees: true }));
    await run((tx) => registration.register(tx, ctx.tenantId, occ.id, { name: "Pål", email: "paal@example.com" }, { kind: "attendee" }));
    await drain();
    expect(portal().contacts.has("paal@example.com")).toBe(true);
    expect(portal().attendance).toEqual([{ externalEventId: occ.id, state: "register", email: "paal@example.com" }]);
  });

  it("drafts are not synced", async () => {
    await connect();
    await run(async (tx) => {
      const e = await catalog.createEvent(tx, ctx, { translations: { nb: { title: "Utkast" } }, admissionMode: "registration", registration: { accessPolicy: "invite_only", capacity: 10 } });
      await catalog.createOccurrence(tx, ctx, e.id, { startUtc: new Date(Date.now() + 7 * DAY) });
    });
    await drain();
    expect(portal().events.size).toBe(0);
  });
});

describe("the sync log", () => {
  it("shows what HubSpot refused, and pushes it on a retry once HubSpot takes it", async () => {
    await connect();
    const { event } = await gala("Avvist");
    await drain();
    const upsert = hubspot.upsertContacts.bind(hubspot);
    hubspot.upsertContacts = async () => {
      throw new HubSpotError("HubSpot POST /crm/v3/objects/contacts/batch/upsert: 400 Property values were not valid", 400);
    };
    await invite(event.id, "refused@example.com");
    await drain();

    let log = await run((tx) => integrations.syncSummary(tx, ctx, "hubspot"));
    expect(log.counts.contact).toEqual({ synced: 0, pending: 1, failed: 0 });
    expect(log.counts.marketing_event).toEqual({ synced: 1, pending: 0, failed: 0 });
    expect(log.issues).toEqual([expect.objectContaining({ kind: "contact", label: "refused@example.com", attempts: 1, givenUp: false, lastError: expect.stringContaining("400 Property values were not valid") })]);

    hubspot.upsertContacts = upsert;
    expect(await run((tx) => integrations.retryFailed(tx, ctx, "hubspot"))).toBe(1);
    await drain();
    log = await run((tx) => integrations.syncSummary(tx, ctx, "hubspot"));
    expect(log.counts.contact).toEqual({ synced: 1, pending: 0, failed: 0 });
    expect(log.issues).toEqual([]);
    expect(portal().contacts.has("refused@example.com")).toBe(true);
  });

  it("resync pushes everything again, for a portal where someone deleted what we wrote", async () => {
    await connect();
    const { event, occ } = await gala("Slettet");
    await invite(event.id, "deleted@example.com");
    await drain();
    portal().contacts.clear();
    portal().events.clear();

    await run((tx) => integrations.requestResync(tx, ctx, "hubspot"));
    await drain();
    expect(portal().contacts.has("deleted@example.com")).toBe(true);
    expect(portal().events.has(occ.id)).toBe(true);
    // Who created the contact is what the first sync recorded.
    expect((await items("contact"))[0]).toMatchObject({ local_key: "deleted@example.com", created_by_us: true });
  });
});

describe("when the connection goes away", () => {
  it("drops the mappings on disconnect, and pushes waiting changes once a paused connection is reconnected", async () => {
    await connect();
    const { event } = await gala("Pause");
    await drain();
    expect((await items("marketing_event")).length).toBe(1);

    // HubSpot refuses our access: changes wait.
    hubspot.uninstall(PORTAL);
    hubspot.expireAccessTokens(PORTAL);
    await invite(event.id, "waiting@example.com");
    await drain();
    expect((await run((tx) => integrations.getConnection(tx, ctx, "hubspot")))?.status).toBe("needs_reconnect");
    expect(await items("contact")).toEqual([expect.objectContaining({ local_key: "waiting@example.com", dirty: true })]);

    await connect();
    await drain();
    expect(portal().contacts.has("waiting@example.com")).toBe(true);

    await run((tx) => integrations.disconnect(tx, ctx, "hubspot"));
    expect(await items("contact")).toEqual([]);
    expect(await items("marketing_event")).toEqual([]);
  });
});
