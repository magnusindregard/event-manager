import pg from "pg";
import { runOnce } from "graphile-worker";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { type ActorContext, catalog, registration, tenancy } from "@event-manager/domain";
import { defaultHandlers } from "../src/handlers.js";
import { FakeDirectory } from "../src/identity/directory.js";
import { FakeMailer } from "../src/identity/mailer.js";
import { buildTaskList } from "../src/tasks.js";

let tdb: TestDatabase;
let db: Db;
let admin: pg.Client;
let ctx: ActorContext;
let mailer: FakeMailer;
const attendee = { kind: "attendee" } as const;

async function drain() {
  for (let i = 0; i < 4; i++) {
    await admin.query(`update graphile_worker._private_jobs set run_at = now() where locked_at is null`);
    await runOnce({
      connectionString: tdb.appUrl,
      taskList: buildTaskList(db, defaultHandlers, { directory: new FakeDirectory(), mailer, adminUrl: "https://admin.test/" }, { mailer, attendeeUrl: "https://attend.test/" }),
    });
  }
}

const run = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db, ctx, fn);

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  admin = new pg.Client({ connectionString: tdb.superuserUrl });
  await admin.connect();
  const account = await tenancy.createAccount(db, { slug: "mail", name: "MUNCH", ownerEmail: "owner@munch.test", locales: ["nb", "en"] });
  const userId = await tenancy.login(db, { issuer: "t", subject: "o", email: "owner@munch.test", name: null });
  ctx = { tenantId: account.id, userId, clientId: null, roles: ["owner"] };
  await drain();
});
beforeEach(() => {
  mailer = new FakeMailer();
});
afterAll(async () => {
  await db?.destroy();
  await admin?.end();
  await tdb?.stop();
});

async function occurrence() {
  return run(async (tx) => {
    const venue = await catalog.createLocation(tx, ctx, { kind: "venue", name: "MUNCH", address: "Edvard Munchs plass 1" });
    let e = await catalog.createEvent(tx, ctx, {
      translations: { nb: { title: "Kveldsomvisning" }, en: { title: "Evening tour" } }, defaultLocationId: venue.id,
      admissionMode: "registration", registration: { capacity: 10, guestAllowed: true },
    });
    e = await catalog.transitionEvent(tx, ctx, e.id, e.version, "publish");
    return catalog.createOccurrence(tx, ctx, e.id, { startUtc: new Date(Date.now() + 7 * 86_400_000) });
  });
}

describe("registration emails", () => {
  it("confirms with a QR code and a manage link, in the attendee's locale", async () => {
    const occ = await occurrence();
    const reg = await run((tx) => registration.register(tx, ctx.tenantId, occ.id, { name: "Kari", email: "kari@example.com", partySize: 2 }, attendee));
    await drain();
    expect(mailer.sent).toHaveLength(1);
    const m = mailer.sent[0]!;
    expect(m.to).toBe("kari@example.com");
    expect(m.subject).toBe("Påmeldt: Kveldsomvisning");
    expect(m.text).toContain("2 personer");
    expect(m.text).toContain("MUNCH");
    expect(m.html).toContain('src="cid:qr"');
    expect(m.attachments?.[0]).toMatchObject({ name: "qr.png", contentType: "image/png", contentId: "qr" });
    expect(Buffer.from(m.attachments![0]!.content, "base64").subarray(1, 4).toString()).toBe("PNG");

    // The link in the email opens this registration.
    const token = /https:\/\/attend\.test\/m\/([A-Za-z0-9_-]{72})/.exec(m.text)![1]!;
    expect((await run((tx) => registration.registrationByToken(tx, token)))?.id).toBe(reg.id);
  });

  it("sends change and cancellation emails, in English for an English registration", async () => {
    const occ = await occurrence();
    const reg = await run((tx) => registration.register(tx, ctx.tenantId, occ.id, { name: "Ola", email: "ola@example.com", locale: "en" }, attendee));
    await drain();
    await run((tx) => registration.updateRegistration(tx, ctx.tenantId, reg.id, { partySize: 2 }, attendee));
    await drain();
    await run((tx) => registration.cancelRegistration(tx, ctx.tenantId, reg.id, attendee));
    await drain();
    expect(mailer.sent.map((m) => m.subject)).toEqual(["Registered: Evening tour", "Registration changed: Evening tour", "Cancelled: Evening tour"]);
    expect(mailer.sent[1]!.text).toContain("2 people");
    expect(mailer.sent[2]!.attachments).toBeUndefined();
  });

  it("does not confirm a registration that was cancelled before the email went out", async () => {
    const occ = await occurrence();
    const reg = await run((tx) => registration.register(tx, ctx.tenantId, occ.id, { name: "Siv", email: "siv@example.com" }, attendee));
    await run((tx) => registration.cancelRegistration(tx, ctx.tenantId, reg.id, attendee));
    await drain();
    expect(mailer.sent.map((m) => m.subject)).toEqual(["Avbestilt: Kveldsomvisning"]);
  });
});

describe("occurrence notices", () => {
  async function setup() {
    const occ = await occurrence();
    const [kari, ola, gone] = await Promise.all(["kari", "ola", "gone"].map((n) =>
      run((tx) => registration.register(tx, ctx.tenantId, occ.id, { name: n, email: `${n}-${occ.id.slice(-6)}@example.com`, locale: n === "ola" ? "en" : "nb" }, attendee))));
    await run((tx) => registration.cancelRegistration(tx, ctx.tenantId, gone!.id, attendee));
    await drain();
    mailer.sent.length = 0;
    return { occ, kari: kari!, ola: ola! };
  }
  const recipients = () => mailer.sent.map((m) => m.to.split("-")[0]).sort();

  it("tells confirmed attendees once when time and place change in one edit", async () => {
    const { occ } = await setup();
    const room = await run((tx) => catalog.createLocation(tx, ctx, { kind: "venue", name: "Auditoriet" }));
    const o = await run((tx) => catalog.getOccurrence(tx, occ.id));
    await run((tx) => catalog.updateOccurrence(tx, ctx, occ.id, o.version, { startUtc: new Date(o.startUtc.getTime() + 3_600_000), locationOverrideId: room.id }));
    await drain();
    expect(recipients()).toEqual(["kari", "ola"]);
    const nb = mailer.sent.find((m) => m.to.startsWith("kari"))!;
    expect(nb.subject).toBe("Ny tid eller nytt sted: Kveldsomvisning");
    expect(nb.text).toContain("Auditoriet");
    expect(nb.attachments?.[0]?.contentId).toBe("qr");
    expect(mailer.sent.find((m) => m.to.startsWith("ola"))!.subject).toBe("New time or place: Evening tour");
  });

  it("tells them when the place changes through the event's default", async () => {
    const { occ } = await setup();
    const hall = await run((tx) => catalog.createLocation(tx, ctx, { kind: "venue", name: "Hallen" }));
    const ev = await run((tx) => catalog.getEvent(tx, occ.eventId));
    await run((tx) => catalog.updateEvent(tx, ctx, ev.id, ev.version, { defaultLocationId: hall.id }));
    await drain();
    expect(recipients()).toEqual(["kari", "ola"]);
    expect(mailer.sent[0]!.text).toContain("Hallen");
  });

  it("stays quiet about changes attendees do not need", async () => {
    const { occ } = await setup();
    const o = await run((tx) => catalog.getOccurrence(tx, occ.id));
    await run((tx) => catalog.updateOccurrence(tx, ctx, occ.id, o.version, { capacityOverride: 50 }));
    await drain();
    expect(mailer.sent).toEqual([]);
  });

  it("tells them when the occurrence or the whole event is cancelled", async () => {
    const { occ } = await setup();
    const o = await run((tx) => catalog.getOccurrence(tx, occ.id));
    await run((tx) => catalog.updateOccurrence(tx, ctx, occ.id, o.version, { status: "cancelled" }));
    await drain();
    expect(recipients()).toEqual(["kari", "ola"]);
    expect(mailer.sent.find((m) => m.to.startsWith("kari"))!.subject).toBe("Avlyst: Kveldsomvisning");
    expect(mailer.sent[0]!.attachments).toBeUndefined();

    mailer.sent.length = 0;
    const second = await setup();
    const ev = await run((tx) => catalog.getEvent(tx, second.occ.eventId));
    await run((tx) => catalog.transitionEvent(tx, ctx, ev.id, ev.version, "cancel"));
    await drain();
    expect(recipients()).toEqual(["kari", "ola"]);
    expect(mailer.sent.find((m) => m.to.startsWith("ola"))!.subject).toBe("Cancelled: Evening tour");
  });

  it("tells them when a cancelled occurrence is restored (#54)", async () => {
    const { occ } = await setup();
    let o = await run((tx) => catalog.getOccurrence(tx, occ.id));
    o = await run((tx) => catalog.updateOccurrence(tx, ctx, occ.id, o.version, { status: "cancelled" }));
    await drain();
    mailer.sent.length = 0;
    await run((tx) => catalog.updateOccurrence(tx, ctx, occ.id, o.version, { status: "scheduled" }));
    await drain();
    expect(recipients()).toEqual(["kari", "ola"]);
    const nb = mailer.sent.find((m) => m.to.startsWith("kari"))!;
    expect(nb.subject).toBe("Blir likevel ikke avlyst: Kveldsomvisning");
    expect(nb.attachments?.[0]?.contentId).toBe("qr");
    expect(mailer.sent.find((m) => m.to.startsWith("ola"))!.subject).toBe("Going ahead after all: Evening tour");
  });

  it("tells them when a cancelled event is published again, but not on other publishes (#54)", async () => {
    const { occ } = await setup();
    let ev = await run((tx) => catalog.getEvent(tx, occ.eventId));
    ev = await run((tx) => catalog.transitionEvent(tx, ctx, ev.id, ev.version, "cancel"));
    await drain();
    mailer.sent.length = 0;
    ev = await run((tx) => catalog.transitionEvent(tx, ctx, ev.id, ev.version, "publish"));
    await drain();
    expect(recipients()).toEqual(["kari", "ola"]);
    expect(mailer.sent[0]!.subject).toMatch(/Blir likevel ikke avlyst|Going ahead after all/);

    mailer.sent.length = 0;
    ev = await run((tx) => catalog.transitionEvent(tx, ctx, ev.id, ev.version, "unpublish"));
    await run((tx) => catalog.transitionEvent(tx, ctx, ev.id, ev.version, "publish"));
    await drain();
    expect(mailer.sent).toEqual([]);
  });

  it("sends nothing when a cancellation is withdrawn before its notice went out (#54)", async () => {
    const { occ } = await setup();
    let o = await run((tx) => catalog.getOccurrence(tx, occ.id));
    o = await run((tx) => catalog.updateOccurrence(tx, ctx, occ.id, o.version, { status: "cancelled" }));
    await run((tx) => catalog.updateOccurrence(tx, ctx, occ.id, o.version, { status: "scheduled" }));
    await drain();
    expect(mailer.sent).toEqual([]);
  });

  it("still tells them of an event cancellation dispatched after the start (#55)", async () => {
    const { occ } = await setup();
    const ev = await run((tx) => catalog.getEvent(tx, occ.eventId));
    await run((tx) => catalog.transitionEvent(tx, ctx, ev.id, ev.version, "cancel"));
    // The dispatch is delayed until the occurrence has started, but not ended.
    await admin.query(`update catalog.occurrence set start_utc = now() - interval '10 minutes', end_utc = now() + interval '1 hour' where id = $1`, [occ.id]);
    await drain();
    expect(recipients()).toEqual(["kari", "ola"]);
    expect(mailer.sent.find((m) => m.to.startsWith("ola"))!.subject).toBe("Cancelled: Evening tour");
  });

  it("tells them when the address of their venue changes, also through a space (#56)", async () => {
    const { occ } = await setup();
    const o = await run((tx) => catalog.getOccurrence(tx, occ.id));
    const venueId = o.effective.location!.value as string;
    const venue = await run((tx) => catalog.getLocation(tx, venueId));
    await run((tx) => catalog.updateLocation(tx, ctx, venueId, venue.version, { address: "Bjørvika 1" }));
    await drain();
    expect(recipients()).toEqual(["kari", "ola"]);
    expect(mailer.sent[0]!.text).toContain("Bjørvika 1");

    // A space without its own address shows the venue's.
    mailer.sent.length = 0;
    const space = await run((tx) => catalog.createLocation(tx, ctx, { kind: "space", parentId: venueId, name: "Sal 2" }));
    const o2 = await run((tx) => catalog.getOccurrence(tx, occ.id));
    await run((tx) => catalog.updateOccurrence(tx, ctx, occ.id, o2.version, { locationOverrideId: space.id }));
    await drain();
    mailer.sent.length = 0;
    const v2 = await run((tx) => catalog.getLocation(tx, venueId));
    await run((tx) => catalog.updateLocation(tx, ctx, venueId, v2.version, { address: "Bjørvika 2" }));
    await drain();
    expect(recipients()).toEqual(["kari", "ola"]);
    expect(mailer.sent[0]!.text).toContain("Sal 2");
    expect(mailer.sent[0]!.text).toContain("Bjørvika 2");
  });

  it("stays quiet about other locations and fields attendees do not see (#56)", async () => {
    const { occ } = await setup();
    const other = await run((tx) => catalog.createLocation(tx, ctx, { kind: "venue", name: "Annet sted", address: "Gate 1" }));
    await run((tx) => catalog.updateLocation(tx, ctx, other.id, other.version, { address: "Gate 2" }));
    const o = await run((tx) => catalog.getOccurrence(tx, occ.id));
    const venue = await run((tx) => catalog.getLocation(tx, o.effective.location!.value as string));
    await run((tx) => catalog.updateLocation(tx, ctx, venue.id, venue.version, { geo: { lat: 59.9, lng: 10.75 } }));
    await drain();
    expect(mailer.sent).toEqual([]);
  });
});
