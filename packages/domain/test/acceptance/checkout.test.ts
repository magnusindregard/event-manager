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
