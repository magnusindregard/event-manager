import pg from "pg";
import { runOnce } from "graphile-worker";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { type ActorContext, catalog, offers, payments, tenancy } from "@event-manager/domain";
import { FakeVipps } from "@event-manager/vipps";
import { defaultHandlers } from "../src/handlers.js";
import { FakeDirectory } from "../src/identity/directory.js";
import { FakeMailer } from "../src/identity/mailer.js";
import { receiptEmail, reconcilePayments } from "../src/payments.js";
import { sweepReservations } from "../src/reservations.js";
import { buildTaskList } from "../src/tasks.js";

// Hosted checkout milestone 3 (docs/checkout.md): the payments.process job the webhook queues,
// the reconcile job, the receipt after capture, and payments whose hold expired.

let tdb: TestDatabase;
let db: Db;
let admin: pg.Client;
let ctx: ActorContext;
let mailer: FakeMailer;
let occurrenceId: string;
let adultId: string;
const vipps = new FakeVipps();
const deps = { provider: vipps, attendeeUrl: "https://attend.test" };
const MIN = 60_000;

async function drain() {
  for (let i = 0; i < 4; i++) {
    await admin.query(`update graphile_worker._private_jobs set run_at = now() where locked_at is null`);
    await runOnce({
      connectionString: tdb.appUrl,
      taskList: buildTaskList(db, defaultHandlers, { directory: new FakeDirectory(), mailer, adminUrl: "https://admin.test/" }, { mailer, attendeeUrl: "https://attend.test/" }, null, { provider: vipps, mailer }),
    });
  }
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  admin = new pg.Client({ connectionString: tdb.superuserUrl });
  await admin.connect();
  mailer = new FakeMailer();
  const account = await tenancy.createAccount(db, { slug: "pay", name: "Teatret", ownerEmail: "owner@pay.test" });
  const userId = await tenancy.login(db, { issuer: "t", subject: "o", email: "owner@pay.test", name: null });
  ctx = { tenantId: account.id, userId, clientId: null, roles: ["owner"] };
  await payments.connectVipps(db, ctx, { environment: "test", merchantSerialNumber: "123456", clientId: "c", clientSecret: "s", subscriptionKey: "k" }, { provider: vipps, webhookUrl: null });
  await withTenant(db, ctx, async (tx) => {
    await tx.updateTable("tenancy.account").set({ merchant_legal_name: "Teatret AS", merchant_org_number: "974760673", merchant_vat_registered: true }).execute();
    const vat = await offers.createVatClass(tx, ctx, { code: "culture", label: "Kultur", ratePct: 12 });
    await offers.enableHostedChannel(tx, ctx);
    const event = await catalog.createEvent(tx, ctx, { translations: { nb: { title: "Hamlet" } }, admissionMode: "tickets", registration: { capacity: 50 } });
    occurrenceId = (await catalog.createOccurrence(tx, ctx, event.id, { startUtc: new Date(Date.now() + 7 * 86_400_000) })).id;
    adultId = (await offers.createOffer(tx, ctx, event.id, { translations: { nb: { name: "Voksen" } }, vatClassId: vat.id, defaultPrice: 45000 })).offer!.id;
    await catalog.transitionEvent(tx, ctx, event.id, (await catalog.getEvent(tx, event.id)).version, "publish");
  });
  await drain();
});
beforeEach(() => {
  mailer.sent.length = 0;
});
afterAll(async () => {
  await admin?.end();
  await db?.destroy();
  await tdb?.stop();
});

async function checkout(now = new Date()) {
  const s = await payments.startCheckout(db, ctx.tenantId, { occurrenceId, lines: [{ offerId: adultId, quantity: 2 }], buyer: { name: "Kari Nordmann", email: "kari@example.com" }, locale: "nb" }, deps, now);
  if (s.kind !== "pay") throw new Error("expected a payment");
  const row = await withTenant(db, ctx, (tx) => tx.selectFrom("payments.payment").selectAll().where("id", "=", s.paymentId).executeTakeFirstOrThrow());
  return row;
}
const state = async (id: string) => (await withTenant(db, ctx, (tx) => tx.selectFrom("payments.payment").select(["state", "receipt_sent_at"]).where("id", "=", id).executeTakeFirstOrThrow()));

describe("payments.process and the receipt", () => {
  it("settles a queued payment, then emails the receipt and sends it to the Vipps app once", async () => {
    const p = await checkout();
    vipps.approve(p.reference);
    await withTenant(db, ctx, (tx) => payments.queueProcessing(tx, ctx.tenantId, p.id));
    await drain();
    expect(await state(p.id)).toMatchObject({ state: "captured", receipt_sent_at: expect.any(Date) });

    const receipts = mailer.sent.filter((m) => m.subject === "Kvittering fra Teatret");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.to).toBe("kari@example.com");
    expect(receipts[0]!.text).toContain(`Ordre: ${p.reference}`);
    expect(receipts[0]!.text).toMatch(/Totalt: 900,00\s?kr/);
    expect(receipts[0]!.text).toMatch(/Herav mva\. 12 %: 96,43\s?kr/);
    expect(receipts[0]!.text).toContain("Org.nr. 974 760 673 MVA");
    // The tickets email comes from the hosted channel, as for any channel that sends tickets.
    expect(mailer.sent.some((m) => m.subject.startsWith("Billetter: "))).toBe(true);
    expect(vipps.payments.get(p.reference)!.receipt).not.toBeNull();

    // Queued again: nothing more happens.
    await withTenant(db, ctx, (tx) => payments.queueProcessing(tx, ctx.tenantId, p.id));
    await drain();
    expect(mailer.sent.filter((m) => m.subject === "Kvittering fra Teatret")).toHaveLength(1);
    expect(vipps.callsFor(p.reference, "capture")).toHaveLength(1);
  });

  it("sends the tickets only once the payment is captured, not when the reservation is confirmed", async () => {
    const p = await checkout();
    vipps.approve(p.reference);
    // Confirmed (tickets issued), but Vipps holds the capture for now.
    vipps.failNext("capture", 423);
    expect(await payments.processPayment(db, ctx.tenantId, p.id, { provider: vipps })).toBe("authorized");
    await drain();
    const tickets = () => mailer.sent.filter((m) => m.subject.startsWith("Billetter: "));
    expect(tickets()).toEqual([]);
    expect(await payments.processPayment(db, ctx.tenantId, p.id, { provider: vipps })).toBe("captured");
    await drain();
    expect(tickets()).toHaveLength(1);
    expect(mailer.sent.filter((m) => m.subject === "Kvittering fra Teatret")).toHaveLength(1);
  });

  it("leaves VAT out of the receipt for accounts that are not VAT-registered", () => {
    const mail = receiptEmail({
      paymentId: "p", reference: "em-1", capturedAt: new Date("2027-02-01T12:00:00Z"), locale: "en", buyer: { name: null, email: null },
      merchant: { name: "Club", legalName: null, orgNumber: null, address: null, vatRegistered: false },
      lines: [{ name: "Adult", quantity: 1, unitPrice: 10000, amount: 10000, vatRatePct: 12, vat: 1071 }],
      total: { amount: 10000, currency: "NOK" }, vat: [{ ratePct: 12, amount: 1071 }], sentAt: null,
    });
    expect(mail.subject).toBe("Receipt from Club");
    expect(mail.text).not.toContain("VAT");
  });
});

describe("the reconcile job", () => {
  it("settles payments no webhook told us about, once they have sat for two minutes", async () => {
    const approved = await checkout();
    const rejected = await checkout();
    vipps.approve(approved.reference);
    vipps.reject(rejected.reference);
    // Too fresh: left to the webhook and the return page.
    expect((await reconcilePayments(db, { provider: vipps }, new Date(), () => {})).checked).toBe(0);
    const later = new Date(Date.now() + 3 * MIN);
    const r = await reconcilePayments(db, { provider: vipps }, later, () => {});
    expect(r).toMatchObject({ checked: 2, failed: 0 });
    expect((await state(approved.id)).state).toBe("captured");
    expect((await state(rejected.id)).state).toBe("failed");
  });
});

describe("a hold that expires while the buyer has not answered", () => {
  it("cancels the payment at Vipps so it can no longer be approved", async () => {
    const p = await checkout();
    const swept = await sweepReservations(db, new Date(Date.now() + 25 * MIN), () => {});
    expect(swept.expired).toBeGreaterThan(0);
    await drain();
    expect((await state(p.id)).state).toBe("expired");
    expect(vipps.payments.get(p.reference)!.state).toBe("TERMINATED");
    expect(vipps.callsFor(p.reference, "cancel")).toHaveLength(1);
    const r = await withTenant(db, ctx, (tx) => tx.selectFrom("sales.reservation").select("status").where("id", "=", p.reservation_id).executeTakeFirstOrThrow());
    expect(r.status).toBe("cancelled");
  });

  it("still sells the tickets if the buyer approved just before the job ran", async () => {
    const p = await checkout();
    await sweepReservations(db, new Date(Date.now() + 25 * MIN), () => {});
    vipps.approve(p.reference);
    await drain();
    expect((await state(p.id)).state).toBe("captured");
    const r = await withTenant(db, ctx, (tx) => tx.selectFrom("sales.reservation").select("status").where("id", "=", p.reservation_id).executeTakeFirstOrThrow());
    expect(r.status).toBe("confirmed");
  });
});
