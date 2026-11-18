import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, sql, type Tx, withoutTenant, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { type ActorContext, catalog, DomainError, registration, tenancy } from "../../src/index.js";

// Registration milestone 2 (docs/registration.md): open registration, confirmation at
// once, change and cancel through signed links, public availability.

let tdb: TestDatabase;
let db: Db;
let ctx: ActorContext;
const attendee = { kind: "attendee" } as const;

const run = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(db, ctx, fn);
const title = (t: string) => ({ nb: { title: t }, en: { title: `${t} (en)` } });
const NOW = new Date("2027-02-01T12:00:00Z");
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof DomainError ? e.code : String(e)));

async function openEvent(settings: Partial<catalog.RegistrationSettings> = {}, startUtc = new Date("2027-03-01T17:00:00Z")) {
  const event = await run(async (tx) => {
    const e = await catalog.createEvent(tx, ctx, { translations: title("Foredrag"), admissionMode: "registration", registration: { capacity: 40, overbookingPct: 10, ...settings } });
    return catalog.transitionEvent(tx, ctx, e.id, e.version, "publish");
  });
  const occ = await run((tx) => catalog.createOccurrence(tx, ctx, event.id, { startUtc }));
  return { event, occ };
}

const person = (i: number, extra: Partial<registration.RegistrationInput> = {}) => ({ name: `Person ${i}`, email: `p${i}@example.com`, ...extra });

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl, { max: 20 });
  const account = await tenancy.createAccount(db, { slug: "registration", name: "Registration", ownerEmail: "owner@registration.test" });
  const userId = await tenancy.login(db, { issuer: "https://idp.test", subject: "owner@registration.test", email: "owner@registration.test", name: null });
  ctx = { tenantId: account.id, userId, clientId: null, roles: ["owner"] };
});
afterAll(async () => {
  await db?.destroy();
  await tdb?.stop();
});

describe("acceptance: an open talk with 40 places and 10 % overbooking", () => {
  it("takes 44 registrations, then reports full", async () => {
    const { occ } = await openEvent();
    for (let i = 0; i < 44; i++) await run((tx) => registration.register(tx, ctx.tenantId, occ.id, person(i), attendee, NOW));
    expect(await code(run((tx) => registration.register(tx, ctx.tenantId, occ.id, person(44), attendee, NOW)))).toBe("full");
    const after = await run((tx) => catalog.getOccurrence(tx, occ.id));
    expect(after.pool).toMatchObject({ taken: 44, bookableLimit: 44, available: 0 });
    const target = await run((tx) => catalog.getRegistrationTarget(tx, occ.id));
    expect(catalog.targetAvailability(target, NOW).status).toBe("full");
  });
});

describe("acceptance: two people register for the last place at the same moment", () => {
  it("gives it to exactly one of them", async () => {
    const { occ } = await openEvent({ capacity: 1, overbookingPct: 0 });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => code(run((tx) => registration.register(tx, ctx.tenantId, occ.id, person(100 + i), attendee, NOW)))),
    );
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "full")).toHaveLength(7);
    const after = await run((tx) => catalog.getOccurrence(tx, occ.id));
    expect(after.pool).toMatchObject({ taken: 1 });
    expect(await run((tx) => registration.listRegistrations(tx, ctx, occ.id))).toHaveLength(1);
  });
});

describe("registering", () => {
  it("is confirmed at once, with an admission and an outbox event", async () => {
    const { occ, event } = await openEvent({ guestAllowed: true });
    const reg = await run((tx) => registration.register(tx, ctx.tenantId, occ.id, person(1, { name: "  Kari   Nordmann ", email: " Kari@Example.com ", partySize: 2, locale: "en" }), attendee, NOW));
    expect(reg).toMatchObject({ name: "Kari Nordmann", email: "kari@example.com", partySize: 2, status: "confirmed", source: "open", locale: "en", eventId: event.id });
    const [pool, adm, events] = await run(async (tx) => [
      (await catalog.getOccurrence(tx, occ.id)).pool,
      await tx.selectFrom("admission.admission").selectAll().where("registration_id", "=", reg.id).executeTakeFirst(),
      await tx.selectFrom("outbox.event").select(["type", "data"]).where("subject", "=", `registration/${reg.id}`).execute(),
    ] as const);
    expect(pool).toMatchObject({ taken: 2 });
    expect(adm).toMatchObject({ party_size: 2, status: "valid", occurrence_id: occ.id });
    expect(events).toEqual([{ type: "registration.confirmed.v1", data: expect.objectContaining({ registrationId: reg.id, partySize: 2, source: "open" }) }]);
  });

  it("allows one active registration per email, and another after cancelling", async () => {
    const { occ } = await openEvent();
    const first = await run((tx) => registration.register(tx, ctx.tenantId, occ.id, person(2), attendee, NOW));
    expect(await code(run((tx) => registration.register(tx, ctx.tenantId, occ.id, person(2, { email: "P2@example.com" }), attendee, NOW)))).toBe("already_registered");
    await run((tx) => registration.cancelRegistration(tx, ctx.tenantId, first.id, attendee, NOW));
    expect(await code(run((tx) => registration.register(tx, ctx.tenantId, occ.id, person(2), attendee, NOW)))).toBe("ok");
  });

  it("offers a guest only where the event allows it; staff may add one anyway", async () => {
    const { occ } = await openEvent({ guestAllowed: false });
    expect(await code(run((tx) => registration.register(tx, ctx.tenantId, occ.id, person(3, { partySize: 2 }), attendee, NOW)))).toBe("validation_failed");
    const staff = await run((tx) => registration.register(tx, ctx.tenantId, occ.id, person(3, { partySize: 2 }), { kind: "staff", ctx }, NOW));
    expect(staff).toMatchObject({ source: "staff", partySize: 2 });
  });

  it("validates name and email", async () => {
    const { occ } = await openEvent();
    expect(await code(run((tx) => registration.register(tx, ctx.tenantId, occ.id, { name: " ", email: "a@b.no" }, attendee, NOW)))).toBe("validation_failed");
    expect(await code(run((tx) => registration.register(tx, ctx.tenantId, occ.id, { name: "A", email: "not-an-email" }, attendee, NOW)))).toBe("validation_failed");
  });

  it("follows the registration window and the occurrence's status", async () => {
    const start = new Date("2027-03-01T17:00:00Z");
    const { occ } = await openEvent({ opensMinBefore: 7 * 1440, closesMinBefore: 120 }, start);
    const at = (iso: string) => code(run((tx) => registration.register(tx, ctx.tenantId, occ.id, person(Date.parse(iso)), attendee, new Date(iso))));
    expect(await at("2027-02-20T12:00:00Z")).toBe("registration_closed"); // before it opens
    expect(await at("2027-02-25T12:00:00Z")).toBe("ok");
    expect(await at("2027-03-01T15:30:00Z")).toBe("registration_closed"); // within two hours of the start
    const o = await run((tx) => catalog.getOccurrence(tx, occ.id));
    await run((tx) => catalog.updateOccurrence(tx, ctx, occ.id, o.version, { status: "cancelled" }));
    expect(await at("2027-02-26T12:00:00Z")).toBe("registration_closed");
  });

  it("needs an invitation for invite-only events", async () => {
    const { occ } = await openEvent({ accessPolicy: "invite_only" });
    expect(await code(run((tx) => registration.register(tx, ctx.tenantId, occ.id, person(4), attendee, NOW)))).toBe("invitation_required");
  });

  it("does not take registrations for events without registration", async () => {
    const event = await run((tx) => catalog.createEvent(tx, ctx, { translations: title("Konsert") }));
    const occ = await run((tx) => catalog.createOccurrence(tx, ctx, event.id, { startUtc: new Date("2027-03-01T17:00:00Z") }));
    expect(await code(run((tx) => registration.register(tx, ctx.tenantId, occ.id, person(5), attendee, NOW)))).toBe("conflict");
  });
});

describe("changing and cancelling", () => {
  it("adds and removes the guest against the pool", async () => {
    const { occ } = await openEvent({ capacity: 2, overbookingPct: 0, guestAllowed: true });
    const a = await run((tx) => registration.register(tx, ctx.tenantId, occ.id, person(10), attendee, NOW));
    const b = await run((tx) => registration.register(tx, ctx.tenantId, occ.id, person(11), attendee, NOW));
    expect(await code(run((tx) => registration.updateRegistration(tx, ctx.tenantId, a.id, { partySize: 2 }, attendee, { now: NOW })))).toBe("full");
    await run((tx) => registration.cancelRegistration(tx, ctx.tenantId, b.id, attendee, NOW));
    const a2 = await run((tx) => registration.updateRegistration(tx, ctx.tenantId, a.id, { partySize: 2, name: "Ny Person" }, attendee, { now: NOW }));
    expect(a2).toMatchObject({ partySize: 2, name: "Ny Person", version: a.version + 1 });
    const adm = await run((tx) => tx.selectFrom("admission.admission").select("party_size").where("registration_id", "=", a.id).executeTakeFirstOrThrow());
    expect(adm.party_size).toBe(2);
    await run((tx) => registration.updateRegistration(tx, ctx.tenantId, a.id, { partySize: 1 }, attendee, { now: NOW }));
    expect((await run((tx) => catalog.getOccurrence(tx, occ.id))).pool).toMatchObject({ taken: 1 });
  });

  it("releases the places and voids the admission on cancel; twice is a no-op", async () => {
    const { occ } = await openEvent({ guestAllowed: true });
    const r = await run((tx) => registration.register(tx, ctx.tenantId, occ.id, person(12, { partySize: 2 }), attendee, NOW));
    const c = await run((tx) => registration.cancelRegistration(tx, ctx.tenantId, r.id, attendee, NOW));
    expect(c).toMatchObject({ status: "cancelled", cancelledBy: "attendee" });
    await run((tx) => registration.cancelRegistration(tx, ctx.tenantId, r.id, attendee, NOW));
    expect((await run((tx) => catalog.getOccurrence(tx, occ.id))).pool).toMatchObject({ taken: 0 });
    const adm = await run((tx) => tx.selectFrom("admission.admission").select("status").where("registration_id", "=", r.id).executeTakeFirstOrThrow());
    expect(adm.status).toBe("void");
    expect(await code(run((tx) => registration.updateRegistration(tx, ctx.tenantId, r.id, { name: "X" }, attendee, { now: NOW })))).toBe("conflict");
  });

  it("closes changes with the window and cancelling at the start", async () => {
    const start = new Date("2027-03-01T17:00:00Z");
    const { occ } = await openEvent({ closesMinBefore: 120 }, start);
    const r = await run((tx) => registration.register(tx, ctx.tenantId, occ.id, person(13), attendee, NOW));
    const late = new Date("2027-03-01T16:00:00Z");
    expect(await code(run((tx) => registration.updateRegistration(tx, ctx.tenantId, r.id, { name: "Y" }, attendee, { now: late })))).toBe("registration_closed");
    expect(await code(run((tx) => registration.cancelRegistration(tx, ctx.tenantId, r.id, attendee, new Date("2027-03-01T17:00:00Z"))))).toBe("registration_closed");
    expect(await code(run((tx) => registration.cancelRegistration(tx, ctx.tenantId, r.id, attendee, late)))).toBe("ok");
  });
});

describe("attendee links", () => {
  it("resolve to the registration; rotated, forged and admission tokens do not", async () => {
    const { occ } = await openEvent();
    const r = await run((tx) => registration.register(tx, ctx.tenantId, occ.id, person(20), attendee, NOW));
    const [manage, adm] = await run(async (tx) => [await registration.manageToken(tx, ctx.tenantId, r), await registration.admissionToken(tx, ctx.tenantId, r)]);
    expect(manage).toHaveLength(72);
    expect(registration.tokenTenant(manage)).toBe(ctx.tenantId);
    expect((await run((tx) => registration.registrationByToken(tx, manage)))?.id).toBe(r.id);
    expect(await run((tx) => registration.registrationByToken(tx, adm!))).toBeNull();
    const forged = manage.slice(0, 60) + (manage[60] === "A" ? "B" : "A") + manage.slice(61);
    expect(await run((tx) => registration.registrationByToken(tx, forged))).toBeNull();
    expect(registration.tokenTenant("nonsense")).toBeNull();
    await run((tx) => tx.updateTable("registration.registration").set({ token_version: 2 }).where("id", "=", r.id).execute());
    expect(await run((tx) => registration.registrationByToken(tx, manage))).toBeNull();
  });

  it("find the tenant of a published registration occurrence without a tenant", async () => {
    const { occ } = await openEvent();
    expect(await withoutTenant(db, (tx) => registration.occurrenceTenant(tx, occ.id))).toBe(ctx.tenantId);
    const draft = await run((tx) => catalog.createEvent(tx, ctx, { translations: title("Utkast"), admissionMode: "registration" }));
    const dOcc = await run((tx) => catalog.createOccurrence(tx, ctx, draft.id, { startUtc: new Date("2027-03-01T17:00:00Z") }));
    expect(await withoutTenant(db, (tx) => registration.occurrenceTenant(tx, dOcc.id))).toBeNull();
  });
});

describe("occurrences with registrations", () => {
  it("cannot be deleted, and series occurrences are detached so regeneration keeps them", async () => {
    const event = await run(async (tx) => {
      const e = await catalog.createEvent(tx, ctx, { translations: title("Omvisning"), admissionMode: "registration", registration: { capacity: 10 } });
      return catalog.transitionEvent(tx, ctx, e.id, e.version, "publish");
    });
    const { series } = await run((tx) => catalog.createSeries(tx, ctx, event.id, { rrule: "FREQ=WEEKLY;COUNT=3", dtstartLocal: "2027-03-01T14:00:00", durationMin: 60 }, { now: NOW }));
    const occs = await run((tx) => catalog.listOccurrences(tx, { eventId: event.id, seriesId: series!.id, limit: 10 }));
    const first = occs[0]!;
    await run((tx) => registration.register(tx, ctx.tenantId, first.id, person(30), attendee, NOW));
    const after = await run((tx) => catalog.getOccurrence(tx, first.id));
    expect(after).toMatchObject({ detached: true, version: first.version });
    expect(await code(run((tx) => catalog.deleteOccurrence(tx, ctx, first.id, after.version)))).toBe("conflict");

    // Moving the series' time leaves the registered occurrence in place and flags it.
    const s = await run((tx) => catalog.getSeries(tx, series!.id));
    const res = await run((tx) => catalog.updateSeries(tx, ctx, s.id, s.version, { dtstartLocal: "2027-03-01T15:00:00" }, { now: NOW }));
    expect(res.changes.conflicts.map((c) => c.occurrenceId)).toEqual([first.id]);
    expect((await run((tx) => catalog.getOccurrence(tx, first.id))).startUtc).toEqual(first.startUtc);
  });
});

describe("public availability", () => {
  it("reports registration admission and a status without numbers", async () => {
    const { occ, event } = await openEvent({ capacity: 20, overbookingPct: 0 });
    const read = () => run((tx) => catalog.listPublicOccurrences(tx, { preview: false, attendeeUrl: "https://attend.test/", now: NOW }, { from: NOW, event: event.id, limit: 10 }));
    let [o] = (await read()).items;
    expect(o!.admission).toEqual({ mode: "registration", url: `https://attend.test/r/${occ.id}` });
    expect(o!.availability).toEqual({ status: "available", opensAt: null, closesAt: occ.startUtc.toISOString() });
    for (let i = 0; i < 18; i++) await run((tx) => registration.register(tx, ctx.tenantId, occ.id, person(200 + i), attendee, NOW));
    [o] = (await read()).items;
    expect(o!.availability!.status).toBe("few_left");
    for (let i = 18; i < 20; i++) await run((tx) => registration.register(tx, ctx.tenantId, occ.id, person(200 + i), attendee, NOW));
    [o] = (await read()).items;
    expect(o!.availability!.status).toBe("full");
  });

  it("has no link for invite-only events and no availability for other modes", async () => {
    const { event } = await openEvent({ accessPolicy: "invite_only", listed: true });
    const [o] = (await run((tx) => catalog.listPublicOccurrences(tx, { preview: false, attendeeUrl: "https://attend.test", now: NOW }, { from: NOW, event: event.id, limit: 10 }))).items;
    expect(o!.admission).toEqual({ mode: "registration", url: null });

    const plain = await run(async (tx) => {
      const e = await catalog.createEvent(tx, ctx, { translations: title("Utstilling") });
      return catalog.transitionEvent(tx, ctx, e.id, e.version, "publish");
    });
    await run((tx) => catalog.createOccurrence(tx, ctx, plain.id, { startUtc: new Date("2027-03-01T17:00:00Z") }));
    const [p] = (await run((tx) => catalog.listPublicOccurrences(tx, { preview: false, now: NOW }, { from: NOW, event: plain.id, limit: 10 }))).items;
    expect(p).toMatchObject({ admission: { mode: "none" }, availability: null });
  });
});

describe("pure availability", () => {
  const base = { now: NOW, startUtc: new Date("2027-03-01T17:00:00Z"), eventStatus: "published", occurrenceStatus: "scheduled", opensMinBefore: null, closesMinBefore: 0 } as const;
  it("uses a tenth of the limit for few_left, and no limit is always available", () => {
    expect(catalog.availabilityOf({ ...base, pool: { bookableLimit: 44, available: 5 } }).status).toBe("few_left");
    expect(catalog.availabilityOf({ ...base, pool: { bookableLimit: 44, available: 6 } }).status).toBe("available");
    expect(catalog.availabilityOf({ ...base, pool: { bookableLimit: null, available: null } }).status).toBe("available");
    expect(catalog.availabilityOf({ ...base, pool: null }).status).toBe("closed");
  });
});

// Keeps sql imported for ad-hoc debugging in this file.
void sql;

describe("reset to series (#48, #51)", () => {
  async function seriesEvent(capacity: number) {
    const event = await run(async (tx) => {
      const e = await catalog.createEvent(tx, ctx, { translations: title("Serie"), admissionMode: "registration", registration: { capacity } });
      return catalog.transitionEvent(tx, ctx, e.id, e.version, "publish");
    });
    // Daily at 12:00 Oslo from 1 March 2027.
    const series = (await run((tx) => catalog.createSeries(tx, ctx, event.id, { rrule: "FREQ=DAILY;COUNT=3", dtstartLocal: "2027-03-01T12:00" }, { now: NOW }))).series!;
    const occs = await run((tx) => catalog.listOccurrences(tx, { eventId: event.id, limit: 10 }));
    return { event, series, occs };
  }

  it("clears the capacity override, so capacity follows the event again", async () => {
    const { occs } = await seriesEvent(1);
    const edited = await run((tx) => catalog.updateOccurrence(tx, ctx, occs[0]!.id, occs[0]!.version, { capacityOverride: 5 }));
    expect(edited).toMatchObject({ detached: true, overrides: { capacity: 5 }, pool: { capacity: 5 } });
    const reset = await run((tx) => catalog.reattachOccurrence(tx, ctx, edited.id, edited.version));
    expect(reset).toMatchObject({ detached: false, overrides: { capacity: null }, effective: { capacity: { value: 1, source: "default" } }, pool: { capacity: 1, bookableLimit: 1 } });
  });

  it("keeps a booked occurrence protected from regeneration", async () => {
    const { series, occs } = await seriesEvent(10);
    const booked = occs[0]!;
    await run((tx) => registration.register(tx, ctx.tenantId, booked.id, person(500), attendee, NOW));
    const protectedOcc = await run((tx) => catalog.getOccurrence(tx, booked.id));
    expect(protectedOcc.detached).toBe(true);
    const reset = await run((tx) => catalog.reattachOccurrence(tx, ctx, booked.id, protectedOcc.version));
    expect(reset.detached).toBe(true);

    const moved = await run((tx) => catalog.updateSeries(tx, ctx, series.id, series.version, { dtstartLocal: "2027-03-01T15:00" }, { now: NOW }));
    expect(moved.changes.conflicts).toEqual([expect.objectContaining({ occurrenceId: booked.id, reason: "moved" })]);
    expect((await run((tx) => catalog.getOccurrence(tx, booked.id))).startUtc).toEqual(new Date("2027-03-01T11:00:00Z"));

    // Removing the booked slot is reported, and the occurrence stays.
    const after = await run((tx) => catalog.getSeries(tx, series.id));
    const removed = await run((tx) => catalog.updateSeries(tx, ctx, series.id, after.version, { dtstartLocal: "2027-03-02T15:00", rrule: "FREQ=DAILY;COUNT=2" }, { now: NOW }));
    expect(removed.changes.conflicts).toEqual([expect.objectContaining({ occurrenceId: booked.id })]);
    expect(await run((tx) => catalog.getOccurrence(tx, booked.id))).toMatchObject({ id: booked.id, detached: true });
  });

  it("lets an occurrence without registrations follow the series again", async () => {
    const { occs } = await seriesEvent(10);
    const edited = await run((tx) => catalog.updateOccurrence(tx, ctx, occs[1]!.id, occs[1]!.version, { startUtc: new Date("2027-03-02T14:00:00Z") }));
    expect((await run((tx) => catalog.reattachOccurrence(tx, ctx, edited.id, edited.version))).detached).toBe(false);
  });
});
