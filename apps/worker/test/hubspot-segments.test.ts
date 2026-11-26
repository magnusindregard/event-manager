import pg from "pg";
import { runOnce } from "graphile-worker";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { type ActorContext, catalog, integrations, registration, tenancy } from "@event-manager/domain";
import { FakeHubSpot, HubSpotError, REQUIRED_SCOPES } from "@event-manager/hubspot";
import { defaultHandlers } from "../src/handlers.js";
import { reconcileSegments } from "../src/hubspot/reconcile.js";
import { FakeDirectory } from "../src/identity/directory.js";
import { FakeMailer } from "../src/identity/mailer.js";
import { buildTaskList } from "../src/tasks.js";

// HubSpot connector milestone 3 (docs/hubspot.md, "Segments"): per-event static segments kept in
// step through the outbox, and the nightly reconcile, against a fake portal.

let tdb: TestDatabase;
let db: Db;
let admin: pg.Client;
let ctx: ActorContext;
let hubspot: FakeHubSpot;
const PORTAL = "200";

async function drain() {
  const mailer = new FakeMailer();
  for (let i = 0; i < 8; i++) {
    await admin.query(`update graphile_worker._private_jobs set run_at = now() where locked_at is null and run_at > now()`);
    await runOnce({
      connectionString: tdb.appUrl,
      taskList: buildTaskList(db, defaultHandlers, { directory: new FakeDirectory(), mailer, adminUrl: "https://admin.test/" }, { mailer, attendeeUrl: "https://attend.test/" }, { client: hubspot }),
    });
  }
}

const run = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db, ctx, fn);
const portal = () => hubspot.portals.get(PORTAL)!;
const listNamed = (name: string) => [...portal().lists.values()].find((l) => l.name === name);
/** The emails in a segment, by name. */
const members = (name: string) => {
  const l = listNamed(name);
  if (!l) return null;
  const byId = new Map([...portal().contacts.values()].map((c) => [c.id, c.email.toLowerCase()]));
  return [...l.members].map((id) => byId.get(id) ?? `?${id}`).sort();
};

async function connect() {
  const t = await hubspot.exchangeCode(hubspot.approve(PORTAL, [...REQUIRED_SCOPES]));
  await run((tx) => integrations.saveConnection(tx, ctx, { provider: "hubspot", portalId: PORTAL, scopes: [...REQUIRED_SCOPES], tokens: { ...t, accessExpiresAt: t.expiresAt }, requiredScopes: REQUIRED_SCOPES }));
}

// 1 December 2027 18:00 in Oslo.
const START = new Date("2027-12-01T17:00:00Z");

async function gala(title: string, accessPolicy: "invite_only" | "open" = "invite_only") {
  return run(async (tx) => {
    let e = await catalog.createEvent(tx, ctx, {
      translations: { nb: { title } }, admissionMode: "registration", registration: { accessPolicy, capacity: 100, guestAllowed: false },
    });
    e = await catalog.transitionEvent(tx, ctx, e.id, e.version, "publish");
    const occ = await catalog.createOccurrence(tx, ctx, e.id, { startUtc: START });
    return { event: e, occ };
  });
}

async function invite(eventId: string, ...emails: string[]) {
  const invs = await run(async (tx) => {
    const out = [];
    for (const email of emails) out.push(await registration.createInvitation(tx, ctx, eventId, { email, name: email.split("@")[0] }));
    return out;
  });
  await run((tx) => registration.requestSends(tx, ctx, eventId, { kind: "invitation" }));
  return invs;
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  admin = new pg.Client({ connectionString: tdb.superuserUrl });
  await admin.connect();
  const account = await tenancy.createAccount(db, { slug: "hs-seg", name: "MUNCH", ownerEmail: "owner@munch.test", locales: ["nb"] });
  const userId = await tenancy.login(db, { issuer: "t", subject: "o", email: "owner@munch.test", name: null });
  ctx = { tenantId: account.id, userId, clientId: null, roles: ["owner"] };
});
beforeEach(async () => {
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

describe("segments kept in step", () => {
  it("moves guests from Awaiting reply to Confirmed and back out, in batch calls", async () => {
    await connect();
    const { event, occ } = await gala("Vernissage");
    const [kari, ola] = await invite(event.id, "kari@example.com", "ola@example.com", "per@example.com");
    await drain();
    const awaiting = "EM · Vernissage · Awaiting reply";
    const confirmed = "EM · Vernissage · Confirmed · 2027-12-01 18:00";
    expect(members(awaiting)).toEqual(["kari@example.com", "ola@example.com", "per@example.com"]);
    expect(hubspot.calls.filter((c) => c.startsWith("addToList:"))).toEqual([expect.stringMatching(/:3$/)]);
    expect(listNamed(awaiting)?.processingType).toBe("MANUAL");

    const reg = await run((tx) => registration.acceptInvitation(tx, ctx.tenantId, kari!.id, { occurrenceId: occ.id }));
    await run((tx) => registration.declineInvitation(tx, ctx.tenantId, ola!.id));
    await drain();
    expect(members(awaiting)).toEqual(["per@example.com"]);
    expect(members(confirmed)).toEqual(["kari@example.com"]);

    // Nothing changed: no calls.
    const calls = hubspot.calls.length;
    await drain();
    expect(hubspot.calls.slice(calls)).toEqual([]);

    // Kari cancels, which is a no: out of Confirmed, and not back in Awaiting reply.
    await run((tx) => registration.cancelRegistration(tx, ctx.tenantId, reg.id, { kind: "staff", ctx }));
    await drain();
    expect(members(confirmed)).toEqual([]);
    expect(members(awaiting)).toEqual(["per@example.com"]);
  });

  it("gives two events with the same title segments of their own", async () => {
    await connect();
    const a = await gala("Julebord");
    const b = await gala("Julebord");
    await invite(a.event.id, "a@example.com");
    await drain();
    await invite(b.event.id, "b@example.com");
    await drain();
    expect(members("EM · Julebord · Awaiting reply")).toEqual(["a@example.com"]);
    expect(members("EM · Julebord · Awaiting reply (2)")).toEqual(["b@example.com"]);
  });

  it("brings an event's segments in on backfill, and deletes them when the event is archived", async () => {
    const { event } = await gala("Arkiv");
    await invite(event.id, "kari@example.com");
    await drain();
    hubspot.approve(PORTAL, [...REQUIRED_SCOPES]);
    await connect();
    await drain();
    expect(members("EM · Arkiv · Awaiting reply")).toEqual(["kari@example.com"]);

    const current = await run((tx) => catalog.getEvent(tx, event.id));
    await run((tx) => catalog.transitionEvent(tx, ctx, event.id, current.version, "archive"));
    await drain();
    expect(listNamed("EM · Arkiv · Awaiting reply")).toBeUndefined();
    expect(await run((tx) => tx.selectFrom("integrations.sync_item").select("kind").where("kind", "in", ["segment", "segment_member"]).execute())).toEqual([]);
  });

  it("keeps a segment a sent email uses, and lets go of it", async () => {
    await connect();
    const { event } = await gala("Brukt");
    await invite(event.id, "kari@example.com");
    await drain();
    const list = listNamed("EM · Brukt · Awaiting reply")!;
    hubspot.listsInUse.add(list.listId);
    const current = await run((tx) => catalog.getEvent(tx, event.id));
    await run((tx) => catalog.transitionEvent(tx, ctx, event.id, current.version, "archive"));
    await drain();
    expect(portal().lists.has(list.listId)).toBe(true);
    expect(await run((tx) => tx.selectFrom("integrations.sync_item").select("kind").where("kind", "=", "segment").execute())).toEqual([]);
  });

  it("makes a segment deleted in HubSpot again, with every member", async () => {
    await connect();
    const { event } = await gala("Borte");
    const [, ola] = await invite(event.id, "kari@example.com", "ola@example.com");
    await drain();
    portal().lists.clear();

    // The next change finds the segment gone.
    await run((tx) => registration.declineInvitation(tx, ctx.tenantId, ola!.id));
    await drain();
    expect(members("EM · Borte · Awaiting reply")).toEqual(["kari@example.com"]);
  });

  it("shows segments in the sync log", async () => {
    await connect();
    const { event } = await gala("Logg");
    await invite(event.id, "kari@example.com");
    await drain();
    const log = await run((tx) => integrations.syncSummary(tx, ctx, "hubspot"));
    expect(log.counts.segment).toEqual({ synced: 1, pending: 0, failed: 0 });
    expect(log.counts.segment_member).toEqual({ synced: 1, pending: 0, failed: 0 });
    expect(log.lastReconcile).toBeNull();
  });
});

describe("the nightly reconcile", () => {
  it("undoes hand edits, takes out guests removed from the list, and records what it fixed", async () => {
    await connect();
    const { event } = await gala("Natt");
    const [, ola] = await invite(event.id, "kari@example.com", "ola@example.com");
    await drain();
    const list = listNamed("EM · Natt · Awaiting reply")!;
    // Someone edits the segment in HubSpot: Kari out, a contact of their own in.
    const kariId = portal().contacts.get("kari@example.com")!.id;
    list.members.delete(kariId);
    portal().contacts.set("own@client.test", { id: "9999", email: "own@client.test", firstname: null, lastname: null });
    list.members.add("9999");
    // Ola is removed from the guest list, which emits nothing.
    await run((tx) => registration.removeInvitations(tx, ctx, event.id, [ola!.id]));

    const r = await reconcileSegments(db, ctx.tenantId, { client: hubspot });
    expect(r).toMatchObject({ segments: 1, added: 1, removed: 2, recreated: 0, failed: 0 });
    expect(members("EM · Natt · Awaiting reply")).toEqual(["kari@example.com"]);
    const log = await run((tx) => integrations.syncSummary(tx, ctx, "hubspot"));
    expect(log.lastReconcile).toMatchObject({ added: 1, removed: 2 });
    expect(log.counts.segment_member.pending).toBe(0);

    // A second night finds nothing to fix.
    expect(await reconcileSegments(db, ctx.tenantId, { client: hubspot })).toMatchObject({ added: 0, removed: 0 });
  });

  it("queues a segment deleted in HubSpot to be made again", async () => {
    await connect();
    const { event } = await gala("Slettet");
    await invite(event.id, "kari@example.com");
    await drain();
    portal().lists.clear();
    expect(await reconcileSegments(db, ctx.tenantId, { client: hubspot })).toMatchObject({ recreated: 1 });
    await drain();
    expect(members("EM · Slettet · Awaiting reply")).toEqual(["kari@example.com"]);
  });

  it("lets HubSpot outages fail the run for a retry", async () => {
    await connect();
    const { event } = await gala("Nede");
    await invite(event.id, "kari@example.com");
    await drain();
    hubspot.listMembers = async () => {
      throw new HubSpotError("HubSpot GET memberships: 503 down", 503);
    };
    await expect(reconcileSegments(db, ctx.tenantId, { client: hubspot })).rejects.toThrow(/503/);
  });
});
