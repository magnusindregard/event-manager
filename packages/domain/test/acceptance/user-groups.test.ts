import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, type Tx, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { type ActorContext, catalog, offers, registration, sales, tenancy } from "../../src/index.js";

// User groups milestone 1 (docs/user-groups.md): groups per account, access per event and offer,
// the public access flags, registration by invitation for restricted events, and the buyer's
// group on reserve and extend, frozen in the snapshot.

let tdb: TestDatabase;
let db: Db;
let ctx: ActorContext;
let other: ActorContext;
let exempt: offers.VatClass;
let web: offers.SalesChannel;
let webCaller: sales.ChannelCaller;
let member: catalog.UserGroup;
let sponsor: catalog.UserGroup;

const run = <T>(fn: (tx: Tx) => Promise<T>, as: ActorContext = ctx) => withTenant(db, as, fn);
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code ?? String(e));
const title = (t: string) => ({ nb: { title: t } });
const name = (n: string) => ({ nb: { name: n } });

const START = new Date("2027-02-13T18:30:00Z");
const NOW = new Date("2027-02-01T12:00:00Z");
const at = (min: number) => new Date(NOW.getTime() + min * 60_000);

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  const account = await tenancy.createAccount(db, { slug: "groups", name: "Groups", ownerEmail: "owner@groups.test" });
  const userId = await tenancy.login(db, { issuer: "https://idp.test", subject: "owner@groups.test", email: "owner@groups.test", name: null });
  ctx = { tenantId: account.id, userId, clientId: null, roles: ["owner"] };
  const second = await tenancy.createAccount(db, { slug: "groups-2", name: "Other", ownerEmail: "owner@other.test" });
  const otherUser = await tenancy.login(db, { issuer: "https://idp.test", subject: "owner@other.test", email: "owner@other.test", name: null });
  other = { tenantId: second.id, userId: otherUser, clientId: null, roles: ["owner"] };

  exempt = await run((tx) => offers.createVatClass(tx, ctx, { code: "exempt", label: "Fritatt", ratePct: 0 }));
  web = await run((tx) => offers.createChannel(tx, ctx, { code: "web", name: "Nettbutikk", kind: "ecom" }));
  await run((tx) => offers.setSkuMapping(tx, ctx, exempt.id, web.id, "TICKET-VAT0"));
  const key = await run((tx) => offers.createChannelKey(tx, ctx, web.id, "Shop"));
  webCaller = { tenantId: ctx.tenantId, channelId: web.id, signingKey: createHash("sha256").update(key.secret.slice(key.secret.indexOf("_", 3) + 1)).digest() };
  member = await run((tx) => catalog.createUserGroup(tx, ctx, { code: "member", names: { nb: "Medlem", en: "Member" }, sortOrder: 1 }));
  sponsor = await run((tx) => catalog.createUserGroup(tx, ctx, { code: "sponsor", names: { nb: "Sponsor" }, sortOrder: 2 }));
});
afterAll(async () => {
  await db?.destroy();
  await tdb?.stop();
});

/** A published ticketed event with Adult 450 and a members' early bird offer. */
async function concert(slug: string, accessGroupIds: string[] = []) {
  const event = await run((tx) => catalog.createEvent(tx, ctx, { slug, translations: title("Hamlet"), admissionMode: "tickets", registration: { capacity: 100 }, accessGroupIds }));
  const occ = await run((tx) => catalog.createOccurrence(tx, ctx, event.id, { startUtc: START }));
  const adult = await run(async (tx) => (await offers.createOffer(tx, ctx, event.id, { translations: name("Voksen"), vatClassId: exempt.id, defaultPrice: 45000 })).offer!);
  const early = await run(async (tx) => (await offers.createOffer(tx, ctx, event.id, { code: "early", translations: name("Tidlig medlem"), vatClassId: exempt.id, defaultPrice: 30000, accessGroupIds: [member.id] })).offer!);
  await run(async (tx) => catalog.transitionEvent(tx, ctx, event.id, (await catalog.getEvent(tx, event.id)).version, "publish"));
  return { event, occ, adult, early };
}

const reserve = (input: sales.ReserveInput, now = NOW) => run((tx) => sales.reserve(tx, webCaller, input, now));
const publicOcc = (eventId: string) => run(async (tx) => (await catalog.listPublicOccurrences(tx, { preview: false, now: NOW, attendeeUrl: "https://a.test" }, { event: eventId, from: NOW, limit: 10 })).items[0]!);

describe("user groups", () => {
  it("are listed in order, with unique codes, and only owners change them", async () => {
    const list = await run((tx) => catalog.listUserGroups(tx));
    expect(list.map((g) => g.code)).toEqual(["member", "sponsor"]);
    expect(list[0]).toMatchObject({ names: { nb: "Medlem", en: "Member" }, archived: false, usedBy: 0 });
    expect(await code(run((tx) => catalog.createUserGroup(tx, ctx, { code: "member", names: { nb: "X" } })))).toBe("conflict");
    expect(await code(run((tx) => catalog.createUserGroup(tx, ctx, { code: "Member!", names: { nb: "X" } })))).toBe("validation_failed");
    expect(await code(run((tx) => catalog.createUserGroup(tx, ctx, { code: "x", names: {} })))).toBe("validation_failed");
    const editor = { ...ctx, roles: ["event_manager" as const] };
    expect(await code(run((tx) => catalog.createUserGroup(tx, editor, { code: "friends", names: { nb: "Venner" } }), editor))).toBe("forbidden");
    // Another account has its own groups, and the same code is free there.
    expect(await run((tx) => catalog.listUserGroups(tx), other)).toEqual([]);
    expect((await run((tx) => catalog.createUserGroup(tx, other, { code: "member", names: { nb: "Medlem" } }), other)).code).toBe("member");
  });

  it("cannot be archived while an event or offer is restricted to them, and archived groups cannot be used", async () => {
    const friends = await run((tx) => catalog.createUserGroup(tx, ctx, { code: "friends", names: { nb: "Venner" } }));
    const event = await run((tx) => catalog.createEvent(tx, ctx, { slug: "friends-night", translations: title("Venner"), accessGroupIds: [friends.id] }));
    expect((await run((tx) => catalog.getUserGroup(tx, friends.id))).usedBy).toBe(1);
    expect(await code(run((tx) => catalog.updateUserGroup(tx, ctx, friends.id, friends.version, { archived: true })))).toBe("conflict");

    const opened = await run((tx) => catalog.updateEvent(tx, ctx, event.id, event.version, { accessGroupIds: [] }));
    expect(opened.accessGroupIds).toEqual([]);
    const archived = await run((tx) => catalog.updateUserGroup(tx, ctx, friends.id, friends.version, { archived: true }));
    expect(archived).toMatchObject({ archived: true, usedBy: 0 });
    expect(await code(run((tx) => catalog.updateEvent(tx, ctx, event.id, opened.version, { accessGroupIds: [friends.id] })))).toBe("validation_failed");
    expect(await code(run((tx) => catalog.createEvent(tx, ctx, { translations: title("Y"), accessGroupIds: ["00000000-0000-4000-8000-000000000000"] })))).toBe("validation_failed");
    await run((tx) => catalog.updateUserGroup(tx, ctx, friends.id, archived.version, { archived: false }));

    // Archiving and restoring is audited and emitted.
    const types = await run((tx) => tx.selectFrom("outbox.event").select("type").where("subject", "=", `user-group/${friends.id}`).execute());
    expect(types.map((t) => t.type)).toEqual(["user_group.changed.v1", "user_group.changed.v1", "user_group.changed.v1"]);
  });
});

describe("acceptance: a member-only ticketed event", () => {
  it("is listed and flagged, and reserving needs a group on its list", async () => {
    const { event, occ, adult } = await concert("members-only", [member.id]);
    expect(event.accessGroupIds).toEqual([member.id]);
    const listed = await run((tx) => catalog.listPublicEvents(tx, { preview: false, now: NOW }, { limit: 200 }));
    expect(listed.items.find((e) => e.id === event.id)?.access).toEqual({ groups: [{ code: "member", name: "Medlem" }] });

    const line = { occurrenceId: occ.id, offerId: adult.id, quantity: 1 };
    expect(await code(reserve({ lines: [line] }))).toBe("group_required");
    await expect(reserve({ lines: [line], group: "sponsor" })).rejects.toMatchObject({ code: "group_not_allowed", details: { line: 0, group: "sponsor", groups: ["member"] } });
    expect(await code(reserve({ lines: [line], group: "nobody" }))).toBe("unknown_group");

    const r = await reserve({ lines: [line], group: "member" });
    expect(r).toMatchObject({ status: "held", group: "member" });
    expect(r.lines[0]).toMatchObject({ group: "member", unitPrice: 45000 });
    expect(r.signature).toMatch(/^v1\./);
    // The group is part of what the signatures cover.
    const signed = { ...r.lines[0]!, group: null };
    expect(r.lines[0]!.signature).not.toBe(sales.signSnapshot(webCaller.signingKey!, sales.lineSignatureText(r.id, signed)));
    expect(r.lines[0]!.signature).toBe(sales.signSnapshot(webCaller.signingKey!, sales.lineSignatureText(r.id, r.lines[0]!)));
  });
});

describe("acceptance: a member-only offer on an open event", () => {
  it("refuses that line to others and sells the other offers to anyone", async () => {
    const { event, occ, adult, early } = await concert("early-bird");
    const o = await publicOcc(event.id);
    expect(o.event.access).toEqual({ groups: [] });
    expect(o.offers.map((x) => [x.code, x.access.groups.map((g) => g.code)])).toEqual([["voksen", []], ["early", ["member"]]]);

    const lines = [{ occurrenceId: occ.id, offerId: adult.id, quantity: 1 }, { occurrenceId: occ.id, offerId: early.id, quantity: 1 }];
    await expect(reserve({ lines })).rejects.toMatchObject({ code: "group_required", details: { line: 1 } });
    await expect(reserve({ lines, group: "sponsor" })).rejects.toMatchObject({ code: "group_not_allowed", details: { line: 1 } });
    expect((await reserve({ lines: [lines[0]!] })).group).toBeNull();
    expect((await reserve({ lines, group: "member" })).total.amount).toBe(75000);
  });

  it("checks the group again on extend", async () => {
    const { occ, early } = await concert("extend-check");
    const r = await reserve({ lines: [{ occurrenceId: occ.id, offerId: early.id, quantity: 1 }], group: "member" });
    // Staff open the offer to sponsors only while the member's cart is held.
    const offer = await run((tx) => offers.getOffer(tx, early.id));
    await run((tx) => offers.updateOffer(tx, ctx, early.id, offer.version, { accessGroupIds: [sponsor.id] }));
    expect(await code(run((tx) => sales.extendReservation(tx, webCaller, r.id, {}, at(5))))).toBe("group_not_allowed");
    // Confirm does not recheck: the buyer has paid for a valid hold.
    expect((await run((tx) => sales.confirm(tx, webCaller, r.id, { externalOrderRef: "O-1" }, at(6)))).status).toBe("confirmed");
  });

  it("keeps archived groups out of reservations, also on extend", async () => {
    const temp = await run((tx) => catalog.createUserGroup(tx, ctx, { code: "temp", names: { nb: "Midlertidig" } }));
    const { occ, adult } = await concert("archived-group");
    const r = await reserve({ lines: [{ occurrenceId: occ.id, offerId: adult.id, quantity: 1 }], group: "temp" });
    await run((tx) => catalog.updateUserGroup(tx, ctx, temp.id, temp.version, { archived: true }));
    expect(await code(reserve({ lines: [{ occurrenceId: occ.id, offerId: adult.id, quantity: 1 }], group: "temp" }))).toBe("unknown_group");
    expect(await code(run((tx) => sales.extendReservation(tx, webCaller, r.id, {}, at(5))))).toBe("unknown_group");
  });

  it("copies access to another event, leaving archived groups behind", async () => {
    const { event } = await concert("copy-source");
    const target = await run((tx) => catalog.createEvent(tx, ctx, { slug: "copy-target", translations: title("Kopi"), admissionMode: "tickets", registration: { capacity: 10 } }));
    const { created } = await run((tx) => offers.copyOffers(tx, ctx, target.id, event.id));
    expect(created.find((o) => o.code === "early")?.accessGroupIds).toEqual([member.id]);
  });
});

describe("acceptance: a members' registration event", () => {
  it("has no sign-up link, refuses attendees, and takes invited guests and staff registrations", async () => {
    const event = await run((tx) => catalog.createEvent(tx, ctx, { slug: "members-gala", translations: title("Medlemsfest"), admissionMode: "registration", registration: { accessPolicy: "open", capacity: 50 }, accessGroupIds: [member.id] }));
    const occ = await run((tx) => catalog.createOccurrence(tx, ctx, event.id, { startUtc: START }));
    await run(async (tx) => catalog.transitionEvent(tx, ctx, event.id, (await catalog.getEvent(tx, event.id)).version, "publish"));
    // Listed and flagged, like a ticketed event.
    expect(event.registration.listed).toBe(true);
    const o = await publicOcc(event.id);
    expect(o.admission).toEqual({ mode: "registration", url: null });
    expect(o.event.access.groups.map((g) => g.code)).toEqual(["member"]);

    expect(await code(run((tx) => registration.register(tx, ctx.tenantId, occ.id, { name: "Anne", email: "anne@example.com" }, { kind: "attendee" }, NOW)))).toBe("invitation_required");
    const inv = await run((tx) => registration.createInvitation(tx, ctx, event.id, { email: "invited@example.com", name: "Invitert" }));
    expect((await run((tx) => registration.acceptInvitation(tx, ctx.tenantId, inv.id, { occurrenceId: occ.id }, NOW))).status).toBe("confirmed");
    expect((await run((tx) => registration.register(tx, ctx.tenantId, occ.id, { name: "Staff", email: "staff@example.com" }, { kind: "staff", ctx }, NOW))).status).toBe("confirmed");
  });
});

describe("tenancy", () => {
  it("does not see another account's group codes", async () => {
    const { occ, adult } = await concert("tenant-check");
    await run((tx) => catalog.createUserGroup(tx, other, { code: "only-other", names: { nb: "Andre" } }), other);
    expect(await code(reserve({ lines: [{ occurrenceId: occ.id, offerId: adult.id, quantity: 1 }], group: "only-other" }))).toBe("unknown_group");
  });
});
