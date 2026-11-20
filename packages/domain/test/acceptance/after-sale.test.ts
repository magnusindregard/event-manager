import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, sql, type Tx, withTenant } from "@event-manager/db";
import { migrations, startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { type ActorContext, catalog, inventory, offers, sales, tenancy } from "../../src/index.js";

// Ticketing milestone 4 (docs/ticketing.md): cancelling confirmed tickets, occurrences with
// tickets protected, buyer data and retention, the admin sales view, the outbox events.

let tdb: TestDatabase;
let db: Db;
let ctx: ActorContext;
let other: ActorContext;
let exempt: offers.VatClass;
let web: offers.SalesChannel;
let webCaller: sales.ChannelCaller;

const run = <T>(fn: (tx: Tx) => Promise<T>, as: ActorContext = ctx) => withTenant(db, as, fn);
const MIN = 60_000;
const START = new Date("2027-02-13T18:30:00Z");
const NOW = new Date("2027-02-01T12:00:00Z");
const at = (min: number) => new Date(NOW.getTime() + min * MIN);
const as = (...roles: ActorContext["roles"]): ActorContext => ({ ...ctx, roles });

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  const account = await tenancy.createAccount(db, { slug: "aftersale", name: "Teatret", ownerEmail: "owner@after.test" });
  const userId = await tenancy.login(db, { issuer: "https://idp.test", subject: "owner@after.test", email: "owner@after.test", name: null });
  ctx = { tenantId: account.id, userId, clientId: null, roles: ["owner"] };
  const second = await tenancy.createAccount(db, { slug: "second", name: "Second", ownerEmail: "owner@second.test" });
  const secondUser = await tenancy.login(db, { issuer: "https://idp.test", subject: "owner@second.test", email: "owner@second.test", name: null });
  other = { tenantId: second.id, userId: secondUser, clientId: null, roles: ["owner"] };
  exempt = await run((tx) => offers.createVatClass(tx, ctx, { code: "exempt", label: "Fritatt", ratePct: 0 }));
  web = await run((tx) => offers.createChannel(tx, ctx, { code: "web", name: "Nettbutikk", kind: "ecom", sendTickets: true }));
  await run((tx) => offers.setSkuMapping(tx, ctx, exempt.id, web.id, "TICKET-VAT0"));
  webCaller = { tenantId: ctx.tenantId, channelId: web.id, signingKey: null };
});
afterAll(async () => {
  await db?.destroy();
  await tdb?.stop();
});

async function concert(slug: string, capacity = 10) {
  const event = await run((tx) => catalog.createEvent(tx, ctx, { slug, translations: { nb: { title: "Hamlet" } }, admissionMode: "tickets", registration: { capacity } }));
  const occ = await run((tx) => catalog.createOccurrence(tx, ctx, event.id, { startUtc: START }));
  const make = (n: string, price: number, extra: Partial<offers.OfferInput> = {}) =>
    run(async (tx) => (await offers.createOffer(tx, ctx, event.id, { translations: { nb: { name: n } }, vatClassId: exempt.id, defaultPrice: price, ...extra })).offer!);
  const adult = await make("Voksen", 45000);
  const child = await make("Barn", 20000);
  const family = await make("Familie", 120000, { placesPerUnit: 4, maxPerReservation: 2 });
  await run(async (tx) => catalog.transitionEvent(tx, ctx, event.id, (await catalog.getEvent(tx, event.id)).version, "publish"));
  return { event, occ, adult, child, family };
}

const sell = (lines: sales.ReserveLineInput[], order: string, buyer: sales.BuyerInput | null = null, now = NOW) =>
  run((tx) => sales.reserve(tx, webCaller, { lines, confirm: true, externalOrderRef: order, buyer }, now));
const pool = (occurrenceId: string) => run((tx) => inventory.getPool(tx, occurrenceId));
const events = (type: string, reservationId: string) =>
  run(async (tx) => (await tx.selectFrom("outbox.event").select("data").where("type", "=", type).where("subject", "=", `reservation/${reservationId}`).orderBy("created_at").orderBy("id").execute()).map((e) => e.data));
const admissionStatus = (ticketId: string) =>
  run(async (tx) => (await tx.selectFrom("admission.admission").select("status").where("ticket_id", "=", ticketId).executeTakeFirstOrThrow()).status);

describe("cancelling confirmed tickets", () => {
  it("refunds one ticket, then the rest: admissions void, links dead, places back on sale, reservation cancelled last", async () => {
    const { occ, adult, child } = await concert("refund");
    const r = await sell([{ occurrenceId: occ.id, offerId: adult.id, quantity: 2 }, { occurrenceId: occ.id, offerId: child.id, quantity: 1 }], "ORDER-1", { name: "Kari", email: "kari@example.com" });
    expect(await pool(occ.id)).toMatchObject({ taken: 3, available: 7 });
    const [t1, t2, t3] = r.tickets;

    const partly = await run((tx) => sales.cancelReservation(tx, webCaller, r.id, { ticketIds: [t1!.id], externalRefundRef: "REFUND-1" }, at(10)));
    expect(partly.status).toBe("confirmed");
    expect(partly.tickets.find((t) => t.id === t1!.id)).toMatchObject({
      status: "cancelled", cancelledAt: at(10), cancelledBy: "channel", externalRefundRef: "REFUND-1", ticketToken: null, admissionToken: null,
    });
    expect(partly.tickets.filter((t) => t.status === "valid")).toHaveLength(2);
    expect(await admissionStatus(t1!.id)).toBe("void");
    expect(await admissionStatus(t2!.id)).toBe("valid");
    expect(await run((tx) => sales.ticketPage(tx, t1!.ticketToken!))).toBeNull();
    expect(await run((tx) => sales.ticketPage(tx, t2!.ticketToken!))).not.toBeNull();
    expect(await pool(occ.id)).toMatchObject({ taken: 2, available: 8 });
    expect(await events("ticket.cancelled.v1", r.id)).toEqual([expect.objectContaining({
      ticketIds: [t1!.id], externalOrderRef: "ORDER-1", externalRefundRef: "REFUND-1", by: "channel", amount: { amount: 45000, currency: "NOK" }, remainingTickets: 2,
    })]);

    // Listing a cancelled ticket again is refused, and changes nothing.
    await expect(run((tx) => sales.cancelReservation(tx, webCaller, r.id, { ticketIds: [t1!.id, t2!.id] }, at(11)))).rejects.toMatchObject({ code: "already_cancelled", details: { ticketIds: [t1!.id] } });
    await expect(run((tx) => sales.cancelReservation(tx, webCaller, r.id, { ticketIds: [crypto.randomUUID()] }, at(11)))).rejects.toMatchObject({ code: "validation_failed" });

    const rest = await run((tx) => sales.cancelReservation(tx, webCaller, r.id, { externalRefundRef: "REFUND-2" }, at(12)));
    expect(rest).toMatchObject({ status: "cancelled", cancelledAt: at(12), externalOrderRef: "ORDER-1", confirmedAt: NOW });
    expect(rest.tickets.every((t) => t.status === "cancelled")).toBe(true);
    expect(rest.tickets.find((t) => t.id === t3!.id)).toMatchObject({ externalRefundRef: "REFUND-2" });
    expect(await pool(occ.id)).toMatchObject({ taken: 0, available: 10 });
    expect(await events("reservation.cancelled.v1", r.id)).toEqual([expect.objectContaining({ previousStatus: "confirmed", by: "channel" })]);
    // No buyer details in any of the events.
    expect(JSON.stringify(await events("ticket.cancelled.v1", r.id))).not.toContain("kari");
    await expect(run((tx) => sales.cancelReservation(tx, webCaller, r.id, {}, at(13)))).rejects.toMatchObject({ code: "already_cancelled" });
  });

  it("gives a family ticket's 4 places back", async () => {
    const { occ, family } = await concert("family", 8);
    const r = await sell([{ occurrenceId: occ.id, offerId: family.id, quantity: 2 }], "ORDER-F");
    expect(await pool(occ.id)).toMatchObject({ taken: 8, available: 0 });
    await run((tx) => sales.cancelReservation(tx, webCaller, r.id, { ticketIds: [r.tickets[0]!.id] }, at(1)));
    expect(await pool(occ.id)).toMatchObject({ taken: 4, available: 4 });
  });

  it("refuses once the occurrence has started, unless the occurrence was cancelled", async () => {
    const { occ, adult } = await concert("started");
    const r = await sell([{ occurrenceId: occ.id, offerId: adult.id, quantity: 1 }], "ORDER-S");
    const after = new Date(START.getTime() + MIN);
    await expect(run((tx) => sales.cancelReservation(tx, webCaller, r.id, {}, after))).rejects.toMatchObject({ code: "occurrence_started", details: { occurrenceIds: [occ.id] } });
    await run(async (tx) => catalog.updateOccurrence(tx, ctx, occ.id, (await catalog.getOccurrence(tx, occ.id)).version, { status: "cancelled" }));
    // The tickets of a cancelled occurrence stay as they are until the channel refunds them.
    expect((await run((tx) => sales.getReservation(tx, webCaller, r.id, after))).tickets[0]).toMatchObject({ status: "valid" });
    expect(await run((tx) => sales.cancelReservation(tx, webCaller, r.id, { externalRefundRef: "R" }, after))).toMatchObject({ status: "cancelled" });
  });

  it("still releases a held reservation, and refuses ticket ids and refunds for it", async () => {
    const { occ, adult } = await concert("held");
    const r = await run((tx) => sales.reserve(tx, webCaller, { lines: [{ occurrenceId: occ.id, offerId: adult.id, quantity: 1 }] }, NOW));
    await expect(run((tx) => sales.cancelReservation(tx, webCaller, r.id, { externalRefundRef: "R" }, at(1)))).rejects.toMatchObject({ code: "validation_failed" });
    expect(await run((tx) => sales.cancelReservation(tx, webCaller, r.id, {}, at(1)))).toMatchObject({ status: "cancelled" });
    expect(await pool(occ.id)).toMatchObject({ held: 0, available: 10 });
  });
});

describe("staff: the sales view and cancelling from the admin", () => {
  it("shows held and sold per offer with revenue, the reservations with buyers, and lets box office cancel", async () => {
    const { occ, adult, child, family } = await concert("view", 20);
    const sold = await sell([{ occurrenceId: occ.id, offerId: adult.id, quantity: 2 }, { occurrenceId: occ.id, offerId: child.id, quantity: 1 }], "ORDER-V", { name: "Ola", email: "ola@example.com" });
    await run((tx) => sales.reserve(tx, webCaller, { externalRef: "cart-9", lines: [{ occurrenceId: occ.id, offerId: adult.id, quantity: 3 }] }, NOW));

    const view = await run((tx) => sales.occurrenceSales(tx, as("finance"), occ.id, at(1)));
    expect(view.pool).toMatchObject({ taken: 3, held: 3 });
    expect(view.offers).toEqual([
      { offerId: adult.id, code: "voksen", name: "Voksen", held: 3, sold: 2, cancelled: 0, places: 2, revenue: 90000 },
      { offerId: child.id, code: "barn", name: "Barn", held: 0, sold: 1, cancelled: 0, places: 1, revenue: 20000 },
      { offerId: family.id, code: "familie", name: "Familie", held: 0, sold: 0, cancelled: 0, places: 0, revenue: 0 },
    ]);
    expect(view.reservations.map((r) => [r.status, r.externalRef, r.externalOrderRef])).toEqual([["held", "cart-9", null], ["confirmed", null, "ORDER-V"]]);
    expect(view.reservations[1]).toMatchObject({
      channel: { id: web.id, code: "web", name: "Nettbutikk" }, buyer: { name: "Ola", email: "ola@example.com" }, total: { amount: 110000 }, otherOccurrences: false,
    });
    expect(view.reservations[1]!.tickets).toHaveLength(3);

    // Finance reads but cannot cancel; editors cannot read sales at all.
    await expect(run((tx) => sales.cancelTicketsAsStaff(tx, as("finance"), sold.id, {}, at(2)))).rejects.toMatchObject({ code: "forbidden" });
    await expect(run((tx) => sales.occurrenceSales(tx, as("editor"), occ.id))).rejects.toMatchObject({ code: "forbidden" });

    const c = await run((tx) => sales.cancelTicketsAsStaff(tx, as("box_office"), sold.id, { ticketIds: [sold.tickets[2]!.id], externalRefundRef: "KASSE-7" }, at(2)));
    expect(c.tickets[2]).toMatchObject({ status: "cancelled", cancelledBy: "staff", externalRefundRef: "KASSE-7" });
    const audit = await run((tx) => tx.selectFrom("tenancy.audit_log").select(["action", "diff"]).where("action", "=", "tickets.cancelled").execute());
    expect(audit).toEqual([{ action: "tickets.cancelled", diff: expect.objectContaining({ reservationId: sold.id, ticketIds: [sold.tickets[2]!.id], externalRefundRef: "KASSE-7" }) }]);
    const after = await run((tx) => sales.occurrenceSales(tx, ctx, occ.id, at(3)));
    expect(after.offers[1]).toMatchObject({ sold: 0, cancelled: 1, revenue: 0 });
    expect(await events("ticket.cancelled.v1", sold.id)).toEqual([expect.objectContaining({ by: "staff" })]);

    // Staff cancel only confirmed reservations; the channel releases held ones.
    const held = view.reservations[0]!;
    await expect(run((tx) => sales.cancelTicketsAsStaff(tx, ctx, held.id, {}, at(3)))).rejects.toMatchObject({ code: "conflict" });
  });

  it("keeps another tenant's sales apart", async () => {
    const { occ, adult } = await concert("isolated");
    const r = await sell([{ occurrenceId: occ.id, offerId: adult.id, quantity: 1 }], "ORDER-I");
    await expect(run((tx) => sales.getReservationAsStaff(tx, other, r.id), other)).rejects.toMatchObject({ code: "not_found" });
    await expect(run((tx) => sales.cancelTicketsAsStaff(tx, other, r.id), other)).rejects.toMatchObject({ code: "not_found" });
    await expect(run((tx) => sales.occurrenceSales(tx, other, occ.id), other)).rejects.toMatchObject({ code: "not_found" });
    const otherChannel = await run((tx) => offers.createChannel(tx, other, { code: "web", name: "Web", kind: "ecom" }), other);
    await expect(run((tx) => sales.cancelReservation(tx, { tenantId: other.tenantId, channelId: otherChannel.id, signingKey: null }, r.id), other)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("occurrences with tickets", () => {
  it("cannot be deleted, only cancelled", async () => {
    const { occ, adult } = await concert("protected");
    await sell([{ occurrenceId: occ.id, offerId: adult.id, quantity: 1 }], "ORDER-P");
    await expect(run(async (tx) => catalog.deleteOccurrence(tx, ctx, occ.id, (await catalog.getOccurrence(tx, occ.id)).version)))
      .rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("tickets") });
  });
});

describe("buyer data", () => {
  it("sends tickets only for channels that do, to a buyer with an email", async () => {
    const { occ, adult } = await concert("mail");
    const none = await sell([{ occurrenceId: occ.id, offerId: adult.id, quantity: 1 }], "ORDER-M0");
    expect(await run((tx) => sales.ticketsMessage(tx, none.id))).toBeNull();
    const r = await sell([{ occurrenceId: occ.id, offerId: adult.id, quantity: 2 }], "ORDER-M1", { email: "buyer@example.com" });
    const m = await run((tx) => sales.ticketsMessage(tx, r.id));
    expect(m).toMatchObject({ email: "buyer@example.com", locale: "nb", accountName: "Teatret", externalOrderRef: "ORDER-M1" });
    expect(m!.tickets.map((t) => [t.title, t.partySize])).toEqual([["Hamlet", 1], ["Hamlet", 1]]);
    await run((tx) => sales.cancelReservation(tx, webCaller, r.id, { ticketIds: [r.tickets[0]!.id] }, at(1)));
    expect((await run((tx) => sales.ticketsMessage(tx, r.id)))!.tickets).toHaveLength(1);
    const pos = await run((tx) => offers.createChannel(tx, ctx, { code: "pos", name: "Luke", kind: "pos" }));
    await run((tx) => offers.setSkuMapping(tx, ctx, exempt.id, pos.id, "LUKE"));
    await run(async (tx) => offers.updateOffer(tx, ctx, adult.id, (await offers.getOffer(tx, adult.id)).version, { channelIds: [web.id, pos.id] }));
    const posSale = await run((tx) => sales.reserve(tx, { tenantId: ctx.tenantId, channelId: pos.id, signingKey: null }, {
      lines: [{ occurrenceId: occ.id, offerId: adult.id, quantity: 1 }], confirm: true, externalOrderRef: "POS-1", buyer: { email: "walkup@example.com" },
    }, NOW));
    expect(await run((tx) => sales.ticketsMessage(tx, posSale.id))).toBeNull();
  });

  it("anonymises buyers on the registration schedule, keeping what reconciliation needs", async () => {
    const { occ, adult } = await concert("retention");
    const r = await sell([{ occurrenceId: occ.id, offerId: adult.id, quantity: 1 }], "ORDER-R", { name: "Per", email: "per@example.com", locale: "nb" });
    // Twelve months (the default) after the occurrence ends.
    const early = new Date("2028-02-10T00:00:00Z");
    expect(await run((tx) => sales.applySalesRetention(tx, early))).toMatchObject({ reservationsAnonymised: 0 });
    const late = new Date("2028-02-20T00:00:00Z");
    expect((await run((tx) => sales.applySalesRetention(tx, late))).reservationsAnonymised).toBeGreaterThanOrEqual(1);
    const after = await run((tx) => sales.getReservationAsStaff(tx, ctx, r.id, late));
    expect(after).toMatchObject({ buyer: null, anonymisedAt: late, status: "confirmed", externalOrderRef: "ORDER-R", total: { amount: 45000 } });
    expect(after.lines[0]).toMatchObject({ externalSku: "TICKET-VAT0", unitPrice: 45000 });
    expect(await run((tx) => sales.ticketPage(tx, r.tickets[0]!.ticketToken!))).toBeNull();
    expect(await admissionStatus(r.tickets[0]!.id)).toBe("void");
    expect(await run((tx) => sales.applySalesRetention(tx, late))).toMatchObject({ reservationsAnonymised: 0 });
    const v = await run((tx) => sales.occurrenceSales(tx, ctx, occ.id, late));
    expect(v.reservations[0]).toMatchObject({ buyer: null, anonymisedAt: late });
  });
});

describe("migration 0019", () => {
  it("rolls back with cancelled tickets in place, and forward again", async () => {
    const { occ, adult } = await concert("rollback");
    const r = await sell([{ occurrenceId: occ.id, offerId: adult.id, quantity: 2 }], "RB-1");
    await run((tx) => sales.cancelReservation(tx, webCaller, r.id, { ticketIds: [r.tickets[0]!.id], externalRefundRef: "RB-R" }, at(1)));
    const su = createDb(tdb.superuserUrl) as unknown as Parameters<(typeof migrations)[string]["up"]>[0];
    try {
      await migrations["0019_after_sale"]!.down!(su);
      await migrations["0019_after_sale"]!.up(su);
    } finally {
      await su.destroy();
    }
    // Tickets cancelled before the rollback come back as cancelled by their channel.
    const left = await run((tx) => sql<{ n: number }>`select count(*)::int as n from sales.ticket where status = 'cancelled' and cancelled_by = 'channel'`.execute(tx));
    expect(left.rows[0]!.n).toBeGreaterThan(0);
  });
});
