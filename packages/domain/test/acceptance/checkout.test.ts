import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, sql, type Tx, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { FakeVipps } from "@event-manager/vipps";
import { type ActorContext, catalog, DomainError, inventory, offers, payments, sales, tenancy } from "../../src/index.js";

// Hosted checkout milestone 2 (docs/checkout.md): authorise → confirm → capture with Vipps
// MobilePay, against FakeVipps, real Postgres and a fixed clock.

let tdb: TestDatabase;
let db: Db;
let ctx: ActorContext;
let other: ActorContext;
let vat12: offers.VatClass;
let web: offers.SalesChannel;
const vipps = new FakeVipps();
const deps = { provider: vipps, attendeeUrl: "https://billett.example.test" };
const providerDeps = { provider: vipps, webhookUrl: null };

const run = <T>(fn: (tx: Tx) => Promise<T>, as: ActorContext = ctx) => withTenant(db, as, fn);
const MIN = 60_000;
const START = new Date("2027-02-13T18:30:00Z");
const NOW = new Date("2027-02-01T12:00:00Z");
const at = (min: number) => new Date(NOW.getTime() + min * MIN);
const buyer = { name: "Kari Nordmann", email: "Kari@Example.com", phone: "912 34 567" };
const keys = { environment: "test" as const, merchantSerialNumber: "123456", clientId: "c", clientSecret: "s", subscriptionKey: "k" };

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl, { max: 10 });
  const account = await tenancy.createAccount(db, { slug: "checkout", name: "Teatret", ownerEmail: "owner@checkout.test" });
  const userId = await tenancy.login(db, { issuer: "https://idp.test", subject: "owner@checkout.test", email: "owner@checkout.test", name: null });
  ctx = { tenantId: account.id, userId, clientId: null, roles: ["owner"] };
  const b = await tenancy.createAccount(db, { slug: "checkout-b", name: "B", ownerEmail: "owner@b.test" });
  other = { tenantId: b.id, userId: null, clientId: null, roles: ["owner"] };

  vat12 = await run((tx) => offers.createVatClass(tx, ctx, { code: "culture", label: "Kultur 12 %", ratePct: 12 }));
  web = await run((tx) => offers.createChannel(tx, ctx, { code: "web", name: "Nettbutikk", kind: "ecom" }));
  await run((tx) => offers.setSkuMapping(tx, ctx, vat12.id, web.id, "TICKET-12"));
  await payments.connectVipps(db, ctx, keys, providerDeps);
  await run(async (tx) => {
    await tx.updateTable("tenancy.account").set({ merchant_legal_name: "Teatret AS", merchant_org_number: "974760673", merchant_vat_registered: true }).execute();
  });
});
afterAll(async () => {
  await db?.destroy();
  await tdb?.stop();
});

/** A published ticketed event with Adult 450 and Child 200, sold on the hosted checkout and the web shop. */
async function concert(slug: string, capacity = 100) {
  const hosted = await run((tx) => offers.enableHostedChannel(tx, ctx));
  const event = await run((tx) => catalog.createEvent(tx, ctx, { slug, translations: { nb: { title: "Hamlet" } }, admissionMode: "tickets", registration: { capacity } }));
  const occ = await run((tx) => catalog.createOccurrence(tx, ctx, event.id, { startUtc: START }));
  const make = (n: string, price: number) =>
    run(async (tx) => (await offers.createOffer(tx, ctx, event.id, { translations: { nb: { name: n } }, vatClassId: vat12.id, defaultPrice: price, channelIds: [hosted.id, web.id] })).offer!);
  const adult = await make("Voksen", 45000);
  const child = await make("Barn", 20000);
  await run(async (tx) => catalog.transitionEvent(tx, ctx, event.id, (await catalog.getEvent(tx, event.id)).version, "publish"));
  return { event, occ, adult, child, hosted };
}

const start = (occurrenceId: string, lines: { offerId: string; quantity: number }[], now = NOW) =>
  payments.startCheckout(db, ctx.tenantId, { occurrenceId, lines, buyer, locale: "nb" }, deps, now);
const pay = async (occurrenceId: string, lines: { offerId: string; quantity: number }[], now = NOW) => {
  const s = await start(occurrenceId, lines, now);
  if (s.kind !== "pay") throw new Error("expected a payment");
  const row = await run((tx) => tx.selectFrom("payments.payment").selectAll().where("id", "=", s.paymentId).executeTakeFirstOrThrow());
  return { ...s, row };
};
const process = (paymentId: string, now = at(2)) => payments.processPayment(db, ctx.tenantId, paymentId, deps, now);
const pool = (occurrenceId: string) => run((tx) => inventory.getPool(tx, occurrenceId));
const reservation = (id: string) => run((tx) => tx.selectFrom("sales.reservation").selectAll().where("id", "=", id).executeTakeFirstOrThrow());

describe("the buy page", () => {
  it("shows the occurrence's offers on the hosted channel at their prices, and is open once Vipps is connected", async () => {
    const { occ } = await concert("side");
    const page = await run((tx) => payments.checkoutPage(tx, occ.id, "nb", NOW));
    expect(page).toMatchObject({ open: true, accountName: "Teatret", locale: "nb" });
    expect(page!.occurrence.offers.map((o) => [o.name, o.price.amount, o.onSale])).toEqual([["Voksen", 45000, true], ["Barn", 20000, true]]);
    // The hosted channel got a default SKU for the VAT class.
    const skus = await run((tx) => offers.listSkuMappings(tx));
    expect(skus.filter((m) => m.vatClassId === vat12.id).map((m) => m.externalSku).sort()).toEqual(["TICKET-12", "TICKET-CULTURE"]);
  });

  it("gives occurrences sold on the hosted checkout a checkoutUrl in the public API", async () => {
    const { event, occ, adult, child, hosted } = await concert("public-link");
    const read = async () => (await run((tx) => catalog.listPublicOccurrences(tx, { preview: false, attendeeUrl: "https://billett.example.test/", now: NOW }, { event: event.id, from: NOW, limit: 5 }))).items[0]!.admission;
    expect(await read()).toEqual({ mode: "tickets", checkoutUrl: `https://billett.example.test/b/${occ.id}` });
    // Without the attendee URL the API cannot link anywhere.
    const noUrl = await run((tx) => catalog.listPublicOccurrences(tx, { preview: false, now: NOW }, { event: event.id, from: NOW, limit: 5 }));
    expect(noUrl.items[0]!.admission).toEqual({ mode: "tickets", checkoutUrl: null });
    // Offers taken off the hosted channel: no link.
    for (const o of [adult, child]) {
      const cur = await run((tx) => offers.getOffer(tx, o.id));
      await run((tx) => offers.updateOffer(tx, ctx, o.id, cur.version, { channelIds: [web.id] }));
    }
    expect(await read()).toEqual({ mode: "tickets", checkoutUrl: null });
    const cur = await run((tx) => offers.getOffer(tx, adult.id));
    await run((tx) => offers.updateOffer(tx, ctx, adult.id, cur.version, { channelIds: [hosted.id, web.id] }));
    expect((await read()) as { checkoutUrl: string | null }).toMatchObject({ checkoutUrl: expect.stringContaining(occ.id) });
  });
});

describe("happy path", () => {
  it("reserves, sends the buyer to Vipps, and on approval issues the tickets and captures once", async () => {
    const { occ, adult, child } = await concert("hamlet");
    const s = await pay(occ.id, [{ offerId: adult.id, quantity: 2 }, { offerId: child.id, quantity: 1 }]);
    expect(s.redirectUrl).toBe(`https://fake-vipps.test/landing/${s.row.reference}`);
    expect(s.row).toMatchObject({ state: "created", amount: 110000, currency: "NOK", buyer_email: "kari@example.com", buyer_phone: "4791234567" });
    const created = vipps.payments.get(s.row.reference)!;
    expect(created.returnUrl).toBe(`https://billett.example.test/b/return/${s.token}`);
    expect(created.description).toMatch(/^Teatret: Voksen – Hamlet/);
    // The hold outlives the Vipps payment.
    const held = await reservation(s.row.reservation_id);
    expect(held).toMatchObject({ status: "held" });
    expect(held.expires_at.getTime()).toBeGreaterThanOrEqual(at(20).getTime());
    expect(await pool(occ.id)).toMatchObject({ held: 3, taken: 0 });

    // Not approved yet: nothing happens.
    expect(await process(s.paymentId)).toBe("created");

    vipps.approve(s.row.reference);
    expect(await process(s.paymentId)).toBe("captured");
    const r = await reservation(s.row.reservation_id);
    expect(r).toMatchObject({ status: "confirmed", external_order_ref: s.row.reference, buyer_email: "kari@example.com", buyer_name: "Kari Nordmann" });
    expect(await pool(occ.id)).toMatchObject({ held: 0, taken: 3 });
    expect(vipps.callsFor(s.row.reference, "capture")).toEqual([expect.objectContaining({ amount: 110000, idempotencyKey: `capture-${s.paymentId}` })]);
    expect((await vipps.getPayment(keys, s.row.reference)).aggregate.capturedAmount.value).toBe(110000);

    // The return page's view.
    const status = await run((tx) => payments.checkoutStatus(tx, s.token, at(3)));
    expect(status).toMatchObject({ state: "captured", reference: s.row.reference, vat: [{ ratePct: 12, amount: 11786 }] });
    expect(status!.reservation.tickets).toHaveLength(3);

    // The receipt: lines, VAT per rate, merchant details.
    const receipt = await run((tx) => payments.receiptFor(tx, s.paymentId));
    expect(receipt).toMatchObject({
      total: { amount: 110000, currency: "NOK" }, vat: [{ ratePct: 12, amount: 11786 }],
      merchant: { name: "Teatret", legalName: "Teatret AS", orgNumber: "974760673", vatRegistered: true },
      buyer: { email: "kari@example.com" }, locale: "nb",
    });
    expect(receipt!.lines.map((l) => [l.quantity, l.amount, l.vat])).toEqual([[2, 90000, 9643], [1, 20000, 2143]]);
    await payments.sendReceiptToProvider(db, ctx.tenantId, s.paymentId, deps);
    expect(vipps.payments.get(s.row.reference)!.receipt).toMatchObject({ currency: "NOK", receiptNumber: s.row.reference });
    expect(vipps.payments.get(s.row.reference)!.receipt!.lines[0]).toMatchObject({ totalAmount: 90000, totalTaxAmount: 9643, totalAmountExcludingTax: 80357, taxPercentage: 12 });

    const events = await run((tx) => tx.selectFrom("outbox.event").select("type").where("subject", "=", `payment/${s.paymentId}`).orderBy("id").execute());
    expect(events.map((e) => e.type)).toEqual(["payment.authorized.v1", "payment.captured.v1"]);
  });
});

describe("the buyer rejects", () => {
  it("releases the hold and fails the payment", async () => {
    const { occ, adult } = await concert("rejected");
    const s = await pay(occ.id, [{ offerId: adult.id, quantity: 2 }]);
    vipps.reject(s.row.reference);
    expect(await process(s.paymentId)).toBe("failed");
    expect(await reservation(s.row.reservation_id)).toMatchObject({ status: "cancelled" });
    expect(await pool(occ.id)).toMatchObject({ held: 0, taken: 0 });
    expect(vipps.callsFor(s.row.reference, "capture")).toEqual([]);
    // Settled: processing again changes nothing.
    expect(await process(s.paymentId)).toBe("failed");
  });

  it("releases the hold when the payment expires unanswered", async () => {
    const { occ, adult } = await concert("expired-unanswered");
    const s = await pay(occ.id, [{ offerId: adult.id, quantity: 1 }]);
    vipps.expire(s.row.reference);
    expect(await process(s.paymentId)).toBe("expired");
    expect(await pool(occ.id)).toMatchObject({ held: 0, taken: 0 });
  });
});

describe("authorised after the hold expired", () => {
  it("confirms and captures when the places are still free", async () => {
    const { occ, adult } = await concert("late-free");
    const s = await pay(occ.id, [{ offerId: adult.id, quantity: 2 }]);
    await run((tx) => sales.expireReservation(tx, ctx.tenantId, s.row.reservation_id, at(25)));
    expect(await reservation(s.row.reservation_id)).toMatchObject({ status: "expired" });
    vipps.approve(s.row.reference);
    expect(await process(s.paymentId, at(26))).toBe("captured");
    expect(await reservation(s.row.reservation_id)).toMatchObject({ status: "confirmed" });
    expect(await pool(occ.id)).toMatchObject({ taken: 2 });
  });

  it("cancels the authorisation, so no money moves, when the event sold out meanwhile", async () => {
    const { occ, adult } = await concert("late-sold-out", 2);
    const s = await pay(occ.id, [{ offerId: adult.id, quantity: 2 }]);
    await run((tx) => sales.expireReservation(tx, ctx.tenantId, s.row.reservation_id, at(25)));
    // Someone else buys the last places in the web shop.
    const webCaller = { tenantId: ctx.tenantId, channelId: web.id, signingKey: null };
    await run((tx) => sales.reserve(tx, webCaller, { lines: [{ occurrenceId: occ.id, offerId: adult.id, quantity: 2 }], confirm: true, externalOrderRef: "WEB-1" }, at(26)));

    vipps.approve(s.row.reference);
    expect(await process(s.paymentId, at(27))).toBe("cancelled");
    expect(vipps.callsFor(s.row.reference, "cancel")).toHaveLength(1);
    expect(vipps.callsFor(s.row.reference, "capture")).toEqual([]);
    expect((await vipps.getPayment(keys, s.row.reference)).aggregate.cancelledAmount.value).toBe(90000);
    const r = await reservation(s.row.reservation_id);
    expect(r.status).toBe("cancelled");
    const tickets = await run((tx) => tx.selectFrom("sales.ticket").select("id").where("reservation_id", "=", r.id).execute());
    expect(tickets).toEqual([]);
    const row = await run((tx) => tx.selectFrom("payments.payment").select("failure_reason").where("id", "=", s.paymentId).executeTakeFirstOrThrow());
    expect(row.failure_reason).toMatch(/expired_sold_out/);
  });
});

describe("the webhook and the return page together", () => {
  it("confirm and capture happen exactly once", async () => {
    const { occ, adult } = await concert("twice");
    const s = await pay(occ.id, [{ offerId: adult.id, quantity: 1 }]);
    vipps.approve(s.row.reference);
    const results = await Promise.all([process(s.paymentId), process(s.paymentId), process(s.paymentId)]);
    expect(results).toEqual(["captured", "captured", "captured"]);
    expect(await process(s.paymentId)).toBe("captured");
    expect(vipps.callsFor(s.row.reference, "capture")).toHaveLength(1);
    const confirmed = await run((tx) => tx.selectFrom("outbox.event").select("id").where("type", "=", "reservation.confirmed.v1").where("subject", "=", `reservation/${s.row.reservation_id}`).execute());
    expect(confirmed).toHaveLength(1);
    const tickets = await run((tx) => tx.selectFrom("sales.ticket").select("id").where("reservation_id", "=", s.row.reservation_id).execute());
    expect(tickets).toHaveLength(1);
  });

  it("finishes a capture that Vipps took but we did not record", async () => {
    const { occ, adult } = await concert("crashed");
    const s = await pay(occ.id, [{ offerId: adult.id, quantity: 1 }]);
    vipps.approve(s.row.reference);
    vipps.down = true;
    expect(await process(s.paymentId)).toBe("created");
    vipps.down = false;
    // Simulate: confirmed and captured, then the process died before recording the capture.
    await process(s.paymentId);
    await run((tx) => tx.updateTable("payments.payment").set({ state: "authorized", captured_at: null }).where("id", "=", s.paymentId).execute());
    expect(await process(s.paymentId)).toBe("captured");
    expect(vipps.callsFor(s.row.reference, "capture")).toHaveLength(1);
  });
});

describe("when it cannot start", () => {
  it("releases the places when Vipps cannot create the payment", async () => {
    const { occ, adult } = await concert("vipps-down");
    vipps.down = true;
    const err = await start(occ.id, [{ offerId: adult.id, quantity: 2 }]).catch((e: unknown) => e);
    vipps.down = false;
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe("conflict");
    expect(await pool(occ.id)).toMatchObject({ held: 0, taken: 0 });
    const failed = await run((tx) => tx.selectFrom("payments.payment as p").innerJoin("sales.reservation as r", "r.id", "p.reservation_id")
      .select(["p.state", "r.status"]).where("r.status", "=", "cancelled").where("p.failure_reason", "like", "Vipps could not create%").execute());
    expect(failed.length).toBeGreaterThan(0);
  });

  it("checks the buyer and the lines", async () => {
    const { occ, adult } = await concert("checks");
    await expect(payments.startCheckout(db, ctx.tenantId, { occurrenceId: occ.id, lines: [{ offerId: adult.id, quantity: 1 }], buyer: { name: "", email: "x@y.no" } }, deps, NOW)).rejects.toMatchObject({ code: "validation_failed" });
    await expect(payments.startCheckout(db, ctx.tenantId, { occurrenceId: occ.id, lines: [{ offerId: adult.id, quantity: 0 }], buyer }, deps, NOW)).rejects.toMatchObject({ code: "validation_failed", details: { field: "lines" } });
    await expect(start(occ.id, [{ offerId: adult.id, quantity: 21 }])).rejects.toMatchObject({ code: "quantity_out_of_range" });
    expect(payments.normalizePhone("+47 912 34 567")).toBe("4791234567");
    expect(payments.normalizePhone("0046701234567")).toBe("46701234567");
    expect(() => payments.normalizePhone("12")).toThrow(DomainError);
  });

  it("is closed when the hosted channel is deactivated", async () => {
    const { occ, adult, hosted } = await concert("closed");
    const ch = await run((tx) => offers.getChannel(tx, hosted.id));
    await run((tx) => offers.updateChannel(tx, ctx, hosted.id, ch.version, { active: false }));
    await expect(start(occ.id, [{ offerId: adult.id, quantity: 1 }])).rejects.toMatchObject({ code: "not_on_sale" });
    expect((await run((tx) => payments.checkoutPage(tx, occ.id, "nb", NOW)))?.open ?? false).toBe(false);
    await run((tx) => offers.enableHostedChannel(tx, ctx));
  });
});

describe("free tickets", () => {
  it("confirms at once without Vipps", async () => {
    const { event, occ } = await concert("free");
    const hosted = (await run((tx) => offers.hostedChannel(tx)))!;
    const free = (await run((tx) => offers.createOffer(tx, ctx, event.id, { translations: { nb: { name: "Gratis" } }, vatClassId: vat12.id, defaultPrice: 0, channelIds: [hosted.id] }))).offer!;
    const s = await start(occ.id, [{ offerId: free.id, quantity: 2 }]);
    expect(s.kind).toBe("free");
    const status = await run((tx) => payments.checkoutStatus(tx, s.token, NOW));
    expect(status).toMatchObject({ state: "free", reservation: { status: "confirmed", buyer: { email: "kari@example.com" } } });
    expect(status!.reservation.tickets).toHaveLength(2);
  });
});

describe("tenants", () => {
  it("another account sees none of it and cannot process the payment", async () => {
    const { occ, adult } = await concert("tenants");
    const s = await pay(occ.id, [{ offerId: adult.id, quantity: 1 }]);
    expect(await payments.processPayment(db, other.tenantId, s.paymentId, deps, NOW)).toBeNull();
    expect(await withTenant(db, other, (tx) => tx.selectFrom("payments.payment").select("id").execute())).toEqual([]);
    expect(await withTenant(db, other, (tx) => payments.checkoutStatus(tx, s.token, NOW))).toBeNull();
    // Without the hosted channel there is no buy page.
    expect(await withTenant(db, other, (tx) => payments.checkoutPage(tx, occ.id, "nb", NOW))).toBeNull();
  });

  it("finds the accounts with open payments for the reconcile job", async () => {
    const open = await db.transaction().execute((tx) => payments.openPaymentTenants(tx, at(60)));
    expect(open).toContain(ctx.tenantId);
    await sql`select 1`.execute(db);
  });
});

describe("refunds", () => {
  const staff = (): ActorContext => ({ ...ctx, roles: ["box_office"] });
  async function paid(slug: string, quantity = 3) {
    const { occ, adult } = await concert(slug);
    const s = await pay(occ.id, [{ offerId: adult.id, quantity }]);
    vipps.approve(s.row.reference);
    expect(await process(s.paymentId)).toBe("captured");
    const tickets = await run((tx) => tx.selectFrom("sales.ticket").select("id").where("reservation_id", "=", s.row.reservation_id).orderBy("created_at").orderBy("id").execute());
    return { ...s, occ, tickets: tickets.map((t) => t.id) };
  }
  const refund = (reservationId: string, input: payments.RefundInput, as: ActorContext = staff()) => payments.refundTickets(db, as, reservationId, input, deps, at(10));

  it("refunds some tickets, then the rest, through Vipps, and puts the places back on sale", async () => {
    const s = await paid("refund-partial");
    const one = await refund(s.row.reservation_id, { ticketIds: [s.tickets[0]!], amount: 45000 });
    expect(one).toMatchObject({ state: "done", amount: 45000, ticketIds: [s.tickets[0]] });
    expect(vipps.callsFor(s.row.reference, "refund")).toEqual([expect.objectContaining({ amount: 45000, idempotencyKey: one!.reference })]);
    const ticket = await run((tx) => tx.selectFrom("sales.ticket").select(["status", "external_refund_ref", "cancelled_by"]).where("id", "=", s.tickets[0]!).executeTakeFirstOrThrow());
    expect(ticket).toEqual({ status: "cancelled", external_refund_ref: one!.reference, cancelled_by: "staff" });
    expect(await pool(s.occ.id)).toMatchObject({ taken: 2 });

    const rest = await refund(s.row.reservation_id, { amount: 90000 });
    expect(rest).toMatchObject({ state: "done", amount: 90000 });
    expect((await vipps.getPayment(keys, s.row.reference)).aggregate.refundedAmount.value).toBe(135000);
    expect(await reservation(s.row.reservation_id)).toMatchObject({ status: "cancelled" });
    const summary = (await run((tx) => payments.paymentSummaries(tx, [s.row.reservation_id]))).get(s.row.reservation_id)!;
    expect(summary).toMatchObject({ state: "captured", refunded: 135000, amount: { amount: 135000 } });
    expect(summary.refunds).toHaveLength(2);
    const events = await run((tx) => tx.selectFrom("outbox.event").select("type").where("subject", "=", `payment/${s.paymentId}`).where("type", "=", "payment.refunded.v1").execute());
    expect(events).toHaveLength(2);
  });

  it("refuses an amount that is not what the tickets cost, and changes nothing", async () => {
    const s = await paid("refund-amount");
    await expect(refund(s.row.reservation_id, { amount: 45000 })).rejects.toMatchObject({ code: "conflict", details: { amount: 135000 } });
    expect(await pool(s.occ.id)).toMatchObject({ taken: 3 });
    expect(vipps.callsFor(s.row.reference, "refund")).toEqual([]);
  });

  it("keeps a refund Vipps did not answer pending, and sends it again with the same key", async () => {
    const s = await paid("refund-down", 1);
    vipps.down = true;
    const r = await refund(s.row.reservation_id, { amount: 45000 });
    vipps.down = false;
    expect(r).toMatchObject({ state: "pending" });
    // The tickets are cancelled already; the money follows.
    expect(await pool(s.occ.id)).toMatchObject({ taken: 0 });
    expect(await run((tx) => payments.pendingRefunds(tx, at(60)))).toContain(r!.id);
    expect(await db.transaction().execute((tx) => payments.openPaymentTenants(tx, at(60)))).toContain(ctx.tenantId);
    const sent = await payments.sendRefund(db, ctx.tenantId, r!.id, deps);
    expect(sent.state).toBe("done");
    expect(vipps.callsFor(s.row.reference, "refund")).toEqual([expect.objectContaining({ idempotencyKey: r!.reference })]);
    // Sent again: nothing more moves.
    expect((await payments.sendRefund(db, ctx.tenantId, r!.id, deps)).state).toBe("done");
    expect(vipps.callsFor(s.row.reference, "refund")).toHaveLength(1);
  });

  it("records a refund Vipps refused as failed, and staff can retry it", async () => {
    const s = await paid("refund-refused", 1);
    // Vipps refuses: the merchant refunded the money in the Vipps portal already.
    await vipps.refund(keys, s.row.reference, { currency: "NOK", value: 45000 }, "portal-refund");
    const r = await refund(s.row.reservation_id, { amount: 45000 });
    expect(r).toMatchObject({ state: "failed", failureReason: expect.stringMatching(/more than captured/) });
    vipps.payments.get(s.row.reference)!.refunded = 0;
    expect((await payments.retryRefund(db, staff(), r!.id, deps)).state).toBe("done");
  });

  it("refuses reservations not paid in the hosted checkout, and staff without sales.write", async () => {
    const { occ, adult } = await concert("refund-web");
    const webCaller = { tenantId: ctx.tenantId, channelId: web.id, signingKey: null };
    const r = await run((tx) => sales.reserve(tx, webCaller, { lines: [{ occurrenceId: occ.id, offerId: adult.id, quantity: 1 }], confirm: true, externalOrderRef: "WEB-9" }, NOW));
    await expect(refund(r.id, { amount: 45000 })).rejects.toMatchObject({ code: "conflict" });
    const s = await paid("refund-finance", 1);
    await expect(refund(s.row.reservation_id, { amount: 45000 }, { ...ctx, roles: ["finance"] })).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("when Vipps refuses or holds a change", () => {
  it("calls the order off when Vipps refuses the capture: the authorisation is cancelled and the tickets go", async () => {
    const { occ, adult } = await concert("capture-refused");
    const s = await pay(occ.id, [{ offerId: adult.id, quantity: 2 }]);
    vipps.approve(s.row.reference);
    vipps.failNext("capture", 400);
    expect(await process(s.paymentId)).toBe("cancelled");
    expect((await vipps.getPayment(keys, s.row.reference)).aggregate).toMatchObject({ capturedAmount: { value: 0 }, cancelledAmount: { value: 90000 } });
    expect(await reservation(s.row.reservation_id)).toMatchObject({ status: "cancelled" });
    expect(await pool(occ.id)).toMatchObject({ taken: 0, held: 0 });
    const row = await run((tx) => tx.selectFrom("payments.payment").select("failure_reason").where("id", "=", s.paymentId).executeTakeFirstOrThrow());
    expect(row.failure_reason).toMatch(/refused the capture/);
  });

  it("retries a capture Vipps holds (423) instead of calling the order off", async () => {
    const { occ, adult } = await concert("capture-locked");
    const s = await pay(occ.id, [{ offerId: adult.id, quantity: 1 }]);
    vipps.approve(s.row.reference);
    vipps.failNext("capture", 423);
    expect(await process(s.paymentId)).toBe("authorized");
    expect(await process(s.paymentId)).toBe("captured");
  });

  it("keeps the tickets' links and admissions shut until the capture, also for staff", async () => {
    const { occ, adult } = await concert("pending-admissions");
    const s = await pay(occ.id, [{ offerId: adult.id, quantity: 2 }]);
    vipps.approve(s.row.reference);
    vipps.failNext("capture", 423);
    expect(await process(s.paymentId)).toBe("authorized");
    const staffView = () => run((tx) => sales.getReservationAsStaff(tx, ctx, s.row.reservation_id, at(3)));
    const statuses = () => run((tx) => tx.selectFrom("admission.admission as a").innerJoin("sales.ticket as t", "t.id", "a.ticket_id").select("a.status").where("t.reservation_id", "=", s.row.reservation_id).execute());
    // Confirmed and the places taken, but nothing to share or scan yet.
    expect((await staffView()).status).toBe("confirmed");
    expect((await staffView()).tickets.map((t) => [t.ticketToken, t.admissionToken])).toEqual([[null, null], [null, null]]);
    expect((await statuses()).map((a) => a.status)).toEqual(["pending", "pending"]);
    expect(await pool(occ.id)).toMatchObject({ taken: 2 });
    expect(await process(s.paymentId)).toBe("captured");
    expect((await statuses()).map((a) => a.status)).toEqual(["valid", "valid"]);
    for (const t of (await staffView()).tickets) expect(t).toMatchObject({ ticketToken: expect.any(String), admissionToken: expect.any(String) });
  });

  it("releases the tickets when Vipps refuses the capture after staff closed the checkout", async () => {
    const { occ, adult, hosted } = await concert("closed-during-capture");
    const s = await pay(occ.id, [{ offerId: adult.id, quantity: 2 }]);
    vipps.approve(s.row.reference);
    vipps.failNext("capture", 423);
    expect(await process(s.paymentId)).toBe("authorized");
    const ch = await run((tx) => offers.getChannel(tx, hosted.id));
    await run((tx) => offers.updateChannel(tx, ctx, hosted.id, ch.version, { active: false }));
    vipps.failNext("capture", 400);
    expect(await process(s.paymentId)).toBe("cancelled");
    expect(await reservation(s.row.reservation_id)).toMatchObject({ status: "cancelled" });
    expect(await pool(occ.id)).toMatchObject({ taken: 0 });
    const tickets = await run((tx) => tx.selectFrom("sales.ticket").select("status").where("reservation_id", "=", s.row.reservation_id).execute());
    expect(tickets.map((t) => t.status)).toEqual(["cancelled", "cancelled"]);
    await run((tx) => offers.enableHostedChannel(tx, ctx));
  });

  it("does not take a refused cancel as done while the authorisation is still there", async () => {
    const { occ, adult } = await concert("cancel-locked", 1);
    const s = await pay(occ.id, [{ offerId: adult.id, quantity: 1 }]);
    await run((tx) => sales.expireReservation(tx, ctx.tenantId, s.row.reservation_id, at(25)));
    const webCaller = { tenantId: ctx.tenantId, channelId: web.id, signingKey: null };
    await run((tx) => sales.reserve(tx, webCaller, { lines: [{ occurrenceId: occ.id, offerId: adult.id, quantity: 1 }], confirm: true, externalOrderRef: "WEB-L" }, at(26)));
    vipps.approve(s.row.reference);
    vipps.failNext("cancel", 423);
    // Confirm fails (sold out) and the cancel is held: the payment stays open, with the reason.
    expect(await process(s.paymentId, at(27))).toBe("created");
    const row = await run((tx) => tx.selectFrom("payments.payment").select("failure_reason").where("id", "=", s.paymentId).executeTakeFirstOrThrow());
    expect(row.failure_reason).toMatch(/waiting for Vipps to confirm the cancellation/);
    expect((await vipps.getPayment(keys, s.row.reference)).state).toBe("AUTHORIZED");
    // Next time round Vipps takes the cancel.
    expect(await process(s.paymentId, at(28))).toBe("cancelled");
    expect((await vipps.getPayment(keys, s.row.reference)).aggregate.cancelledAmount.value).toBe(45000);
  });
});

describe("money moved in the Vipps portal", () => {
  it("confirms the tickets when the merchant captured in the portal before the platform saw the approval", async () => {
    const { occ, adult } = await concert("portal-capture");
    const s = await pay(occ.id, [{ offerId: adult.id, quantity: 2 }]);
    vipps.approve(s.row.reference);
    await vipps.capture(keys, s.row.reference, { currency: "NOK", value: 90000 }, "portal-capture");
    expect(await process(s.paymentId)).toBe("captured");
    expect(await reservation(s.row.reservation_id)).toMatchObject({ status: "confirmed" });
    const view = await run((tx) => sales.getReservationAsStaff(tx, ctx, s.row.reservation_id, at(3)));
    for (const t of view.tickets) expect(t.admissionToken).toEqual(expect.any(String));
    // Nothing captured twice.
    expect(vipps.callsFor(s.row.reference, "capture")).toHaveLength(1);
  });

  it("refunds a portal capture when the tickets can no longer be issued", async () => {
    const { occ, adult } = await concert("portal-capture-sold-out", 2);
    const s = await pay(occ.id, [{ offerId: adult.id, quantity: 2 }]);
    await run((tx) => sales.expireReservation(tx, ctx.tenantId, s.row.reservation_id, at(25)));
    const webCaller = { tenantId: ctx.tenantId, channelId: web.id, signingKey: null };
    await run((tx) => sales.reserve(tx, webCaller, { lines: [{ occurrenceId: occ.id, offerId: adult.id, quantity: 2 }], confirm: true, externalOrderRef: "WEB-P" }, at(26)));
    vipps.approve(s.row.reference);
    await vipps.capture(keys, s.row.reference, { currency: "NOK", value: 90000 }, "portal-capture-2");
    expect(await process(s.paymentId, at(27))).toBe("cancelled");
    expect((await vipps.getPayment(keys, s.row.reference)).aggregate.refundedAmount.value).toBe(90000);
    const status = await run((tx) => payments.checkoutStatus(tx, s.token, at(28)));
    expect(status).toMatchObject({ state: "cancelled", refund: { amount: 90000, state: "done" } });
    const tickets = await run((tx) => tx.selectFrom("sales.ticket").select("id").where("reservation_id", "=", s.row.reservation_id).execute());
    expect(tickets).toEqual([]);
  });

  it("refunds what was captured when the merchant captured part and cancelled the rest", async () => {
    const { occ, adult } = await concert("partial-capture");
    const s = await pay(occ.id, [{ offerId: adult.id, quantity: 2 }]);
    vipps.approve(s.row.reference);
    vipps.failNext("capture", 423);
    expect(await process(s.paymentId)).toBe("authorized");
    await vipps.capture(keys, s.row.reference, { currency: "NOK", value: 20000 }, "portal-partial");
    await vipps.cancel(keys, s.row.reference, "portal-cancel-rest");
    expect(await process(s.paymentId)).toBe("cancelled");
    expect((await vipps.getPayment(keys, s.row.reference)).aggregate).toMatchObject({ capturedAmount: { value: 20000 }, refundedAmount: { value: 20000 }, cancelledAmount: { value: 70000 } });
    expect(await reservation(s.row.reservation_id)).toMatchObject({ status: "cancelled" });
    expect(await pool(occ.id)).toMatchObject({ taken: 0 });
  });

  it("issues no tickets for a portal capture that was refunded before the platform settled it", async () => {
    const { occ, adult } = await concert("portal-refunded");
    const s = await pay(occ.id, [{ offerId: adult.id, quantity: 2 }]);
    vipps.approve(s.row.reference);
    await vipps.capture(keys, s.row.reference, { currency: "NOK", value: 90000 }, "portal-cap");
    await vipps.refund(keys, s.row.reference, { currency: "NOK", value: 90000 }, "portal-ref");
    expect(await process(s.paymentId)).toBe("cancelled");
    expect(await reservation(s.row.reservation_id)).toMatchObject({ status: "cancelled" });
    const tickets = await run((tx) => tx.selectFrom("sales.ticket").select("id").where("reservation_id", "=", s.row.reservation_id).execute());
    expect(tickets).toEqual([]);
    // Nothing more to give back: no refund of its own, but the return page tells the buyer it was refunded.
    expect((await vipps.getPayment(keys, s.row.reference)).aggregate.refundedAmount.value).toBe(90000);
    // Only the portal's own refund (made above); the platform sends none.
    expect(vipps.callsFor(s.row.reference, "refund")).toEqual([expect.objectContaining({ idempotencyKey: "portal-ref" })]);
    expect(await run((tx) => payments.checkoutStatus(tx, s.token, at(3)))).toMatchObject({ state: "cancelled", refund: { amount: 90000, state: "done" } });
  });

  it("refunds a portal capture made after the occurrence ended, instead of activating the tickets", async () => {
    const { occ, adult } = await concert("portal-capture-after-end");
    const s = await pay(occ.id, [{ offerId: adult.id, quantity: 1 }]);
    vipps.approve(s.row.reference);
    vipps.failNext("capture", 423);
    expect(await process(s.paymentId)).toBe("authorized");
    await vipps.capture(keys, s.row.reference, { currency: "NOK", value: 45000 }, "portal-late");
    const afterEnd = new Date(START.getTime() + 6 * 60 * MIN);
    expect(await process(s.paymentId, afterEnd)).toBe("cancelled");
    expect((await vipps.getPayment(keys, s.row.reference)).aggregate.refundedAmount.value).toBe(45000);
    const tickets = await run((tx) => tx.selectFrom("sales.ticket").select("status").where("reservation_id", "=", s.row.reservation_id).execute());
    expect(tickets.map((t) => t.status)).toEqual(["cancelled"]);
    expect(await run((tx) => payments.checkoutStatus(tx, s.token, afterEnd))).toMatchObject({ refund: { amount: 45000, state: "done" } });
  });

  it("does not capture the rest when part was captured and refunded in the portal", async () => {
    const { occ, adult } = await concert("partial-refunded");
    const s = await pay(occ.id, [{ offerId: adult.id, quantity: 2 }]);
    vipps.approve(s.row.reference);
    vipps.failNext("capture", 423);
    expect(await process(s.paymentId)).toBe("authorized");
    await vipps.capture(keys, s.row.reference, { currency: "NOK", value: 30000 }, "portal-part-2");
    await vipps.refund(keys, s.row.reference, { currency: "NOK", value: 30000 }, "portal-part-refund");
    expect(await process(s.paymentId)).toBe("cancelled");
    expect((await vipps.getPayment(keys, s.row.reference)).aggregate).toMatchObject({ capturedAmount: { value: 30000 }, refundedAmount: { value: 30000 }, cancelledAmount: { value: 60000 } });
    expect(await reservation(s.row.reservation_id)).toMatchObject({ status: "cancelled" });
    expect(await run((tx) => payments.checkoutStatus(tx, s.token, at(3)))).toMatchObject({ state: "cancelled", refund: { amount: 30000, state: "done" } });
  });

  it("tells the buyer when the refund of a portal capture failed", async () => {
    const { occ, adult } = await concert("portal-refund-fails", 1);
    const s = await pay(occ.id, [{ offerId: adult.id, quantity: 1 }]);
    await run((tx) => sales.expireReservation(tx, ctx.tenantId, s.row.reservation_id, at(25)));
    const webCaller = { tenantId: ctx.tenantId, channelId: web.id, signingKey: null };
    await run((tx) => sales.reserve(tx, webCaller, { lines: [{ occurrenceId: occ.id, offerId: adult.id, quantity: 1 }], confirm: true, externalOrderRef: "WEB-F" }, at(26)));
    vipps.approve(s.row.reference);
    await vipps.capture(keys, s.row.reference, { currency: "NOK", value: 45000 }, "portal-cap-f");
    vipps.failNext("refund", 400);
    expect(await process(s.paymentId, at(27))).toBe("cancelled");
    expect(await run((tx) => payments.checkoutStatus(tx, s.token, at(28)))).toMatchObject({ refund: { amount: 45000, state: "failed" } });
  });

  it("captures only what is left after a partial capture in the portal", async () => {
    const { occ, adult } = await concert("partial-then-rest");
    const s = await pay(occ.id, [{ offerId: adult.id, quantity: 2 }]);
    vipps.approve(s.row.reference);
    vipps.failNext("capture", 423);
    expect(await process(s.paymentId)).toBe("authorized");
    await vipps.capture(keys, s.row.reference, { currency: "NOK", value: 30000 }, "portal-part");
    expect(await process(s.paymentId)).toBe("captured");
    expect((await vipps.getPayment(keys, s.row.reference)).aggregate.capturedAmount.value).toBe(90000);
  });
});

describe("a capture that waited too long", () => {
  it("is called off, not charged, when the occurrence ended while Vipps held the capture", async () => {
    const { occ, adult } = await concert("capture-after-end");
    const s = await pay(occ.id, [{ offerId: adult.id, quantity: 1 }]);
    vipps.approve(s.row.reference);
    vipps.failNext("capture", 423);
    expect(await process(s.paymentId)).toBe("authorized");
    const afterEnd = new Date(START.getTime() + 6 * 60 * MIN);
    expect(await process(s.paymentId, afterEnd)).toBe("cancelled");
    expect((await vipps.getPayment(keys, s.row.reference)).aggregate).toMatchObject({ capturedAmount: { value: 0 }, cancelledAmount: { value: 45000 } });
    const row = await run((tx) => tx.selectFrom("payments.payment").select("failure_reason").where("id", "=", s.paymentId).executeTakeFirstOrThrow());
    expect(row.failure_reason).toMatch(/occurrence_ended/);
  });
});

describe("a capture whose answer comes back late", () => {
  /** FakeVipps with a capture that runs `meanwhile` after Vipps has applied it, before answering. */
  const slowCapture = (meanwhile: () => Promise<unknown>): payments.PaymentProvider => ({
    verifyCredentials: (...a) => vipps.verifyCredentials(...a), registerWebhook: (...a) => vipps.registerWebhook(...a), deleteWebhook: (...a) => vipps.deleteWebhook(...a),
    createPayment: (...a) => vipps.createPayment(...a), getPayment: (...a) => vipps.getPayment(...a), cancel: (...a) => vipps.cancel(...a),
    refund: (...a) => vipps.refund(...a), sendReceipt: (...a) => vipps.sendReceipt(...a),
    capture: async (...a) => {
      await vipps.capture(...a);
      await meanwhile();
    },
  });

  it("keeps the order called off when a concurrent settlement refunded it first", async () => {
    const { occ, adult } = await concert("late-answer");
    const s = await pay(occ.id, [{ offerId: adult.id, quantity: 1 }]);
    vipps.approve(s.row.reference);
    const afterEnd = new Date(START.getTime() + 6 * 60 * MIN);
    // While the capture is on its way, the webhook settles the payment after the occurrence ended.
    const provider = slowCapture(() => payments.processPayment(db, ctx.tenantId, s.paymentId, deps, afterEnd));
    expect(await payments.processPayment(db, ctx.tenantId, s.paymentId, { provider }, at(2))).toBe("cancelled");
    expect((await vipps.getPayment(keys, s.row.reference)).aggregate.refundedAmount.value).toBe(45000);
    const events = await run((tx) => tx.selectFrom("outbox.event").select("type").where("subject", "=", `payment/${s.paymentId}`).execute());
    expect(events.map((e) => e.type)).not.toContain("payment.captured.v1");
  });

  it("does not activate tickets for a capture the merchant refunded before the answer came back", async () => {
    const { occ, adult } = await concert("refunded-mid-capture");
    const s = await pay(occ.id, [{ offerId: adult.id, quantity: 1 }]);
    vipps.approve(s.row.reference);
    const provider = slowCapture(() => vipps.refund(keys, s.row.reference, { currency: "NOK", value: 45000 }, "portal-ref-mid"));
    expect(await payments.processPayment(db, ctx.tenantId, s.paymentId, { provider }, at(2))).toBe("cancelled");
    expect(await reservation(s.row.reservation_id)).toMatchObject({ status: "cancelled" });
    const events = await run((tx) => tx.selectFrom("outbox.event").select("type").where("subject", "=", `payment/${s.paymentId}`).execute());
    expect(events.map((e) => e.type)).not.toContain("payment.captured.v1");
    // Already refunded in full: nothing more is sent.
    expect(vipps.callsFor(s.row.reference, "refund")).toEqual([expect.objectContaining({ idempotencyKey: "portal-ref-mid" })]);
  });

  it("leaves the payment open when it cannot read the capture back, and settles it later", async () => {
    const { occ, adult } = await concert("unreadable-after-capture");
    const s = await pay(occ.id, [{ offerId: adult.id, quantity: 1 }]);
    vipps.approve(s.row.reference);
    let reads = 0;
    const flaky: payments.PaymentProvider = {
      ...slowCapture(async () => undefined),
      getPayment: async (...a) => {
        reads++;
        if (reads === 2) throw Object.assign(new Error("Vipps did not answer"), { status: 503 });
        return vipps.getPayment(...a);
      },
    };
    expect(await payments.processPayment(db, ctx.tenantId, s.paymentId, { provider: flaky }, at(2))).toBe("authorized");
    const pending = await run((tx) => tx.selectFrom("admission.admission as a").innerJoin("sales.ticket as t", "t.id", "a.ticket_id").select("a.status").where("t.reservation_id", "=", s.row.reservation_id).execute());
    expect(pending.map((a) => a.status)).toEqual(["pending"]);
    expect(await process(s.paymentId, at(3))).toBe("captured");
    expect(vipps.callsFor(s.row.reference, "capture")).toHaveLength(1);
  });

  it("refunds instead of activating when the occurrence ends while the capture is out", async () => {
    const { occ, adult } = await concert("ends-mid-capture");
    const s = await pay(occ.id, [{ offerId: adult.id, quantity: 1 }]);
    vipps.approve(s.row.reference);
    const afterEnd = new Date(START.getTime() + 6 * 60 * MIN);
    // The decision to capture is taken before the end; the answer is settled after it.
    let ticks = 0;
    const clock = () => (ticks++ === 0 ? at(2) : afterEnd);
    expect(await payments.processPayment(db, ctx.tenantId, s.paymentId, { provider: vipps, clock }, at(2))).toBe("cancelled");
    expect((await vipps.getPayment(keys, s.row.reference)).aggregate).toMatchObject({ capturedAmount: { value: 45000 }, refundedAmount: { value: 45000 } });
    const row = await run((tx) => tx.selectFrom("payments.payment").select("failure_reason").where("id", "=", s.paymentId).executeTakeFirstOrThrow());
    expect(row.failure_reason).toMatch(/occurrence_ended/);
  });

  it("keeps a capture Vipps does not show yet open, without releasing anything, until it does", async () => {
    const { occ, adult } = await concert("unconfirmed-capture");
    const s = await pay(occ.id, [{ offerId: adult.id, quantity: 1 }]);
    vipps.approve(s.row.reference);
    // Vipps answers the capture successfully but has not applied it yet.
    const unapplied: payments.PaymentProvider = { ...slowCapture(async () => undefined), capture: async () => undefined };
    expect(await payments.processPayment(db, ctx.tenantId, s.paymentId, { provider: unapplied }, at(2))).toBe("authorized");
    expect(await reservation(s.row.reservation_id)).toMatchObject({ status: "confirmed" });
    expect((await vipps.getPayment(keys, s.row.reference)).aggregate).toMatchObject({ capturedAmount: { value: 0 }, cancelledAmount: { value: 0 } });
    const row = await run((tx) => tx.selectFrom("payments.payment").select(["state", "failure_reason"]).where("id", "=", s.paymentId).executeTakeFirstOrThrow());
    expect(row).toMatchObject({ state: "authorized", failure_reason: expect.stringMatching(/does not show it yet/) });
    // Next time round the capture is applied, and the order settles.
    expect(await process(s.paymentId, at(3))).toBe("captured");
  });

  it("cancels the rest of the authorisation when the read-back shows a partial capture refunded", async () => {
    const { occ, adult } = await concert("partial-refund-on-answer");
    const s = await pay(occ.id, [{ offerId: adult.id, quantity: 2 }]);
    vipps.approve(s.row.reference);
    vipps.failNext("capture", 423);
    expect(await process(s.paymentId)).toBe("authorized");
    await vipps.capture(keys, s.row.reference, { currency: "NOK", value: 30000 }, "portal-part-x");
    // Our capture of the remaining NOK 600 is answered but not applied, and meanwhile the merchant
    // refunds the NOK 300 captured in the portal.
    const provider: payments.PaymentProvider = {
      ...slowCapture(async () => undefined),
      capture: async () => { await vipps.refund(keys, s.row.reference, { currency: "NOK", value: 30000 }, "portal-ref-x"); },
    };
    // Vipps holds the cancel of the rest the first time: the payment stays open.
    vipps.failNext("cancel", 423);
    expect(await payments.processPayment(db, ctx.tenantId, s.paymentId, { provider }, at(2))).toBe("authorized");
    expect((await vipps.getPayment(keys, s.row.reference)).aggregate.cancelledAmount.value).toBe(0);
    // Next time round the rest is cancelled, and the order with it.
    expect(await process(s.paymentId, at(3))).toBe("cancelled");
    expect((await vipps.getPayment(keys, s.row.reference)).aggregate).toMatchObject({ capturedAmount: { value: 30000 }, refundedAmount: { value: 30000 }, cancelledAmount: { value: 60000 } });
    expect(await reservation(s.row.reservation_id)).toMatchObject({ status: "cancelled" });
  });

  it("judges a recovered capture at the time of settling, not the start of the reconcile batch", async () => {
    const { occ, adult } = await concert("stale-batch-time");
    const s = await pay(occ.id, [{ offerId: adult.id, quantity: 1 }]);
    vipps.approve(s.row.reference);
    vipps.failNext("capture", 423);
    expect(await process(s.paymentId)).toBe("authorized");
    await vipps.capture(keys, s.row.reference, { currency: "NOK", value: 45000 }, "portal-cap-batch");
    // The batch started before the end; this payment's turn comes after it.
    const afterEnd = new Date(START.getTime() + 6 * 60 * MIN);
    expect(await payments.processPayment(db, ctx.tenantId, s.paymentId, { provider: vipps, clock: () => afterEnd }, at(2))).toBe("cancelled");
    expect((await vipps.getPayment(keys, s.row.reference)).aggregate.refundedAmount.value).toBe(45000);
  });

  it("refunds a capture that landed after the occurrence was cancelled", async () => {
    const { occ, adult } = await concert("cancelled-mid-capture");
    const s = await pay(occ.id, [{ offerId: adult.id, quantity: 1 }]);
    vipps.approve(s.row.reference);
    const provider = slowCapture(() => run((tx) => tx.updateTable("catalog.occurrence").set({ status: "cancelled" }).where("id", "=", occ.id).execute()));
    expect(await payments.processPayment(db, ctx.tenantId, s.paymentId, { provider }, at(2))).toBe("cancelled");
    expect((await vipps.getPayment(keys, s.row.reference)).aggregate).toMatchObject({ capturedAmount: { value: 45000 }, refundedAmount: { value: 45000 } });
    const tickets = await run((tx) => tx.selectFrom("sales.ticket").select("status").where("reservation_id", "=", s.row.reservation_id).execute());
    expect(tickets.map((t) => t.status)).toEqual(["cancelled"]);
  });
});

describe("a refund split between the Vipps portal and the platform", () => {
  it("reports the whole refund on the return page, counting each part once", async () => {
    const { occ, adult } = await concert("split-refund");
    const s = await pay(occ.id, [{ offerId: adult.id, quantity: 2 }]);
    vipps.approve(s.row.reference);
    await vipps.capture(keys, s.row.reference, { currency: "NOK", value: 90000 }, "portal-cap-split");
    await vipps.refund(keys, s.row.reference, { currency: "NOK", value: 30000 }, "portal-ref-split");
    // Captured, then partly refunded in the portal: not paid for; the platform refunds the rest.
    expect(await process(s.paymentId)).toBe("cancelled");
    expect((await vipps.getPayment(keys, s.row.reference)).aggregate.refundedAmount.value).toBe(90000);
    expect(await run((tx) => payments.checkoutStatus(tx, s.token, at(3)))).toMatchObject({ refund: { amount: 90000, state: "done", outstanding: 0 } });
  });
});

describe("expiry racing the buyer's approval", () => {
  it("cancels only an unapproved payment; an approval that wins is settled as usual", async () => {
    const { occ, adult } = await concert("expiry-race");
    const s = await pay(occ.id, [{ offerId: adult.id, quantity: 1 }]);
    await run((tx) => sales.expireReservation(tx, ctx.tenantId, s.row.reservation_id, at(25)));
    // Vipps says CREATED, then the buyer approves before the cancel arrives.
    let first = true;
    const racing: payments.PaymentProvider = {
      ...vipps,
      verifyCredentials: (...a) => vipps.verifyCredentials(...a), registerWebhook: (...a) => vipps.registerWebhook(...a), deleteWebhook: (...a) => vipps.deleteWebhook(...a),
      createPayment: (...a) => vipps.createPayment(...a), capture: (...a) => vipps.capture(...a), cancel: (...a) => vipps.cancel(...a),
      refund: (...a) => vipps.refund(...a), sendReceipt: (...a) => vipps.sendReceipt(...a),
      getPayment: async (c, ref) => {
        const p = await vipps.getPayment(c, ref);
        if (first) { first = false; vipps.approve(ref); }
        return p;
      },
    };
    expect(await payments.abandonPayment(db, ctx.tenantId, s.paymentId, { provider: racing }, at(26))).toBe("captured");
    expect(await reservation(s.row.reservation_id)).toMatchObject({ status: "confirmed" });
  });
});

describe("a capture refused after the show has started", () => {
  it("still releases tickets that were never usable", async () => {
    const { occ, adult } = await concert("refused-after-start");
    const s = await pay(occ.id, [{ offerId: adult.id, quantity: 2 }]);
    vipps.approve(s.row.reference);
    vipps.failNext("capture", 423);
    expect(await process(s.paymentId)).toBe("authorized");
    vipps.failNext("capture", 400);
    const afterStart = new Date(START.getTime() + 30 * MIN);
    expect(await process(s.paymentId, afterStart)).toBe("cancelled");
    const tickets = await run((tx) => tx.selectFrom("sales.ticket as t").innerJoin("admission.admission as a", "a.ticket_id", "t.id")
      .select(["t.status", "a.status as admission"]).where("t.reservation_id", "=", s.row.reservation_id).execute());
    expect(tickets).toEqual([{ status: "cancelled", admission: "void" }, { status: "cancelled", admission: "void" }]);
    expect(await pool(occ.id)).toMatchObject({ taken: 0 });
  });
});

describe("the return link", () => {
  it("still shows a completed order after staff deactivate the hosted channel", async () => {
    const { occ, adult, hosted } = await concert("return-closed");
    const s = await pay(occ.id, [{ offerId: adult.id, quantity: 1 }]);
    vipps.approve(s.row.reference);
    expect(await process(s.paymentId)).toBe("captured");
    const ch = await run((tx) => offers.getChannel(tx, hosted.id));
    await run((tx) => offers.updateChannel(tx, ctx, hosted.id, ch.version, { active: false }));
    const status = await run((tx) => payments.checkoutStatus(tx, s.token, at(5)));
    expect(status).toMatchObject({ state: "captured", reservation: { status: "confirmed" } });
    expect(status!.reservation.tickets[0]!.ticketToken).toEqual(expect.any(String));
    await run((tx) => offers.enableHostedChannel(tx, ctx));
  });

  it("gives the hosted channel no channel keys, so no shop can cancel its paid tickets", async () => {
    const hosted = (await run((tx) => offers.hostedChannel(tx)))!;
    await expect(run((tx) => offers.createChannelKey(tx, ctx, hosted.id, "Shop"))).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("buyer retention", () => {
  it("clears the payment's copy of the buyer when retention anonymises the reservation, keeping amounts and references", async () => {
    const { occ, adult } = await concert("retention");
    const s = await pay(occ.id, [{ offerId: adult.id, quantity: 1 }]);
    const later = new Date(START.getTime() + 3 * 365 * 86_400_000);
    await run((tx) => sales.applySalesRetention(tx, later));
    const r = await run((tx) => payments.applyPaymentRetention(tx));
    expect(r.paymentsAnonymised).toBeGreaterThan(0);
    const row = await run((tx) => tx.selectFrom("payments.payment").select(["buyer_name", "buyer_email", "buyer_phone", "amount", "reference"]).where("id", "=", s.paymentId).executeTakeFirstOrThrow());
    expect(row).toEqual({ buyer_name: null, buyer_email: null, buyer_phone: null, amount: 45000, reference: s.row.reference });
    expect((await run((tx) => payments.applyPaymentRetention(tx))).paymentsAnonymised).toBe(0);
  });
});

describe("a disconnect while a checkout is starting", () => {
  it("waits for the checkout's payment and then refuses, so no payment is left without keys", async () => {
    const { occ, adult, hosted } = await concert("disconnect-race");
    const openBefore = Number((await run((tx) => tx.selectFrom("payments.payment").select((eb) => eb.fn.countAll<number>().as("n")).where("state", "in", ["created", "authorized"]).executeTakeFirstOrThrow())).n);
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let paymentId = "";
    // What startCheckout does in its transaction: share-lock the merchant, reserve, insert the payment.
    const checkout = withTenant(db, ctx, async (tx) => {
      const acct = await tx.selectFrom("payments.provider_account").select("id").where("status", "=", "active").forShare().executeTakeFirstOrThrow();
      locked();
      await gate;
      const r = await sales.reserve(tx, { tenantId: ctx.tenantId, channelId: hosted.id, signingKey: null }, { lines: [{ occurrenceId: occ.id, offerId: adult.id, quantity: 1 }] }, NOW);
      paymentId = (await tx.insertInto("payments.payment").values({
        id: crypto.randomUUID(), tenant_id: ctx.tenantId, provider_account_id: acct.id, reservation_id: r.id, provider: "vipps", reference: `em-race-${r.id.slice(-12)}`, amount: 45000, currency: "NOK",
      }).returning("id").executeTakeFirstOrThrow()).id;
    });
    await isLocked;
    const version = (await run((tx) => payments.getProviderAccount(tx)))!.version;
    let settled = false;
    const disconnect = payments.disconnectVipps(db, ctx, version, providerDeps).finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 300));
    expect(settled).toBe(false);
    release();
    await checkout;
    // The count, taken under the lock, includes the payment the checkout was making.
    await expect(disconnect).rejects.toMatchObject({ code: "conflict", details: { openPayments: openBefore + 1 } });
    // Tidy up for the next test: the race payment never reached Vipps.
    await run((tx) => tx.updateTable("payments.payment").set({ state: "failed" }).where("id", "=", paymentId).execute());
  });
});

describe("changing the merchant", () => {
  // Runs last: it changes the account's connected merchant.
  it("reuses the merchant's provider account, keeps a replaced merchant's keys, and refuses to disconnect while payments settle", async () => {
    const { occ, adult } = await concert("merchant-change");
    const first = (await run((tx) => payments.getProviderAccount(tx)))!;
    // A paid order, and one still waiting for the buyer, on the first merchant.
    const paidOrder = await pay(occ.id, [{ offerId: adult.id, quantity: 1 }]);
    vipps.approve(paidOrder.row.reference);
    expect(await process(paidOrder.paymentId)).toBe("captured");
    const waiting = await pay(occ.id, [{ offerId: adult.id, quantity: 1 }]);

    // New keys for the same merchant: the same provider account.
    const again = await payments.connectVipps(db, ctx, { ...keys, clientSecret: "s2" }, providerDeps);
    expect(again.id).toBe(first.id);

    // Another merchant: the first is retired with its keys, so its payments still settle and refund.
    const other = await payments.connectVipps(db, ctx, { ...keys, merchantSerialNumber: "777777" }, providerDeps);
    expect(other.id).not.toBe(first.id);
    vipps.approve(waiting.row.reference);
    expect(await process(waiting.paymentId)).toBe("captured");
    expect(await payments.refundTickets(db, { ...ctx, roles: ["box_office"] }, paidOrder.row.reservation_id, { amount: 45000 }, deps, at(10))).toMatchObject({ state: "done" });

    // Disconnecting waits for the merchant's open payments.
    const open = await pay(occ.id, [{ offerId: adult.id, quantity: 1 }]);
    const cur = (await run((tx) => payments.getProviderAccount(tx)))!;
    await expect(payments.disconnectVipps(db, ctx, cur.version, providerDeps)).rejects.toMatchObject({ code: "conflict", details: { openPayments: 1 } });
    vipps.reject(open.row.reference);
    expect(await process(open.paymentId)).toBe("failed");

    // ...and for refunds Vipps has not answered yet, which are sent again with its keys.
    const toRefund = await pay(occ.id, [{ offerId: adult.id, quantity: 1 }]);
    vipps.approve(toRefund.row.reference);
    expect(await process(toRefund.paymentId)).toBe("captured");
    vipps.down = true;
    const pendingRefund = await payments.refundTickets(db, { ...ctx, roles: ["box_office"] }, toRefund.row.reservation_id, { amount: 45000 }, deps, at(10));
    vipps.down = false;
    expect(pendingRefund).toMatchObject({ state: "pending" });
    await expect(payments.disconnectVipps(db, ctx, cur.version, providerDeps)).rejects.toMatchObject({ code: "conflict", details: { pendingRefunds: 1 } });
    expect((await payments.sendRefund(db, ctx.tenantId, pendingRefund!.id, deps)).state).toBe("done");

    // A captured order on this merchant, to refund after the disconnect.
    const late = await pay(occ.id, [{ offerId: adult.id, quantity: 1 }]);
    vipps.approve(late.row.reference);
    expect(await process(late.paymentId)).toBe("captured");

    // Once settled, disconnect goes through, and no new checkout can start.
    await payments.disconnectVipps(db, ctx, cur.version, providerDeps);
    await expect(start(occ.id, [{ offerId: adult.id, quantity: 1 }])).rejects.toMatchObject({ code: "not_on_sale" });
    // Refunding without the merchant's keys is refused before any ticket is cancelled.
    await expect(payments.refundTickets(db, { ...ctx, roles: ["box_office"] }, late.row.reservation_id, { amount: 45000 }, deps, at(10))).rejects.toMatchObject({ code: "conflict" });
    const stillValid = await run((tx) => tx.selectFrom("sales.ticket").select("status").where("reservation_id", "=", late.row.reservation_id).execute());
    expect(stillValid.map((t) => t.status)).toEqual(["valid"]);

    // Connecting the first merchant again brings back its provider account.
    const back = await payments.connectVipps(db, ctx, keys, providerDeps);
    expect(back.id).toBe(first.id);
  });
});
