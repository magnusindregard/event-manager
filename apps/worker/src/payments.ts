import type { Task } from "graphile-worker";
import { type Db, sql, withoutTenant, withTenant } from "@event-manager/db";
import { payments } from "@event-manager/domain";
import type { InternalHandler } from "./handlers.js";
import { type Mail, type Mailer, sendOrGiveUp } from "./identity/mailer.js";
import { esc } from "./registration-email.js";
import { queueTicketsEmailJob } from "./tickets-email.js";

// The hosted checkout's background work (docs/checkout.md):
//   payments.process      settles one payment. The webhook enqueues it, keyed by the payment, so
//                         a burst of webhooks for one payment runs once.
//   payments:reconcile    every minute, settles payments that have sat in created or authorized,
//                         in case a webhook never came (or there is none: local stacks).
//   payments.receipt      after capture: the receipt email, and the receipt in the Vipps app.
//   payments.abandon      a reservation expired while its payment was still waiting for the
//                         buyer: cancel the payment at Vipps, so it can no longer be approved.

export const PAYMENT_PROCESS_TASK = payments.PROCESS_PAYMENT_JOB;
export const PAYMENT_RECEIPT_TASK = "payments.receipt";
export const PAYMENT_ABANDON_TASK = "payments.abandon";
// Crontab task names may not contain dots.
export const PAYMENTS_RECONCILE_TASK = "payments:reconcile";
export const PAYMENTS_RECONCILE_CRONTAB = `* * * * * ${PAYMENTS_RECONCILE_TASK}`;
/** A payment is left to the webhook and the return page this long before the reconcile job looks at it. */
const SETTLE_MS = 2 * 60_000;

export interface PaymentsWorkerDeps {
  provider: payments.PaymentProvider;
  mailer: Mailer;
}

interface Payload {
  tenantId: string;
  paymentId: string;
}
const isPayload = (p: unknown): p is Payload =>
  typeof p === "object" && p !== null && typeof (p as Payload).tenantId === "string" && typeof (p as Payload).paymentId === "string";

export function processPaymentTask(db: Db, deps: Pick<PaymentsWorkerDeps, "provider">, clock: () => Date = () => new Date()): Task {
  return async (payload, helpers) => {
    if (!isPayload(payload)) throw new Error(`Invalid ${PAYMENT_PROCESS_TASK} payload`);
    const state = await payments.processPayment(db, payload.tenantId, payload.paymentId, deps, clock());
    helpers.logger.info(`payment ${payload.paymentId}: ${state ?? "not found"}`);
  };
}

export interface ReconcileResult {
  checked: number;
  failed: number;
}

/** Settles every payment unchanged for SETTLE_MS, one at a time, per tenant. */
export async function reconcilePayments(db: Db, deps: Pick<PaymentsWorkerDeps, "provider">, now: Date, log: (m: string) => void): Promise<ReconcileResult> {
  const before = new Date(now.getTime() - SETTLE_MS);
  const tenants = await withoutTenant(db, (tx) => payments.openPaymentTenants(tx, before));
  const result: ReconcileResult = { checked: 0, failed: 0 };
  for (const tenantId of tenants) {
    const [ids, refunds] = await withTenant(db, { tenantId }, async (tx) => [await payments.openPayments(tx, before), await payments.pendingRefunds(tx, before)] as const);
    for (const id of refunds) {
      try {
        await payments.sendRefund(db, tenantId, id, deps);
        result.checked++;
      } catch (e) {
        result.failed++;
        log(`payments: refund ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    for (const id of ids) {
      try {
        await payments.processPayment(db, tenantId, id, deps, now);
        result.checked++;
      } catch (e) {
        result.failed++;
        log(`payments: ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  if (result.checked || result.failed) log(`payments: ${result.checked} checked, ${result.failed} failed`);
  return result;
}

export function reconcileTask(db: Db, deps: Pick<PaymentsWorkerDeps, "provider">, clock: () => Date = () => new Date()): Task {
  return async (_payload, helpers) => {
    await reconcilePayments(db, deps, clock(), (m) => helpers.logger.info(m));
  };
}

/** After capture: the receipt. After a reservation expired: cancel its waiting payment. */
export const queuePaymentWork: InternalHandler = {
  name: "payments",
  types: ["payment.captured.v1", "reservation.expired.v1"],
  async handle(tx, event, log) {
    if (event.type === "payment.captured.v1") {
      const id = (event.data as { paymentId?: unknown }).paymentId;
      if (typeof id !== "string") return;
      await sql`select graphile_worker.add_job(${PAYMENT_RECEIPT_TASK}, json_build_object('tenantId', ${event.tenantId}::text, 'paymentId', ${id}::text),
        job_key := ${`receipt:${id}`}, max_attempts := 10)`.execute(tx);
      // The tickets go only now that the buyer has paid (tickets-email.ts skips hosted payments on confirm).
      const reservationId = (event.data as { reservationId?: unknown }).reservationId;
      if (typeof reservationId === "string") {
        const due = await tx.selectFrom("sales.reservation as r").innerJoin("offers.sales_channel as c", "c.id", "r.channel_id")
          .select("r.id").where("r.id", "=", reservationId).where("c.send_tickets", "=", true).where("r.buyer_email", "is not", null).executeTakeFirst();
        if (due) await queueTicketsEmailJob(tx, event.tenantId, reservationId, event.id);
      }
      log.info("receipt and tickets queued", { paymentId: id });
      return;
    }
    const reservationId = (event.data as { reservationId?: unknown }).reservationId;
    if (typeof reservationId !== "string") return;
    const p = await payments.paymentForReservation(tx, reservationId);
    if (p?.state !== "created") return;
    await sql`select graphile_worker.add_job(${PAYMENT_ABANDON_TASK}, json_build_object('tenantId', ${event.tenantId}::text, 'paymentId', ${p.id}::text),
      job_key := ${`abandon:${p.id}`}, max_attempts := 10)`.execute(tx);
  },
};

export function abandonPaymentTask(db: Db, deps: Pick<PaymentsWorkerDeps, "provider">, clock: () => Date = () => new Date()): Task {
  return async (payload, helpers) => {
    if (!isPayload(payload)) throw new Error(`Invalid ${PAYMENT_ABANDON_TASK} payload`);
    const state = await payments.abandonPayment(db, payload.tenantId, payload.paymentId, deps, clock());
    helpers.logger.info(`payment ${payload.paymentId} after its hold expired: ${state ?? "not found"}`);
  };
}

const money = (locale: string, amount: number, currency: string) =>
  new Intl.NumberFormat(locale.startsWith("n") ? "nb-NO" : locale, { style: "currency", currency, minimumFractionDigits: 2 }).format(amount / 100);

/** Pure: the receipt email (docs/checkout.md, "Receipts"). */
export function receiptEmail(r: payments.Receipt): Omit<Mail, "to"> {
  const nb = r.locale.startsWith("n");
  const m = (n: number) => money(r.locale, n, r.total.currency);
  const date = new Intl.DateTimeFormat(nb ? "nb-NO" : r.locale, { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Oslo" }).format(r.capturedAt);
  const subject = nb ? `Kvittering fra ${r.merchant.name}` : `Receipt from ${r.merchant.name}`;
  const seller = [
    r.merchant.legalName ?? r.merchant.name,
    r.merchant.orgNumber ? `${nb ? "Org.nr." : "Org. no."} ${r.merchant.orgNumber.replace(/(\d{3})(\d{3})(\d{3})/, "$1 $2 $3")}${r.merchant.vatRegistered ? " MVA" : ""}` : null,
    r.merchant.address,
  ].filter((x): x is string => !!x);
  const vatLines = r.merchant.vatRegistered ? r.vat.filter((v) => v.ratePct > 0).map((v) => [`${nb ? "Herav mva." : "Of which VAT"} ${v.ratePct} %`, m(v.amount)] as const) : [];
  const head = [
    nb ? "Kvittering" : "Receipt",
    `${nb ? "Ordre" : "Order"}: ${r.reference}`,
    `${nb ? "Betalt" : "Paid"}: ${date} (Vipps MobilePay)`,
  ];
  const text = [
    ...head, "",
    ...r.lines.map((l) => `${l.quantity} × ${l.name}  ${m(l.amount)}`), "",
    `${nb ? "Totalt" : "Total"}: ${m(r.total.amount)}`,
    ...vatLines.map(([a, b]) => `${a}: ${b}`), "",
    ...seller,
  ].join("\n");
  const row = (a: string, b: string, strong = false) =>
    `<tr><td style="padding:4px 0;${strong ? "font-weight:600" : ""}">${esc(a)}</td><td style="padding:4px 0;text-align:right;white-space:nowrap;${strong ? "font-weight:600" : ""}">${esc(b)}</td></tr>`;
  const html = `<!doctype html><html lang="${esc(r.locale)}"><body style="margin:0;background:#f4f4f5;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#18181b">
<div style="max-width:560px;margin:0 auto;padding:24px">
<div style="background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:24px">
<h1 style="font-size:20px;margin:0 0 8px">${esc(head[0]!)}</h1>
<p style="margin:0 0 16px;color:#52525b;line-height:1.6">${head.slice(1).map(esc).join("<br>")}</p>
<table style="width:100%;border-collapse:collapse">
${r.lines.map((l) => row(`${l.quantity} × ${l.name}`, m(l.amount))).join("\n")}
${row(nb ? "Totalt" : "Total", m(r.total.amount), true)}
${vatLines.map(([a, b]) => row(a, b)).join("\n")}
</table>
<p style="margin:16px 0 0;color:#52525b;font-size:14px;line-height:1.6">${seller.map(esc).join("<br>")}</p>
</div></div></body></html>`;
  return { subject, text, html };
}

export function receiptTask(db: Db, deps: PaymentsWorkerDeps, clock: () => Date = () => new Date()): Task {
  return async (payload, helpers) => {
    if (!isPayload(payload)) throw new Error(`Invalid ${PAYMENT_RECEIPT_TASK} payload`);
    const receipt = await withTenant(db, { tenantId: payload.tenantId }, (tx) => payments.receiptFor(tx, payload.paymentId));
    if (!receipt || receipt.sentAt) return;
    if (receipt.buyer.email) {
      const what = `payment ${payload.paymentId}: receipt email`;
      await sendOrGiveUp(deps.mailer, { to: receipt.buyer.email, ...receiptEmail(receipt) }, (l) => helpers.logger.error(l), what);
    }
    await withTenant(db, { tenantId: payload.tenantId }, (tx) => payments.markReceiptSent(tx, payload.paymentId, clock()));
    // The receipt in the Vipps app is a courtesy; the email is the receipt of record.
    await payments.sendReceiptToProvider(db, payload.tenantId, payload.paymentId, deps)
      .catch((e: unknown) => helpers.logger.warn(`payment ${payload.paymentId}: receipt to Vipps failed: ${e instanceof Error ? e.message : String(e)}`));
    helpers.logger.info(`payment ${payload.paymentId}: receipt sent`);
  };
}
