import pg from "pg";
import { runOnce } from "graphile-worker";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { type ActorContext, catalog, integrations, registration, tenancy } from "@event-manager/domain";
import { CLEANUP_SCOPES, FakeHubSpot, HubSpotError, type MarketingEmail, REQUIRED_SCOPES } from "@event-manager/hubspot";
import { defaultHandlers } from "../src/handlers.js";
import { fillPlaceholders, PLACEHOLDERS } from "../src/hubspot/emails.js";
import { FakeDirectory } from "../src/identity/directory.js";
import { FakeMailer } from "../src/identity/mailer.js";
import { buildTaskList } from "../src/tasks.js";

// HubSpot connector milestone 5 (docs/hubspot.md, "HubSpot sending"): the templates the setup
// finds, the event's own emails made from them, invitations, reminders and the welcome sent one
// per guest through the single-send API, and the platform's own email when HubSpot will not take
// it. Against a fake portal.

let tdb: TestDatabase;
let db: Db;
let admin: pg.Client;
let ctx: ActorContext;
let hubspot: FakeHubSpot;
let mailer: FakeMailer;
const PORTAL = "500";
const DAY = 86_400_000;
const ALL_SCOPES = [...REQUIRED_SCOPES, ...CLEANUP_SCOPES];
const EVENT_TYPE = "11";
const NEWSLETTER = "22";

const START = new Date("2027-12-01T17:00:00Z");

/** A template as a client would save it for single-send: a button with our placeholder, and a preview text module. */
const templateContent = (link: string) => ({
  widgets: {
    preview_text: { body: { value: "" } },
    button: { body: { html: `<a href="${link}">Svar</a>` } },
    footer: { body: { html: `<a href="${PLACEHOLDERS.eventLink}">Les mer</a>` } },
  },
});

async function drain(rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    await admin.query(`update graphile_worker._private_jobs set run_at = now() where locked_at is null and run_at > now()`);
    await runOnce({
      connectionString: tdb.appUrl,
      taskList: buildTaskList(db, defaultHandlers, { directory: new FakeDirectory(), mailer, adminUrl: "https://admin.test/" }, { mailer, attendeeUrl: "https://attend.test/" }, { client: hubspot, pollMs: 0 }),
    });
  }
}

const run = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db, ctx, fn);
const portal = () => hubspot.portals.get(PORTAL)!;
const connection = async () => (await run((tx) => integrations.getConnection(tx, ctx, "hubspot")))!;
const sending = (eventId: string) => run((tx) => integrations.getEventSending(tx, ctx, eventId, CLEANUP_SCOPES));
const setSending = async (eventId: string, patch: integrations.EventSendingPatch) => {
  const s = await sending(eventId);
  return run((tx) => integrations.updateEventSending(tx, ctx, eventId, s.version, patch, CLEANUP_SCOPES));
};
const sends = () =>
  run((tx) =>
    tx.selectFrom("registration.invitation_send as s").innerJoin("registration.guest_invitation as i", "i.id", "s.invitation_id")
      .select(["i.email", "s.id", "s.kind", "s.channel", "s.sent_at", "s.fallback_reason", "s.provider_status_id", "s.delivery_status"]).orderBy("i.email").orderBy("s.requested_at").execute(),
  );

let invitationTemplate: MarketingEmail;
let welcomeTemplate: MarketingEmail;

async function connect(scopes: string[] = ALL_SCOPES) {
  hubspot.approve(PORTAL, scopes);
  portal().subscriptionTypes = [
    { id: EVENT_TYPE, name: "Invitasjoner og arrangementer", active: true },
    { id: NEWSLETTER, name: "Nyhetsbrev", active: true },
  ];
  invitationTemplate = hubspot.addEmail(PORTAL, { name: "Invitasjon (mal)", subscriptionId: EVENT_TYPE, content: templateContent(PLACEHOLDERS.invitationLink) });
  welcomeTemplate = hubspot.addEmail(PORTAL, { name: "Velkommen (mal)", subscriptionId: EVENT_TYPE, content: templateContent(PLACEHOLDERS.manageLink) });
  // Not templates: a regular newsletter on the event type, and a clone of the platform's own.
  hubspot.addEmail(PORTAL, { name: "Nyhetsbrev desember", type: "BATCH_EMAIL", subscriptionId: EVENT_TYPE });
  hubspot.addEmail(PORTAL, { name: "EM · Gammel · Invitation", subscriptionId: EVENT_TYPE });
  const t = await hubspot.exchangeCode(hubspot.approve(PORTAL, scopes));
  await run((tx) => integrations.saveConnection(tx, ctx, { provider: "hubspot", portalId: PORTAL, scopes, tokens: { ...t, accessExpiresAt: t.expiresAt }, requiredScopes: REQUIRED_SCOPES }));
  await drain();
  if (scopes.includes(CLEANUP_SCOPES[0])) {
    let c = await connection();
    c = await run((tx) => integrations.updateSettings(tx, ctx, "hubspot", c.version, { eventSubscriptionTypeId: EVENT_TYPE }));
    // The setup reads which emails use the event type again with it chosen.
    await run((tx) => integrations.requestSetup(tx, ctx, "hubspot"));
    await drain();
    c = await connection();
    await run((tx) => integrations.updateSettings(tx, ctx, "hubspot", c.version, { invitationTemplateId: invitationTemplate.id, reminderTemplateId: invitationTemplate.id, welcomeTemplateId: welcomeTemplate.id }));
    await drain();
  }
}

async function gala(title: string, opts: { start?: Date; reminderMinBefore?: number | null } = {}) {
  return run(async (tx) => {
    let e = await catalog.createEvent(tx, ctx, {
      translations: { nb: { title } }, admissionMode: "registration", externalUrl: "https://munch.test/gala",
      registration: { accessPolicy: "invite_only", capacity: 100, guestAllowed: false, reminderMinBefore: opts.reminderMinBefore ?? null },
    });
    e = await catalog.transitionEvent(tx, ctx, e.id, e.version, "publish");
    const occ = await catalog.createOccurrence(tx, ctx, e.id, { startUtc: opts.start ?? START });
    return { event: e, occ };
  });
}

async function addGuests(eventId: string, ...emails: string[]) {
  return run(async (tx) => {
    const out = [];
    for (const email of emails) out.push(await registration.createInvitation(tx, ctx, eventId, { email, name: `${email.split("@")[0]} Nordmann` }));
    return out;
  });
}

async function hubspotEvent(title: string, opts: { start?: Date; reminderMinBefore?: number | null } = {}) {
  const g = await gala(title, opts);
  await setSending(g.event.id, { channel: "hubspot" });
  await drain();
  return g;
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  admin = new pg.Client({ connectionString: tdb.superuserUrl });
  await admin.connect();
  const account = await tenancy.createAccount(db, { slug: "hs-send", name: "MUNCH", ownerEmail: "owner@munch.test", locales: ["nb"] });
  const userId = await tenancy.login(db, { issuer: "t", subject: "o", email: "owner@munch.test", name: null });
  ctx = { tenantId: account.id, userId, clientId: null, roles: ["owner"] };
});
beforeEach(async () => {
  await admin.query(`update catalog.event set status = 'archived' where status <> 'archived'`);
  await admin.query(`delete from registration.guest_invitation`);
  await admin.query(`delete from integrations.event_sending`);
  const c = await run((tx) => integrations.getConnection(tx, ctx, "hubspot"));
  if (c && c.status !== "disconnected") await run((tx) => integrations.disconnect(tx, ctx, "hubspot"));
  await admin.query(`update integrations.connection set settings = '{}', portal_setup = '{}', last_cleanup = null`);
  hubspot = new FakeHubSpot();
  mailer = new FakeMailer();
  await drain();
});
afterAll(async () => {
  await db?.destroy();
  await admin?.end();
  await tdb?.stop();
});

describe("templates", () => {
  it("offers the portal's single-send emails, not the platform's own, and names the client's emails on the event type", async () => {
    await connect();
    const setup = (await connection()).portalSetup;
    expect(setup.singleSendEmails?.map((e) => e.name).sort()).toEqual(["Invitasjon (mal)", "Velkommen (mal)"]);
    expect(setup.singleSendEmails?.find((e) => e.id === invitationTemplate.id)).toMatchObject({ hasInvitationLink: true, hasManageLink: false, subscriptionId: EVENT_TYPE });
    expect(setup.eventTypeUsedBy).toEqual([expect.objectContaining({ name: "Nyhetsbrev desember" })]);
    const c = await connection();
    await expect(run((tx) => integrations.updateSettings(tx, ctx, "hubspot", c.version, { welcomeTemplateId: "999" }))).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("puts the event's links in for the placeholders", () => {
    const filled = fillPlaceholders(templateContent(PLACEHOLDERS.invitationLink), { attendeeUrl: "https://attend.test/", eventUrl: "https://munch.test/a\"b" });
    const text = JSON.stringify(filled);
    expect(text).toContain("https://attend.test/i/{{ custom.invitation_token }}");
    expect((filled as { widgets: { footer: { body: { html: string } } } }).widgets.footer.body.html).toBe('<a href="https://munch.test/a"b">Les mer</a>');
    expect(text).not.toContain("[[em:");
  });
});

describe("choosing HubSpot for an event", () => {
  it("is refused until the account can send through HubSpot", async () => {
    await connect([...REQUIRED_SCOPES]);
    const { event } = await gala("Uten opprydding");
    expect((await sending(event.id)).hubspotBlocker).toMatch(/cleanup scopes/);
    await expect(setSending(event.id, { channel: "hubspot" })).rejects.toMatchObject({ code: "conflict" });
  });

  it("makes the event's own emails from the templates, and counts who would become marketing contacts", async () => {
    await connect();
    const { event } = await gala("Vernissage", { reminderMinBefore: 24 * 60 });
    portal().contacts.set("kjent@munch.test", { id: "71", email: "kjent@munch.test", firstname: "K", lastname: null, marketable: true });
    await addGuests(event.id, "kjent@munch.test", "ny@example.com", "pluss+tag@example.com");
    await setSending(event.id, { channel: "hubspot", texts: { invitation: { subject: "Velkommen til åpningen", previewText: "Lørdag kl. 18" } } });
    await drain();

    const s = await sending(event.id);
    expect(s.channel).toBe("hubspot");
    expect(s.emails.map((e) => [e.kind, e.status])).toEqual([["invitation", "ready"], ["reminder", "ready"], ["welcome", "ready"]]);
    const invitation = portal().emails.get(s.emails[0]!.remoteId!)!;
    expect(invitation).toMatchObject({ name: "EM · Vernissage · Invitation", subject: "Velkommen til åpningen", state: "AUTOMATED" });
    expect(JSON.stringify(invitation.content)).toContain("https://attend.test/i/{{ custom.invitation_token }}");
    expect(JSON.stringify(invitation.content)).toContain("https://munch.test/gala");
    expect((invitation.content as { widgets: { preview_text: { body: { value: string } } } }).widgets.preview_text.body.value).toBe("Lørdag kl. 18");
    expect(portal().emails.get(s.emails[1]!.remoteId!)!.subject).toBe("Påminnelse: Invitasjon til Vernissage");
    expect(JSON.stringify(portal().emails.get(s.emails[2]!.remoteId!)!.content)).toContain("https://attend.test/m/{{ custom.manage_token }}");
    // The templates themselves are untouched.
    expect(JSON.stringify(portal().emails.get(invitationTemplate.id)!.content)).toContain(PLACEHOLDERS.invitationLink);
    expect(s.marketingCheck).toMatchObject({ guests: 2, marketing: 1, wouldBecome: 1, plusAddresses: 1 });

    // A new subject before anything is sent makes the email again.
    const before = s.emails[0]!.remoteId!;
    await setSending(event.id, { texts: { invitation: { subject: "Ny emnelinje" } } });
    await drain();
    const again = (await sending(event.id)).emails[0]!;
    expect(again.remoteId).not.toBe(before);
    expect(portal().emails.has(before)).toBe(false);
    expect(portal().emails.get(again.remoteId!)!.subject).toBe("Ny emnelinje");
  });

  it("deletes the emails when the event goes back to the platform or is archived", async () => {
    await connect();
    const { event } = await hubspotEvent("Tilbake");
    const ids = (await sending(event.id)).emails.map((e) => e.remoteId!);
    expect(ids).toHaveLength(2);
    await setSending(event.id, { channel: "platform" });
    await drain();
    expect((await sending(event.id)).emails).toEqual([]);
    for (const id of ids) expect(portal().emails.has(id)).toBe(false);

    await setSending(event.id, { channel: "hubspot" });
    await drain();
    const made = (await sending(event.id)).emails.map((e) => e.remoteId!);
    const e = await run((tx) => catalog.getEvent(tx, event.id));
    await run((tx) => catalog.transitionEvent(tx, ctx, event.id, e.version, "archive"));
    await drain();
    for (const id of made) expect(portal().emails.has(id)).toBe(false);
  });
});

describe("sending to a guest", () => {
  it("sends through HubSpot with the invitation's own token, after preparing the contact for the cleanup", async () => {
    await connect();
    const { event } = await hubspotEvent("Gallamiddag");
    const [kari] = await addGuests(event.id, "kari@example.com");
    await run((tx) => registration.requestSends(tx, ctx, event.id, { kind: "invitation" }));
    await drain();

    const [send] = await sends();
    expect(send).toMatchObject({ email: "kari@example.com", channel: "hubspot", delivery_status: "sent", fallback_reason: null });
    expect(send!.sent_at).not.toBeNull();
    expect(mailer.sent).toEqual([]);
    const hs = portal().sends;
    expect(hs).toHaveLength(1);
    const invitation = (await sending(event.id)).emails.find((e) => e.kind === "invitation")!;
    expect(hs[0]).toMatchObject({ emailId: invitation.remoteId, to: "kari@example.com", sendId: send!.id, sendResult: "SENT" });
    const token = await run((tx) => registration.invitationToken(tx, ctx.tenantId, kari!));
    expect(hs[0]!.customProperties).toMatchObject({ invitation_token: token, event_title: "Gallamiddag", guest_name: "kari Nordmann" });
    expect(hs[0]!.customProperties.event_date).toContain("2027");
    expect((await run((tx) => registration.getInvitation(tx, kari!.id))).status).toBe("sent");

    // The cleanup knows what to take back: the platform made the contact and took it out of the newsletter.
    const connectionId = (await connection()).id;
    const state = (await run((tx) => integrations.contactStates(tx, connectionId, ["kari@example.com"]))).get("kari@example.com")!;
    expect(state).toMatchObject({ createdByUs: true, marketableBefore: false, subscriptionsSet: [NEWSLETTER], status: "pending" });
    expect(portal().subscriptions.get("kari@example.com")?.get(NEWSLETTER)).toBe("UNSUBSCRIBED");
    // The contact sync afterwards (HubSpot then says not new) does not hide that the platform made it.
    const item = await run((tx) => tx.selectFrom("integrations.sync_item").select(["created_by_us", "remote_id"]).where("kind", "=", "contact").where("local_key", "=", "kari@example.com").executeTakeFirstOrThrow());
    expect(item).toMatchObject({ created_by_us: true, remote_id: portal().contacts.get("kari@example.com")!.id });

    // The channel is settled now, and the invitation's email no longer changes.
    await expect(setSending(event.id, { channel: "platform" })).rejects.toMatchObject({ code: "conflict" });
    await expect(setSending(event.id, { texts: { invitation: { subject: "For sent" } } })).rejects.toMatchObject({ code: "validation_failed" });
    expect((await sending(event.id)).locked).toBe(true);
  });

  it("lets the platform send to guests HubSpot would refuse, and says why", async () => {
    await connect();
    const { event } = await hubspotEvent("Reserve");
    portal().subscriptions.set("nei@example.com", new Map([[EVENT_TYPE, "UNSUBSCRIBED"]]));
    await addGuests(event.id, "pluss+1@example.com", "nei@example.com");
    await run((tx) => registration.requestSends(tx, ctx, event.id, { kind: "invitation" }));
    await drain();

    expect((await sends()).map((s) => [s.email, s.channel, s.delivery_status, s.fallback_reason])).toEqual([
      ["nei@example.com", "platform", "sent", "The guest has unsubscribed from event emails in HubSpot"],
      ["pluss+1@example.com", "platform", "sent", "HubSpot does not send to addresses with a +"],
    ]);
    expect(mailer.sent.map((m) => m.to).sort()).toEqual(["nei@example.com", "pluss+1@example.com"]);
    // Never tried, so neither became a marketing contact through us.
    expect(portal().sends).toEqual([]);
    expect(portal().contacts.get("nei@example.com")?.marketable).not.toBe(true);
  });

  it("falls back when HubSpot refuses the send, as a portal without Enterprise does", async () => {
    await connect();
    const { event } = await hubspotEvent("Uten Enterprise");
    await addGuests(event.id, "kari@example.com");
    hubspot.sendRefusal = new HubSpotError("HubSpot POST single-send: 403 This portal does not have access", 403);
    await run((tx) => registration.requestSends(tx, ctx, event.id, { kind: "invitation" }));
    await drain();
    const [send] = await sends();
    expect(send).toMatchObject({ channel: "platform", delivery_status: "sent" });
    expect(send!.fallback_reason).toMatch(/^HubSpot refused the send: .*403/);
    expect(mailer.sent).toHaveLength(1);
  });

  it("waits for HubSpot to accept a freshly published email, and never sends twice", async () => {
    await connect();
    hubspot.publishLag = 2;
    hubspot.pendingPolls = 7;
    const { event } = await hubspotEvent("Tålmodig");
    await addGuests(event.id, "kari@example.com");
    await run((tx) => registration.requestSends(tx, ctx, event.id, { kind: "invitation" }));
    await drain(10);
    const [send] = await sends();
    expect(send).toMatchObject({ channel: "hubspot", delivery_status: "sent" });
    expect(portal().sends).toHaveLength(1);
    expect(hubspot.calls.filter((c) => c === "singleSend:kari@example.com")).toHaveLength(3);
    expect(mailer.sent).toEqual([]);
  });

  it("sends the reminder from the event's reminder email to guests who have not answered", async () => {
    await connect();
    const { event } = await hubspotEvent("Purring");
    const [kari, ola] = await addGuests(event.id, "kari@example.com", "ola@example.com");
    await run((tx) => registration.requestSends(tx, ctx, event.id, { kind: "invitation" }));
    await drain();
    await run((tx) => registration.declineInvitation(tx, ctx.tenantId, ola!.id));
    await run((tx) => registration.requestSends(tx, ctx, event.id, { kind: "reminder" }));
    await drain();
    const reminder = (await sending(event.id)).emails.find((e) => e.kind === "reminder")!;
    const hs = portal().sends.filter((s) => s.emailId === reminder.remoteId);
    expect(hs.map((s) => s.to)).toEqual(["kari@example.com"]);
    expect((await sends()).filter((s) => s.kind === "reminder").map((s) => [s.email, s.channel])).toEqual([["kari@example.com", "hubspot"]]);
    expect(kari).toBeDefined();
  });

  it("sends the welcome before the event through HubSpot, with a link to the guest's manage page", async () => {
    await connect();
    const { event, occ } = await hubspotEvent("Velkomst", { start: new Date(Date.now() + 3 * DAY), reminderMinBefore: 24 * 60 });
    const [kari] = await addGuests(event.id, "kari@example.com");
    const reg = await run((tx) => registration.acceptInvitation(tx, ctx.tenantId, kari!.id, { occurrenceId: occ.id }));
    await drain();
    // The occurrence moves to 12 hours from now: the welcome is due at once.
    await admin.query(`update registration.registration set created_at = now() - interval '2 days', confirmed_at = now() - interval '2 days' where id = $1`, [reg.id]);
    const o = await run((tx) => catalog.getOccurrence(tx, occ.id));
    await run((tx) => catalog.updateOccurrence(tx, ctx, occ.id, o.version, { startUtc: new Date(Date.now() + DAY / 2), endUtc: new Date(Date.now() + DAY / 2 + 3_600_000) }));
    mailer.sent.length = 0;
    await drain();

    const welcome = (await sending(event.id)).emails.find((e) => e.kind === "welcome")!;
    const hs = portal().sends.filter((s) => s.emailId === welcome.remoteId);
    expect(hs).toHaveLength(1);
    expect(hs[0]).toMatchObject({ to: "kari@example.com", sendId: `welcome-${reg.id}` });
    const r = await run((tx) => registration.getRegistration(tx, reg.id));
    expect(hs[0]!.customProperties.manage_token).toBe(await run((tx) => registration.manageToken(tx, ctx.tenantId, r)));
    expect(mailer.sent.filter((m) => m.subject.startsWith("Påminnelse"))).toEqual([]);
    const row = await run((tx) => tx.selectFrom("registration.registration").select(["reminded_at", "reminder_channel"]).where("id", "=", reg.id).executeTakeFirstOrThrow());
    expect(row.reminder_channel).toBe("hubspot");
    expect(row.reminded_at).not.toBeNull();
  });
});
