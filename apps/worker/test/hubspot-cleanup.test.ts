import pg from "pg";
import { runOnce } from "graphile-worker";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { type ActorContext, catalog, integrations, registration, tenancy } from "@event-manager/domain";
import { CLEANUP_SCOPES, FakeHubSpot, HubSpotError, REQUIRED_SCOPES } from "@event-manager/hubspot";
import { defaultHandlers } from "../src/handlers.js";
import { NON_MARKETING_LIST, prepareForSend, runCleanup, TEMPORARY_LIST } from "../src/hubspot/cleanup.js";
import { withHubSpot } from "../src/hubspot/session.js";
import { FakeDirectory } from "../src/identity/directory.js";
import { FakeMailer } from "../src/identity/mailer.js";
import { buildTaskList } from "../src/tasks.js";

// HubSpot connector milestone 4 (docs/hubspot.md, "Cleanup after HubSpot sending"): the setup of
// the cleanup segments and workflow, what is done before a HubSpot send, the nightly cleanup and
// "Clean up and disconnect", against a fake portal.

let tdb: TestDatabase;
let db: Db;
let admin: pg.Client;
let ctx: ActorContext;
let hubspot: FakeHubSpot;
const PORTAL = "300";
const DAY = 86_400_000;
const ALL_SCOPES = [...REQUIRED_SCOPES, ...CLEANUP_SCOPES];
const EVENT_TYPE = "11";
const NEWSLETTER = "22";
const MEMBERS = "33";

// 1 December 2027 18:00 in Oslo, three hours long by default.
const START = new Date("2027-12-01T17:00:00Z");
const AFTER = new Date(START.getTime() + 30 * DAY);

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
const connection = async () => (await run((tx) => integrations.getConnection(tx, ctx, "hubspot")))!;
const cleanup = (opts: { all?: boolean; now?: Date } = {}) => runCleanup(db, ctx.tenantId, { client: hubspot }, { now: AFTER, ...opts });
const states = () => run((tx) => tx.selectFrom("integrations.contact_state").select(["email", "cleanup_status", "cleanup_reason", "marketable_before"]).orderBy("email").execute());

async function connect(scopes: string[] = ALL_SCOPES) {
  hubspot.approve(PORTAL, scopes);
  if (!portal().subscriptionTypes.length) {
    portal().subscriptionTypes = [
      { id: EVENT_TYPE, name: "Invitasjoner og arrangementer", active: true },
      { id: NEWSLETTER, name: "Nyhetsbrev", active: true },
      { id: "44", name: "Gammel", active: false },
    ];
  }
  const t = await hubspot.exchangeCode(hubspot.approve(PORTAL, scopes));
  await run((tx) => integrations.saveConnection(tx, ctx, { provider: "hubspot", portalId: PORTAL, scopes, tokens: { ...t, accessExpiresAt: t.expiresAt }, requiredScopes: REQUIRED_SCOPES }));
  await drain();
  if (scopes.includes(CLEANUP_SCOPES[0])) {
    const c = await connection();
    await run((tx) => integrations.updateSettings(tx, ctx, "hubspot", c.version, { eventSubscriptionTypeId: EVENT_TYPE }));
  }
}

async function gala(title: string, start = START) {
  return run(async (tx) => {
    let e = await catalog.createEvent(tx, ctx, {
      translations: { nb: { title } }, admissionMode: "registration", registration: { accessPolicy: "invite_only", capacity: 100, guestAllowed: false },
    });
    e = await catalog.transitionEvent(tx, ctx, e.id, e.version, "publish");
    const occ = await catalog.createOccurrence(tx, ctx, e.id, { startUtc: start });
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
  await drain();
  return invs;
}

/** What milestone 5 will do before a HubSpot send. */
async function prepare(...emails: string[]) {
  const r = await withHubSpot(db, ctx.tenantId, hubspot, (token, c) =>
    prepareForSend(ctx.tenantId, hubspot, token, c, (fn) => withTenant(db, ctx, fn), emails.map((email) => ({ email, contactId: portal().contacts.get(email)!.id }))),
  );
  return r!.value;
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  admin = new pg.Client({ connectionString: tdb.superuserUrl });
  await admin.connect();
  const account = await tenancy.createAccount(db, { slug: "hs-clean", name: "MUNCH", ownerEmail: "owner@munch.test", locales: ["nb"] });
  const userId = await tenancy.login(db, { issuer: "t", subject: "o", email: "owner@munch.test", name: null });
  ctx = { tenantId: account.id, userId, clientId: null, roles: ["owner"] };
});
beforeEach(async () => {
  await admin.query(`update catalog.event set status = 'archived' where status <> 'archived'`);
  await admin.query(`delete from registration.guest_invitation`);
  const c = await run((tx) => integrations.getConnection(tx, ctx, "hubspot"));
  if (c && c.status !== "disconnected") await run((tx) => integrations.disconnect(tx, ctx, "hubspot"));
  // Settings and what the setup found survive a reconnect; each test starts from the defaults.
  await admin.query(`update integrations.connection set settings = '{}', portal_setup = '{}', last_cleanup = null`);
  hubspot = new FakeHubSpot();
  await drain();
});
afterAll(async () => {
  await db?.destroy();
  await admin?.end();
  await tdb?.stop();
});

describe("setup", () => {
  it("makes the two cleanup segments and the non-marketing workflow, and repairs them", async () => {
    await connect();
    const c = await connection();
    expect(c.setup.status).toBe("done");
    const temporary = listNamed(TEMPORARY_LIST)!;
    const nonMarketing = listNamed(NON_MARKETING_LIST)!;
    expect(temporary.processingType).toBe("MANUAL");
    const [flow] = [...portal().workflows.values()];
    expect(flow).toMatchObject({ enabled: true, listId: nonMarketing.listId });
    expect(c.portalSetup).toMatchObject({ portalId: PORTAL, temporaryListId: temporary.listId, nonMarketingListId: nonMarketing.listId, workflowId: flow!.id, workflowEnabled: true });
    expect(c.portalSetup.subscriptionTypes).toHaveLength(3);

    // Someone switches the workflow off and deletes a segment; Repair setup puts them back.
    flow!.enabled = false;
    portal().lists.delete(temporary.listId);
    await run((tx) => integrations.requestSetup(tx, ctx, "hubspot"));
    await drain();
    expect(flow!.enabled).toBe(true);
    expect(portal().workflows.size).toBe(1);
    expect(listNamed(TEMPORARY_LIST)).toBeDefined();
    expect((await connection()).portalSetup.temporaryListId).toBe(listNamed(TEMPORARY_LIST)!.listId);
  });

  it("only checks the portal without the cleanup scopes, and refuses an unknown event subscription type", async () => {
    await connect([...REQUIRED_SCOPES]);
    expect(listNamed(TEMPORARY_LIST)).toBeUndefined();
    expect(portal().workflows.size).toBe(0);
    const c = await connection();
    await expect(run((tx) => integrations.updateSettings(tx, ctx, "hubspot", c.version, { eventSubscriptionTypeId: EVENT_TYPE }))).rejects.toMatchObject({ code: "validation_failed" });
  });
});

describe("contacts the platform created only for mirroring", () => {
  it("deletes them once no event needs them, and leaves the client's own contacts alone", async () => {
    await connect();
    const { event } = await gala("Vernissage");
    portal().contacts.set("own@client.test", { id: "77", email: "own@client.test", firstname: "Own", lastname: null });
    await invite(event.id, "kari@example.com", "own@client.test");
    const kariId = portal().contacts.get("kari@example.com")!.id;

    // Before the event, and within the grace period after it: waits.
    expect((await cleanup({ now: new Date(START.getTime() + 3 * DAY) }))!.result).toMatchObject({ deleted: 0, waiting: 1 });
    expect(portal().contacts.has("kari@example.com")).toBe(true);

    expect((await cleanup())!.result).toMatchObject({ deleted: 1, waiting: 0 });
    expect(hubspot.calls).toContain(`deleteContact:${kariId}`);
    expect(portal().contacts.has("kari@example.com")).toBe(false);
    expect(portal().contacts.has("own@client.test")).toBe(true);
    expect(await states()).toEqual([]);
    const items = await run((tx) => tx.selectFrom("integrations.sync_item").select(["kind", "local_key"]).where("kind", "in", ["contact", "segment_member"]).orderBy("local_key").execute());
    expect(items.map((i) => i.local_key)).not.toContainEqual(expect.stringContaining("kari@example.com"));
  });

  it("cleans up at once a guest the platform no longer has, such as one removed from the guest list", async () => {
    await connect();
    const { event } = await gala("Fjernet");
    const [kari] = await invite(event.id, "kari@example.com");
    await run((tx) => registration.removeInvitations(tx, ctx, event.id, [kari!.id]));
    expect((await cleanup({ now: new Date() }))!.result).toMatchObject({ deleted: 1 });
  });

  it("keeps a contact the client has taken into use, and never looks at it again", async () => {
    await connect();
    const { event } = await gala("Eier");
    await invite(event.id, "kari@example.com");
    portal().contacts.get("kari@example.com")!.owner = true;
    expect((await cleanup())!.result).toMatchObject({ kept: 1, deleted: 0 });
    expect(await states()).toEqual([expect.objectContaining({ email: "kari@example.com", cleanup_status: "kept", cleanup_reason: "It has an owner in HubSpot" })]);
    const calls = hubspot.calls.length;
    await cleanup();
    expect(hubspot.calls.slice(calls).filter((c) => c.startsWith("contactUsage"))).toEqual([]);
  });

  it("keeps a contact in a list of the client's own, but not one only in ours", async () => {
    await connect();
    const { event } = await gala("Lister");
    await invite(event.id, "kari@example.com", "ola@example.com");
    const ola = portal().contacts.get("ola@example.com")!;
    portal().lists.set("9000", { listId: "9000", name: "Client VIPs", processingType: "MANUAL", members: new Set([ola.id]) });
    expect((await cleanup())!.result).toMatchObject({ deleted: 1, kept: 1 });
    expect(portal().contacts.has("kari@example.com")).toBe(false);
    expect(portal().contacts.has("ola@example.com")).toBe(true);
  });

  it("keeps them when the account turns deleting off", async () => {
    await connect();
    const c = await connection();
    await run((tx) => integrations.updateSettings(tx, ctx, "hubspot", c.version, { deleteMirroredContacts: false }));
    const { event } = await gala("Behold");
    await invite(event.id, "kari@example.com");
    expect((await cleanup())!.result).toMatchObject({ kept: 1, deleted: 0 });
    expect(portal().contacts.has("kari@example.com")).toBe(true);
  });

  it("records a refusal and tries again the next night", async () => {
    await connect();
    const { event } = await gala("Avvist");
    await invite(event.id, "kari@example.com");
    const del = hubspot.deleteContact.bind(hubspot);
    hubspot.deleteContact = async () => {
      throw new HubSpotError("HubSpot DELETE contact: 400 nope", 400);
    };
    expect((await cleanup())!.result).toMatchObject({ failed: 1 });
    expect(await states()).toEqual([expect.objectContaining({ cleanup_status: "failed", cleanup_reason: expect.stringContaining("nope") })]);
    const log = await run((tx) => integrations.syncSummary(tx, ctx, "hubspot"));
    expect(log.cleanup).toMatchObject({ failed: 1, last: expect.objectContaining({ failed: 1 }) });
    hubspot.deleteContact = del;
    expect((await cleanup())!.result).toMatchObject({ deleted: 1 });
  });
});

describe("contacts made marketing by a HubSpot send", () => {
  it("unsubscribes a non-marketing contact from every other type before the send, and puts it all back afterwards", async () => {
    await connect();
    const { event } = await gala("Sending");
    portal().contacts.set("lender@museum.test", { id: "501", email: "lender@museum.test", firstname: "L", lastname: null, marketable: false });
    portal().contacts.set("fan@example.com", { id: "502", email: "fan@example.com", firstname: "F", lastname: null, marketable: true });
    portal().subscriptions.set("fan@example.com", new Map([[NEWSLETTER, "SUBSCRIBED"]]));
    await invite(event.id, "lender@museum.test", "fan@example.com");

    expect(await prepare("lender@museum.test", "fan@example.com")).toEqual(new Map([["lender@museum.test", false], ["fan@example.com", true]]));
    // The lender: out of the newsletter, not the event type, not the inactive type.
    expect(portal().subscriptions.get("lender@museum.test")).toEqual(new Map([[NEWSLETTER, "UNSUBSCRIBED"]]));
    expect([...listNamed(TEMPORARY_LIST)!.members]).toEqual(["501"]);
    // The fan was a marketing contact already: theirs, untouched.
    expect(portal().subscriptions.get("fan@example.com")).toEqual(new Map([[NEWSLETTER, "SUBSCRIBED"]]));
    expect(await states()).toEqual([
      expect.objectContaining({ email: "fan@example.com", cleanup_status: "none", marketable_before: true }),
      expect.objectContaining({ email: "lender@museum.test", cleanup_status: "pending", marketable_before: false }),
    ]);
    portal().contacts.get("lender@museum.test")!.marketable = true; // what the send does

    // Preparing again changes nothing.
    const calls = hubspot.calls.length;
    await prepare("lender@museum.test", "fan@example.com");
    expect(hubspot.calls.slice(calls).filter((c) => c.startsWith("setSubscriptionStatuses") || c.startsWith("addToList"))).toEqual([]);

    // A newsletter of a new kind is made in the portal: the nightly run covers it.
    portal().subscriptionTypes.push({ id: MEMBERS, name: "Medlemmer", active: true });
    expect((await cleanup({ now: new Date() }))!.result).toMatchObject({ newTypesCovered: 1, waiting: 1, restored: 0 });
    expect(portal().subscriptions.get("lender@museum.test")?.get(MEMBERS)).toBe("UNSUBSCRIBED");

    // After the event: subscriptions back, queued for non-marketing, out of the temporary segment.
    expect((await cleanup())!.result).toMatchObject({ restored: 1, deleted: 0 });
    expect(portal().subscriptions.get("lender@museum.test")).toEqual(new Map([[NEWSLETTER, "NOT_SPECIFIED"], [MEMBERS, "NOT_SPECIFIED"]]));
    expect([...listNamed(TEMPORARY_LIST)!.members]).toEqual([]);
    expect([...listNamed(NON_MARKETING_LIST)!.members]).toEqual(["501"]);
    expect(hubspot.runWorkflows(PORTAL)).toBe(1);
    expect(portal().contacts.get("lender@museum.test")!.marketable).toBe(false);
    expect(portal().contacts.get("fan@example.com")!.marketable).toBe(true);
    expect((await states()).map((s) => s.email)).toEqual(["fan@example.com"]);
  });

  it("finishes a preparation HubSpot broke off before the contact counts as prepared", async () => {
    await connect();
    const { event } = await gala("Halvveis");
    portal().contacts.set("lender@museum.test", { id: "511", email: "lender@museum.test", firstname: "L", lastname: null, marketable: false });
    await invite(event.id, "lender@museum.test");
    const write = hubspot.setSubscriptionStatuses.bind(hubspot);
    hubspot.setSubscriptionStatuses = async () => {
      throw new HubSpotError("HubSpot POST /communication-preferences/v4/statuses/batch/write: 429 too many requests", 429);
    };
    try {
      await expect(prepare("lender@museum.test")).rejects.toThrow(/429/);
    } finally {
      hubspot.setSubscriptionStatuses = write;
    }
    // What it was is known; the writes are not done, so it does not count as prepared.
    const half = await run((tx) => tx.selectFrom("integrations.contact_state").select(["marketable_before", "prepared_at", "subscriptions_set"]).where("email", "=", "lender@museum.test").executeTakeFirstOrThrow());
    expect(half).toMatchObject({ marketable_before: false, prepared_at: null, subscriptions_set: [NEWSLETTER] });
    expect(portal().subscriptions.get("lender@museum.test")?.get(NEWSLETTER)).not.toBe("UNSUBSCRIBED");

    // The retry finishes the writes from what was recorded.
    expect(await prepare("lender@museum.test")).toEqual(new Map([["lender@museum.test", false]]));
    expect(portal().subscriptions.get("lender@museum.test")?.get(NEWSLETTER)).toBe("UNSUBSCRIBED");
    expect([...listNamed(TEMPORARY_LIST)!.members]).toEqual(["511"]);
    const done = await run((tx) => tx.selectFrom("integrations.contact_state").select(["prepared_at"]).where("email", "=", "lender@museum.test").executeTakeFirstOrThrow());
    expect(done.prepared_at).not.toBeNull();
  });

  it("keeps a contact pending while the workflow that sets it back is off, and sets it back once repaired", async () => {
    await connect();
    const { event } = await gala("Av");
    portal().contacts.set("lender@museum.test", { id: "521", email: "lender@museum.test", firstname: "L", lastname: null, marketable: false });
    await invite(event.id, "lender@museum.test");
    await prepare("lender@museum.test");
    portal().contacts.get("lender@museum.test")!.marketable = true;
    const [flow] = [...portal().workflows.values()];
    flow!.enabled = false;

    expect((await cleanup())!.result).toMatchObject({ restored: 0, failed: 1 });
    expect(await states()).toEqual([expect.objectContaining({ email: "lender@museum.test", cleanup_status: "failed", cleanup_reason: expect.stringMatching(/workflow/) })]);
    expect([...listNamed(NON_MARKETING_LIST)!.members]).toEqual([]);
    expect(portal().subscriptions.get("lender@museum.test")?.get(NEWSLETTER)).toBe("UNSUBSCRIBED");

    await run((tx) => integrations.requestSetup(tx, ctx, "hubspot"));
    await drain();
    expect((await cleanup())!.result).toMatchObject({ restored: 1, failed: 0 });
    expect([...listNamed(NON_MARKETING_LIST)!.members]).toEqual(["521"]);
  });

  it("leaves a type the guest changed themselves since", async () => {
    await connect();
    const { event } = await gala("Valg");
    portal().contacts.set("lender@museum.test", { id: "601", email: "lender@museum.test", firstname: "L", lastname: null, marketable: false });
    await invite(event.id, "lender@museum.test");
    await prepare("lender@museum.test");
    // The guest subscribes to the newsletter themselves.
    portal().subscriptions.get("lender@museum.test")!.set(NEWSLETTER, "SUBSCRIBED");
    await cleanup();
    expect(portal().subscriptions.get("lender@museum.test")?.get(NEWSLETTER)).toBe("SUBSCRIBED");
  });

  it("refuses to prepare a send before the cleanup is ready", async () => {
    await connect();
    const c = await connection();
    await run((tx) => integrations.updateSettings(tx, ctx, "hubspot", c.version, { eventSubscriptionTypeId: null }));
    const { event } = await gala("Ikke klar");
    await invite(event.id, "kari@example.com");
    await expect(prepare("kari@example.com")).rejects.toThrow(/subscription type/);
  });

  it("deletes a contact the platform created and made marketing, rather than setting it back", async () => {
    await connect();
    const { event } = await gala("Ny");
    await invite(event.id, "new@example.com");
    await prepare("new@example.com");
    expect((await cleanup())!.result).toMatchObject({ deleted: 1, restored: 0 });
    expect(portal().contacts.has("new@example.com")).toBe(false);
  });
});

describe("clean up and disconnect", () => {
  it("cleans up every contact at once, then disconnects and revokes the token", async () => {
    await connect();
    const { event } = await gala("Farvel", new Date(Date.now() + 14 * DAY));
    await invite(event.id, "kari@example.com");
    await run((tx) => integrations.requestCleanupAndDisconnect(tx, ctx, "hubspot"));
    expect((await connection()).cleanupDisconnectRequestedAt).not.toBeNull();
    await drain();
    expect(portal().contacts.has("kari@example.com")).toBe(false);
    const c = await connection();
    expect(c.status).toBe("disconnected");
    expect(c.cleanupDisconnectRequestedAt).toBeNull();
    expect(hubspot.calls).toContain("revoke");
    const audit = await run((tx) => tx.selectFrom("tenancy.audit_log").select(["action", "actor_user_id"]).where("action", "=", "integration.disconnected").orderBy("at", "desc").executeTakeFirstOrThrow());
    expect(audit.actor_user_id).toBe(ctx.userId);
  });

  it("stays connected when a contact could not be cleaned up, and says so", async () => {
    await connect();
    const { event } = await gala("Feil", new Date(Date.now() + 14 * DAY));
    await invite(event.id, "kari@example.com");
    hubspot.deleteContact = async () => {
      throw new HubSpotError("HubSpot DELETE contact: 400 nope", 400);
    };
    await run((tx) => integrations.requestCleanupAndDisconnect(tx, ctx, "hubspot"));
    await drain();
    const c = await connection();
    expect(c.status).toBe("active");
    expect(c.cleanupDisconnectRequestedAt).toBeNull();
    expect(c.lastCleanup).toMatchObject({ failed: 1, error: expect.stringContaining("still connected") });
  });
});
