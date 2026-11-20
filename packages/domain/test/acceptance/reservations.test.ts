import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, sql, type Tx, withoutTenant, withTenant } from "@event-manager/db";
import { migrations, startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { type ActorContext, catalog, inventory, offers, registration, sales, tenancy } from "../../src/index.js";

// Ticketing milestone 3 (docs/ticketing.md): reserve, read, extend, confirm and cancel while held;
// holds per reservation, expiry and the sweeper, snapshots and signatures, tickets and admissions.

let tdb: TestDatabase;
let db: Db;
let ctx: ActorContext;
let exempt: offers.VatClass;
let web: offers.SalesChannel;
let pos: offers.SalesChannel;
let webCaller: sales.ChannelCaller;
let posCaller: sales.ChannelCaller;

const run = <T>(fn: (tx: Tx) => Promise<T>, as: ActorContext = ctx) => withTenant(db, as, fn);
const title = (t: string) => ({ nb: { title: t } });
const name = (n: string) => ({ nb: { name: n } });
const MIN = 60_000;

// Sat 13 February 2027, 19:30 in Oslo.
const START = new Date("2027-02-13T18:30:00Z");
const NOW = new Date("2027-02-01T12:00:00Z");
const at = (min: number) => new Date(NOW.getTime() + min * MIN);

const callerFor = (tenantId: string, channelId: string, secret: string): sales.ChannelCaller => ({
  tenantId, channelId, signingKey: createHash("sha256").update(secret.slice(secret.indexOf("_", 3) + 1)).digest(),
});

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  const account = await tenancy.createAccount(db, { slug: "sales", name: "Sales", ownerEmail: "owner@sales.test" });
  const userId = await tenancy.login(db, { issuer: "https://idp.test", subject: "owner@sales.test", email: "owner@sales.test", name: null });
  ctx = { tenantId: account.id, userId, clientId: null, roles: ["owner"] };
  exempt = await run((tx) => offers.createVatClass(tx, ctx, { code: "exempt", label: "Fritatt", ratePct: 0 }));
  web = await run((tx) => offers.createChannel(tx, ctx, { code: "web", name: "Nettbutikk", kind: "ecom" }));
  pos = await run((tx) => offers.createChannel(tx, ctx, { code: "pos", name: "Billettluke", kind: "pos", holdMinutes: 5 }));
  await run((tx) => offers.setSkuMapping(tx, ctx, exempt.id, web.id, "TICKET-VAT0"));
  await run((tx) => offers.setSkuMapping(tx, ctx, exempt.id, pos.id, "LUKE-VAT0"));
  const webKey = await run((tx) => offers.createChannelKey(tx, ctx, web.id, "Shopify"));
  const posKey = await run((tx) => offers.createChannelKey(tx, ctx, pos.id, "Kasse"));
  webCaller = callerFor(ctx.tenantId, web.id, webKey.secret);
  posCaller = callerFor(ctx.tenantId, pos.id, posKey.secret);
});
afterAll(async () => {
  await db?.destroy();
  await tdb?.stop();
});

/** A published ticketed event with Adult 450, Child 200 and Family 1200 (4 places). */
async function concert(slug: string, capacity = 100) {
  const location = await run((tx) => catalog.createLocation(tx, ctx, { kind: "venue", name: "Hovedscenen" }));
  const event = await run((tx) => catalog.createEvent(tx, ctx, { slug, translations: title("Hamlet"), admissionMode: "tickets", registration: { capacity }, defaultLocationId: location.id }));
  const occ = await run((tx) => catalog.createOccurrence(tx, ctx, event.id, { startUtc: START }));
  const make = (n: string, price: number, extra: Partial<offers.OfferInput> = {}) =>
    run(async (tx) => (await offers.createOffer(tx, ctx, event.id, { translations: name(n), vatClassId: exempt.id, defaultPrice: price, ...extra })).offer!);
  const adult = await make("Voksen", 45000);
  const child = await make("Barn", 20000);
  const family = await make("Familie", 120000, { placesPerUnit: 4, maxPerReservation: 5 });
  await run(async (tx) => catalog.transitionEvent(tx, ctx, event.id, (await catalog.getEvent(tx, event.id)).version, "publish"));
  return { event, occ, adult, child, family };
}

const reserve = (caller: sales.ChannelCaller, input: sales.ReserveInput, now = NOW) => run((tx) => sales.reserve(tx, caller, input, now));
const pool = (occurrenceId: string) => run((tx) => inventory.getPool(tx, occurrenceId));

describe("reserve and confirm", () => {
  it("prices and freezes the lines, holds the places, and confirm issues one ticket per unit with QR codes", async () => {
    const { occ, adult, child } = await concert("hamlet");
    const r = await reserve(webCaller, { externalRef: "cart-1", lines: [{ occurrenceId: occ.id, offerId: adult.id, quantity: 2 }, { occurrenceId: occ.id, offerId: child.id, quantity: 1 }] });
    expect(r).toMatchObject({ status: "held", channelId: web.id, externalRef: "cart-1", expiresAt: at(15), extendLimitAt: at(60), total: { amount: 110000, currency: "NOK" }, tickets: [] });
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0]).toMatchObject({
      lineNo: 1, offerCode: "voksen", quantity: 2, unitPrice: 45000, amount: 90000, vatClassCode: "exempt", vatRatePct: 0, externalSku: "TICKET-VAT0",
      name: "Voksen – Hamlet, lør. 13. feb. 19:30, Hovedscenen", occurrenceStartUtc: START, timezone: "Europe/Oslo", locationName: "Hovedscenen",
    });
    expect(r.signature).toMatch(/^v1\.[A-Za-z0-9_-]{43}$/);
    expect(await pool(occ.id)).toMatchObject({ held: 3, taken: 0, available: 97 });

    const confirmed = await run((tx) => sales.confirm(tx, webCaller, r.id, { externalOrderRef: "ORDER-1001", buyer: { name: "Kari Nordmann", email: "Kari@Example.com" } }, at(5)));
    expect(confirmed).toMatchObject({ status: "confirmed", externalOrderRef: "ORDER-1001", buyer: { name: "Kari Nordmann", email: "kari@example.com", locale: null }, confirmedAt: at(5) });
    expect(confirmed.tickets).toHaveLength(3);
    expect(confirmed.tickets.map((t) => t.lineId)).toEqual([r.lines[0]!.id, r.lines[0]!.id, r.lines[1]!.id]);
    for (const t of confirmed.tickets) expect(t).toMatchObject({ status: "valid", partySize: 1, ticketToken: expect.any(String), admissionToken: expect.any(String) });
    expect(await pool(occ.id)).toMatchObject({ held: 0, taken: 3, available: 97 });

    // The QR payload is the admission token; the ticket token opens the ticket page.
    const t = confirmed.tickets[0]!;
    const claims = await run((tx) => registration.verifyToken(tx, t.admissionToken!, "admission"));
    expect(claims).toMatchObject({ purpose: "admission", subjectId: t.admissionId });
    const page = await run((tx) => sales.ticketPage(tx, t.ticketToken!));
    expect(page).toMatchObject({ ticket: { id: t.id, status: "valid", partySize: 1 }, offerName: "Voksen", title: "Hamlet", accountName: "Sales" });
    expect(await run((tx) => sales.ticketPage(tx, t.admissionToken!))).toBeNull();

    // Confirming again for the same order changes nothing; another order is refused.
    const again = await run((tx) => sales.confirm(tx, webCaller, r.id, { externalOrderRef: "ORDER-1001" }, at(6)));
    expect(again.tickets.map((x) => x.id)).toEqual(confirmed.tickets.map((x) => x.id));
    await expect(run((tx) => sales.confirm(tx, webCaller, r.id, { externalOrderRef: "ORDER-2" }, at(6)))).rejects.toMatchObject({ code: "already_confirmed" });
    await expect(run((tx) => sales.cancelReservation(tx, webCaller, r.id, at(6)))).rejects.toMatchObject({ code: "conflict" });
  });

  it("keeps the reserved price through confirm when the price changes meanwhile", async () => {
    const { occ, adult } = await concert("price-change");
    const r = await reserve(webCaller, { lines: [{ occurrenceId: occ.id, offerId: adult.id, quantity: 1 }] });
    await run((tx) => offers.setOverride(tx, ctx, adult.id, occ.id, { amount: 40000 }));
    const c = await run((tx) => sales.confirm(tx, webCaller, r.id, { externalOrderRef: "O-2" }, at(1)));
    expect(c.lines[0]!.unitPrice).toBe(45000);
    // A new reservation gets the new price.
    expect((await reserve(webCaller, { lines: [{ occurrenceId: occ.id, offerId: adult.id, quantity: 1 }] })).lines[0]!.unitPrice).toBe(40000);
  });

  it("gives a family ticket one admission with party size 4, taking 4 places", async () => {
    const { occ, family } = await concert("family");
    const c = await reserve(posCaller, { confirm: true, externalOrderRef: "POS-1", lines: [{ occurrenceId: occ.id, offerId: family.id, quantity: 1 }] });
    expect(c).toMatchObject({ status: "confirmed", externalOrderRef: "POS-1" });
    expect(c.tickets).toHaveLength(1);
    expect(c.tickets[0]).toMatchObject({ partySize: 4 });
    expect(c.lines[0]).toMatchObject({ placesPerUnit: 4, externalSku: "LUKE-VAT0" });
    expect(await pool(occ.id)).toMatchObject({ held: 0, taken: 4 });
    // confirm: true needs the order.
    await expect(reserve(posCaller, { confirm: true, lines: [{ occurrenceId: occ.id, offerId: family.id, quantity: 1 }] })).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("holds lines across occurrences all or none, and reports the occurrence that is sold out", async () => {
    const { event, occ, adult } = await concert("span", 3);
    const second = await run((tx) => catalog.createOccurrence(tx, ctx, event.id, { startUtc: new Date(START.getTime() + 86_400_000) }));
    await expect(reserve(webCaller, { lines: [{ occurrenceId: occ.id, offerId: adult.id, quantity: 2 }, { occurrenceId: second.id, offerId: adult.id, quantity: 4 }] }))
      .rejects.toMatchObject({ code: "sold_out", details: { occurrenceId: second.id, placesLeft: 3, places: 4, lines: [1] } });
    expect(await pool(occ.id)).toMatchObject({ held: 0 });
    const r = await reserve(webCaller, { lines: [{ occurrenceId: occ.id, offerId: adult.id, quantity: 2 }, { occurrenceId: second.id, offerId: adult.id, quantity: 3 }] });
    expect(r.lines.map((l) => l.occurrenceId)).toEqual([occ.id, second.id]);
    expect(await pool(second.id)).toMatchObject({ held: 3, available: 0 });
  });
});

describe("what may be reserved", () => {
  it("refuses lines the channel may not sell, with stable reasons and the line", async () => {
    const { event, occ, adult, child, family } = await concert("reasons");
    const line = (offerId: string, quantity = 1, occurrenceId = occ.id) => ({ occurrenceId, offerId, quantity });
    await expect(reserve(webCaller, { lines: [line(adult.id), line(family.id, 6)] })).rejects.toMatchObject({ code: "quantity_out_of_range", details: { line: 1, min: 1, max: 5 } });
    await expect(reserve(webCaller, { lines: [line(adult.id), line(adult.id)] })).rejects.toMatchObject({ code: "validation_failed" });

    await run((tx) => offers.updateOffer(tx, ctx, child.id, child.version, { channelIds: [pos.id] }));
    await expect(reserve(webCaller, { lines: [line(child.id)] })).rejects.toMatchObject({ code: "channel_not_allowed", details: { line: 0 } });

    await run((tx) => offers.setOverride(tx, ctx, adult.id, occ.id, { available: false }));
    await expect(reserve(webCaller, { lines: [line(adult.id)] })).rejects.toMatchObject({ code: "offer_unavailable" });
    await run((tx) => offers.setOverride(tx, ctx, adult.id, occ.id, { available: null }));

    const f = await run((tx) => offers.getOffer(tx, family.id));
    await run((tx) => offers.updateOffer(tx, ctx, f.id, f.version, { offSaleMinBefore: 20160 }));
    await expect(reserve(webCaller, { lines: [line(family.id)] })).rejects.toMatchObject({ code: "not_on_sale", details: { line: 0 } });

    await run((tx) => offers.setSkuMapping(tx, ctx, exempt.id, web.id, null));
    await expect(reserve(webCaller, { lines: [line(adult.id)] })).rejects.toMatchObject({ code: "no_sku" });
    await run((tx) => offers.setSkuMapping(tx, ctx, exempt.id, web.id, "TICKET-VAT0"));

    // Started, cancelled and draft occurrences are not on sale; another event's offer is unavailable.
    await expect(reserve(webCaller, { lines: [line(adult.id)] }, START)).rejects.toMatchObject({ code: "not_on_sale" });
    const other = await concert("reasons-other");
    await expect(reserve(webCaller, { lines: [line(other.adult.id)] })).rejects.toMatchObject({ code: "offer_unavailable" });
    await run(async (tx) => catalog.transitionEvent(tx, ctx, event.id, (await catalog.getEvent(tx, event.id)).version, "cancel"));
    await expect(reserve(webCaller, { lines: [line(adult.id)] })).rejects.toMatchObject({ code: "not_on_sale" });

    // An inactive channel cannot act.
    await run(async (tx) => offers.updateChannel(tx, ctx, pos.id, (await offers.getChannel(tx, pos.id)).version, { active: false }));
    await expect(reserve(posCaller, { lines: [line(other.adult.id)] })).rejects.toMatchObject({ code: "forbidden" });
    await run(async (tx) => offers.updateChannel(tx, ctx, pos.id, (await offers.getChannel(tx, pos.id)).version, { active: true }));
    await run(async (tx) => {
      const c = await offers.getOffer(tx, child.id);
      await offers.updateOffer(tx, ctx, c.id, c.version, { channelIds: [web.id, pos.id] });
    });
  });

  it("gives the last place to exactly one of two channels reserving at the same moment", async () => {
    const { occ, adult } = await concert("last-place", 1);
    const results = await Promise.allSettled([
      reserve(webCaller, { lines: [{ occurrenceId: occ.id, offerId: adult.id, quantity: 1 }] }),
      reserve(posCaller, { lines: [{ occurrenceId: occ.id, offerId: adult.id, quantity: 1 }] }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ code: "sold_out", details: { placesLeft: 0 } });
    expect(await pool(occ.id)).toMatchObject({ held: 1, available: 0 });
  });

  it("shows held places in the public availability, without exact numbers for anonymous callers", async () => {
    const { event, occ, adult } = await concert("public-held", 10);
    await reserve(webCaller, { lines: [{ occurrenceId: occ.id, offerId: adult.id, quantity: 9 }] });
    const read = (channelId?: string) =>
      run(async (tx) => (await catalog.listPublicOccurrences(tx, { preview: false, now: NOW, channelId }, { event: event.id, from: new Date("2027-01-01T00:00:00Z"), limit: 10 })).items[0]!);
    expect((await read()).availability).toEqual({ status: "few_left", opensAt: null, closesAt: START.toISOString() });
    expect((await read(web.id)).availability).toMatchObject({ status: "few_left", placesLeft: 1 });
  });
});

describe("expiry, extend and cancel", () => {
  it("extends within 60 minutes of the reservation, revalidating the lines", async () => {
    const { occ, adult } = await concert("extend");
    const r = await reserve(webCaller, { lines: [{ occurrenceId: occ.id, offerId: adult.id, quantity: 1 }] });
    const e = await run((tx) => sales.extendReservation(tx, webCaller, r.id, { minutes: 30 }, at(10)));
    expect(e.expiresAt).toEqual(at(40));
    expect((await run((tx) => sales.extendReservation(tx, webCaller, r.id, {}, at(35)))).expiresAt).toEqual(at(50));
    expect((await run((tx) => sales.extendReservation(tx, webCaller, r.id, { minutes: 30 }, at(48)))).expiresAt).toEqual(at(60));
    await expect(run((tx) => sales.extendReservation(tx, webCaller, r.id, {}, at(55)))).rejects.toMatchObject({ code: "extend_limit" });
    await expect(run((tx) => sales.extendReservation(tx, webCaller, r.id, {}, at(61)))).rejects.toMatchObject({ code: "expired" });

    const r2 = await reserve(webCaller, { lines: [{ occurrenceId: occ.id, offerId: adult.id, quantity: 1 }] });
    await run((tx) => offers.setOverride(tx, ctx, adult.id, occ.id, { available: false }));
    await expect(run((tx) => sales.extendReservation(tx, webCaller, r2.id, {}, at(5)))).rejects.toMatchObject({ code: "offer_unavailable" });
    await run((tx) => offers.setOverride(tx, ctx, adult.id, occ.id, { available: null }));
    // The hold moved with the reservation.
    await run((tx) => sales.extendReservation(tx, webCaller, r2.id, { minutes: 40 }, at(5)));
    const hold = await run((tx) => tx.selectFrom("sales.reservation_hold as rh").innerJoin("inventory.hold as h", "h.id", "rh.hold_id")
      .select("h.expires_at").where("rh.reservation_id", "=", r2.id).executeTakeFirstOrThrow());
    expect(hold.expires_at).toEqual(at(45));
  });

  it("reads as expired after expiresAt; the sweeper releases the places; confirm takes them again if free", async () => {
    const { occ, adult } = await concert("expiry", 2);
    const r = await reserve(webCaller, { lines: [{ occurrenceId: occ.id, offerId: adult.id, quantity: 1 }] });
    expect((await run((tx) => sales.getReservation(tx, webCaller, r.id, at(16)))).status).toBe("expired");

    // Before the sweeper: confirm releases the expired hold and takes the places again.
    const c = await run((tx) => sales.confirm(tx, webCaller, r.id, { externalOrderRef: "LATE-1" }, at(16)));
    expect(c.status).toBe("confirmed");
    expect(await pool(occ.id)).toMatchObject({ held: 0, taken: 1 });

    // After the sweeper, with the place sold to someone else: expired_sold_out.
    const late = await reserve(webCaller, { lines: [{ occurrenceId: occ.id, offerId: adult.id, quantity: 1 }] });
    expect(await withoutTenant(db, (tx) => sales.overdueReservationTenants(tx, at(16)))).toContain(ctx.tenantId);
    // Other tests' held reservations are due too.
    const due = await run((tx) => sales.overdueReservations(tx, at(16)));
    expect(due).toContain(late.id);
    for (const id of due) await run((tx) => sales.expireReservation(tx, ctx.tenantId, id, at(16)));
    expect((await run((tx) => sales.getReservation(tx, webCaller, late.id, at(16)))).status).toBe("expired");
    expect(await pool(occ.id)).toMatchObject({ held: 0, taken: 1, available: 1 });
    await reserve(posCaller, { lines: [{ occurrenceId: occ.id, offerId: adult.id, quantity: 1 }] }, at(16));
    await expect(run((tx) => sales.confirm(tx, webCaller, late.id, { externalOrderRef: "LATE-2" }, at(17)))).rejects.toMatchObject({ code: "expired_sold_out", details: { occurrenceId: occ.id, placesLeft: 0 } });
    expect((await run((tx) => sales.getReservation(tx, webCaller, late.id, at(17)))).status).toBe("expired");
  });

  it("keeps a held occurrence on its frozen time, and refuses to confirm one moved by hand", async () => {
    const event = await run((tx) => catalog.createEvent(tx, ctx, { slug: "serie", translations: title("Serie"), admissionMode: "tickets", registration: { capacity: 10 } }));
    const created = await run((tx) => catalog.createSeries(tx, ctx, event.id, { rrule: "FREQ=DAILY;COUNT=2", dtstartLocal: "2027-03-01T19:00" }, { now: NOW }));
    const adult = (await run((tx) => offers.createOffer(tx, ctx, event.id, { translations: name("Voksen"), vatClassId: exempt.id, defaultPrice: 45000 }))).offer!;
    await run(async (tx) => catalog.transitionEvent(tx, ctx, event.id, (await catalog.getEvent(tx, event.id)).version, "publish"));
    const [first, second] = await run((tx) => catalog.listOccurrences(tx, { eventId: event.id, limit: 10 }));

    // Reserving detaches the occurrence: moving the series leaves it on the time the buyer saw.
    const r = await reserve(webCaller, { lines: [{ occurrenceId: first!.id, offerId: adult.id, quantity: 1 }] });
    expect((await run((tx) => catalog.getOccurrence(tx, first!.id))).detached).toBe(true);
    const moved = await run((tx) => catalog.updateSeries(tx, ctx, created.series!.id, created.series!.version, { dtstartLocal: "2027-03-01T20:00" }, { now: NOW }));
    expect(moved.changes.counts).toMatchObject({ conflicts: 1 });
    expect((await run((tx) => catalog.getOccurrence(tx, first!.id))).startUtc).toEqual(r.lines[0]!.occurrenceStartUtc);
    expect((await run((tx) => sales.confirm(tx, webCaller, r.id, { externalOrderRef: "SERIE-1" }, at(1)))).status).toBe("confirmed");

    // Staff can still move a held occurrence by hand; confirm then refuses to sell the old time.
    const occ = await run((tx) => catalog.getOccurrence(tx, second!.id));
    const r2 = await reserve(webCaller, { lines: [{ occurrenceId: occ.id, offerId: adult.id, quantity: 1 }] });
    const v = (await run((tx) => catalog.getOccurrence(tx, occ.id))).version;
    await run((tx) => catalog.updateOccurrence(tx, ctx, occ.id, v, { startUtc: new Date(occ.startUtc.getTime() + 3_600_000) }));
    await expect(run((tx) => sales.confirm(tx, webCaller, r2.id, { externalOrderRef: "SERIE-2" }, at(1)))).rejects.toMatchObject({
      code: "schedule_changed", details: { occurrenceId: occ.id, reservedStartUtc: occ.startUtc.toISOString() },
    });
    expect((await run((tx) => sales.getReservation(tx, webCaller, r2.id, at(1)))).status).toBe("held");

    // Cancelled, its lines still point at the occurrence: reattach keeps it detached, so
    // shortening the series reports a conflict instead of deleting a referenced occurrence.
    await run((tx) => sales.cancelReservation(tx, webCaller, r2.id, at(2)));
    const edited = await run((tx) => catalog.getOccurrence(tx, occ.id));
    expect((await run((tx) => catalog.reattachOccurrence(tx, ctx, occ.id, edited.version))).detached).toBe(true);
    const series = await run((tx) => catalog.getSeries(tx, created.series!.id));
    const shortened = await run((tx) => catalog.updateSeries(tx, ctx, series.id, series.version, { rrule: "FREQ=DAILY;COUNT=1" }, { now: NOW }));
    expect(shortened.changes.counts).toMatchObject({ deleted: 0 });
    expect((await run((tx) => catalog.getOccurrence(tx, occ.id))).id).toBe(occ.id);
  });

  it("cancels a held reservation and releases its places", async () => {
    const { occ, adult } = await concert("cancel", 5);
    const r = await reserve(webCaller, { lines: [{ occurrenceId: occ.id, offerId: adult.id, quantity: 3 }] });
    const c = await run((tx) => sales.cancelReservation(tx, webCaller, r.id, at(1)));
    expect(c).toMatchObject({ status: "cancelled", cancelledAt: at(1) });
    expect(await pool(occ.id)).toMatchObject({ held: 0, available: 5 });
    await expect(run((tx) => sales.cancelReservation(tx, webCaller, r.id, at(2)))).rejects.toMatchObject({ code: "already_cancelled" });
    await expect(run((tx) => sales.confirm(tx, webCaller, r.id, { externalOrderRef: "X" }, at(2)))).rejects.toMatchObject({ code: "already_cancelled" });
  });
});

describe("channels and signatures", () => {
  it("lets a channel see only its own reservations, and signs for the key that asks", async () => {
    const { occ, adult } = await concert("own");
    const r = await reserve(webCaller, { lines: [{ occurrenceId: occ.id, offerId: adult.id, quantity: 1 }] });
    await expect(run((tx) => sales.getReservation(tx, posCaller, r.id))).rejects.toMatchObject({ code: "not_found" });
    await expect(run((tx) => sales.confirm(tx, posCaller, r.id, { externalOrderRef: "X" }))).rejects.toMatchObject({ code: "not_found" });

    // A connector rebuilds the signed text from the response and checks it with its own key.
    const got = await run((tx) => sales.getReservation(tx, webCaller, r.id, NOW));
    const line = got.lines[0]!;
    expect(line.signature).toBe(sales.signSnapshot(webCaller.signingKey!, sales.lineSignatureText(r.id, line)));
    expect(got.signature).toBe(sales.signSnapshot(webCaller.signingKey!, sales.reservationSignatureText(got, [line.signature!])));
    expect(sales.signSnapshot(webCaller.signingKey!, sales.lineSignatureText(r.id, { ...line, unitPrice: 1 }))).not.toBe(line.signature);
    // Another key of the channel gets its own signature over the same snapshot.
    const other = { ...webCaller, signingKey: Buffer.alloc(32, 7) };
    expect((await run((tx) => sales.getReservation(tx, other, r.id, NOW))).lines[0]!.signature).not.toBe(line.signature);
  });
});

describe("migration 0018", () => {
  it("rolls back with tickets and registrations in place, and forward again", async () => {
    const { occ, adult } = await concert("rollback");
    await reserve(webCaller, { confirm: true, externalOrderRef: "RB-1", lines: [{ occurrenceId: occ.id, offerId: adult.id, quantity: 2 }] });
    const su = createDb(tdb.superuserUrl) as unknown as Parameters<(typeof migrations)[string]["up"]>[0];
    try {
      await migrations["0018_reservations"]!.down!(su);
      const left = await sql<{ n: number }>`select count(*)::int as n from admission.admission where registration_id is null`.execute(su);
      expect(left.rows).toEqual([{ n: 0 }]);
      await migrations["0018_reservations"]!.up(su);
    } finally {
      await su.destroy();
    }
    expect(await run((tx) => tx.selectFrom("sales.ticket").select("id").execute())).toEqual([]);
    // The sold places went back with the tickets.
    expect(await pool(occ.id)).toMatchObject({ held: 0, taken: 0 });
  });
});
