import { type Db, newId, type PaymentState, sql, type Tx, withTenant } from "@event-manager/db";
import * as admission from "../admission/index.js";
import * as catalog from "../catalog/index.js";
import * as offers from "../offers/index.js";
import { emit } from "../outbox/index.js";
import * as registration from "../registration/index.js";
import * as sales from "../sales/index.js";
import { DomainError } from "../shared/index.js";
import { getAccount } from "../tenancy/index.js";
import { credentialsFor, getProviderAccount } from "./accounts.js";
import { type PaymentProvider, type ProviderCredentials, type ProviderPayment, providerMessage, providerUnavailable } from "./provider.js";
import { sendRefund } from "./refunds.js";

// The hosted checkout (docs/checkout.md, ADR 0018): authorise → confirm → capture.
//
//   startCheckout   reserves on the hosted channel, holds the places long enough, and creates
//                   the Vipps payment for exactly the reservation's total.
//   processPayment  reads the payment at Vipps (the source of truth) and moves it on:
//                   authorised → confirm (tickets) → capture; confirm failing → cancel the
//                   authorisation, so no money moves; rejected or expired → release the places.
//
// processPayment is idempotent. The return page, the webhook job and the reconcile job all call
// it, in any order and as often as they like. Each decision is taken under a lock on the payment
// row. Calls to Vipps happen outside the transactions, with an idempotency key per payment and
// action, so a retried capture or cancel moves no more money.

const MIN = 60_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface CheckoutDeps {
  provider: PaymentProvider;
  /** The attendee app's base URL; Vipps sends the buyer back to its return page. */
  attendeeUrl: string;
}

const caller = (tenantId: string, channelId: string): sales.ChannelCaller => ({ tenantId, channelId, signingKey: null });
const returnUrl = (deps: CheckoutDeps, token: string) => `${deps.attendeeUrl.replace(/\/+$/, "")}/b/return/${token}`;
const invalid = (field: string, message: string) => new DomainError("validation_failed", message, { field });
const TERMINAL: readonly PaymentState[] = ["captured", "cancelled", "expired", "failed"];

// ── The buy page ──────────────────────────────────────────────────────────────

export interface CheckoutPage {
  occurrence: catalog.PublicOccurrence;
  accountName: string;
  locale: string;
  locales: string[];
  /** The checkout is enabled and Vipps is connected; otherwise the page shows the offers but cannot sell. */
  open: boolean;
}

/** What the buy page shows: the occurrence's offers on the hosted channel, at their public prices. Null for an unknown occurrence. */
export async function checkoutPage(tx: Tx, occurrenceId: string, locale: string | undefined, now: Date = new Date()): Promise<CheckoutPage | null> {
  const channel = await offers.hostedChannel(tx);
  const account = await getAccount(tx);
  if (!channel) return null;
  const { locale: picked, items } = await catalog.listPublicOccurrences(tx, { preview: false, locale, channelId: channel.id, now }, { from: now, occurrenceId, limit: 1 });
  const occurrence = items[0];
  if (!occurrence || occurrence.admission.mode !== "tickets") return null;
  const provider = await getProviderAccount(tx);
  return { occurrence, accountName: account.name, locale: picked, locales: account.locales, open: channel.active && provider?.status === "active" };
}

// ── Starting a checkout ───────────────────────────────────────────────────────

export interface CheckoutInput {
  occurrenceId: string;
  lines: { offerId: string; quantity: number }[];
  buyer: { name: string; email: string; phone?: string | null };
  locale?: string;
}

export type StartedCheckout =
  /** Send the buyer here to pay. */
  | { kind: "pay"; redirectUrl: string; paymentId: string; token: string }
  /** Nothing to pay (free tickets): confirmed at once. */
  | { kind: "free"; reservationId: string; token: string };

/** Digits with the country code, as Vipps takes it; 8 digits are taken as Norwegian. Null when left out. */
export function normalizePhone(raw: string | null | undefined): string | null {
  const s = (raw ?? "").replace(/[\s().-]/g, "");
  if (!s) return null;
  const digits = s.replace(/^\+/, "").replace(/^00/, "");
  if (!/^[0-9]+$/.test(digits)) throw invalid("buyer.phone", "Enter a phone number with digits only");
  const full = digits.length === 8 ? `47${digits}` : digits;
  if (full.length < 10 || full.length > 15) throw invalid("buyer.phone", "Enter a phone number, with country code outside Norway");
  return full;
}

function buyerOf(b: CheckoutInput["buyer"]) {
  const name = (b?.name ?? "").replace(/\s+/g, " ").trim();
  const email = (b?.email ?? "").trim().toLowerCase();
  if (!name || name.length > 200) throw invalid("buyer.name", "Enter your name");
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) throw invalid("buyer.email", "Enter a valid email address");
  return { name, email, phone: normalizePhone(b.phone) };
}

/**
 * Reserves on the hosted channel and creates the Vipps payment (docs/checkout.md, "The buy
 * flow"). Throws the reservation's errors (sold_out, quantity_out_of_range, not_on_sale …), and
 * not_on_sale when the checkout is closed or Vipps is not connected. If Vipps cannot create the
 * payment, the places are released again.
 */
export async function startCheckout(db: Db, tenantId: string, input: CheckoutInput, deps: CheckoutDeps, now: Date = new Date()): Promise<StartedCheckout> {
  const buyer = buyerOf(input.buyer);
  const lines = (input.lines ?? []).filter((l) => l.quantity > 0).map((l) => ({ occurrenceId: input.occurrenceId, offerId: l.offerId, quantity: l.quantity }));
  if (!lines.length) throw invalid("lines", "Choose at least one ticket");

  const prep = await withTenant(db, { tenantId }, async (tx) => {
    const channel = await offers.hostedChannel(tx);
    if (!channel?.active) throw new DomainError("not_on_sale", "The checkout is closed");
    // Share lock on the merchant: a disconnect waits for this payment to exist (and then refuses),
    // or, if it got there first, this sees the merchant disconnected and stops.
    const account = await tx.selectFrom("payments.provider_account").select(["id", "status"])
      .where("provider", "=", "vipps").where("status", "<>", "disconnected").forShare().executeTakeFirst();
    if (account?.status !== "active") throw new DomainError("not_on_sale", "Payment is not available right now");
    const c = caller(tenantId, channel.id);
    let r = await sales.reserve(tx, c, { lines, locale: input.locale }, now);

    if (r.total.amount === 0) {
      const done = await sales.confirm(tx, c, r.id, { externalOrderRef: `free-${r.id}`, buyer: { name: buyer.name, email: buyer.email, locale: r.locale } }, now);
      return { free: done };
    }
    if (r.expiresAt.getTime() < now.getTime() + offers.HOSTED_HOLD_MINUTES * MIN) {
      r = await sales.extendReservation(tx, c, r.id, { minutes: offers.HOSTED_HOLD_MINUTES }, now);
    }
    const id = newId();
    const reference = `em-${r.id.replace(/-/g, "")}`;
    await tx.insertInto("payments.payment").values({
      id, tenant_id: tenantId, provider_account_id: account.id, reservation_id: r.id, provider: "vipps", reference,
      amount: r.total.amount, currency: r.total.currency, buyer_name: buyer.name, buyer_email: buyer.email, buyer_phone: buyer.phone, created_at: now, updated_at: now,
    }).execute();
    const creds = (await credentialsFor(tx, tenantId, account.id))!;
    const token = await registration.issueToken(tx, tenantId, "checkout", id, 1);
    const shop = (await getAccount(tx)).name;
    const description = `${shop}: ${[...new Set(r.lines.map((l) => l.name))].join(", ")}`.slice(0, 100);
    return { free: null, id, reference, creds, token, amount: r.total, description, reservationId: r.id, channelId: channel.id };
  });

  if (prep.free) {
    const token = await withTenant(db, { tenantId }, (tx) => registration.issueToken(tx, tenantId, "checkout", prep.free.id, 0));
    return { kind: "free", reservationId: prep.free.id, token };
  }

  let redirectUrl: string;
  try {
    redirectUrl = (await deps.provider.createPayment(prep.creds, {
      reference: prep.reference, amount: { currency: prep.amount.currency, value: prep.amount.amount },
      returnUrl: returnUrl(deps, prep.token), description: prep.description, phoneNumber: buyer.phone,
    }, `create-${prep.id}`)).redirectUrl;
  } catch (e) {
    await withTenant(db, { tenantId }, async (tx) => {
      await sales.cancelReservation(tx, caller(tenantId, prep.channelId), prep.reservationId, {}, now).catch(() => undefined);
      await setState(tx, prep.id, "failed", { failure_reason: `Vipps could not create the payment: ${providerMessage(e)}`.slice(0, 500) });
    });
    throw new DomainError("conflict", "Vipps could not start the payment; try again");
  }
  await withTenant(db, { tenantId }, (tx) => tx.updateTable("payments.payment").set({ redirect_url: redirectUrl }).where("id", "=", prep.id).execute());
  return { kind: "pay", redirectUrl, paymentId: prep.id, token: prep.token };
}

// ── Processing ────────────────────────────────────────────────────────────────

type PaymentRow = {
  id: string; reservation_id: string; provider_account_id: string; reference: string; amount: number; currency: string; state: PaymentState;
  buyer_name: string | null; buyer_email: string | null;
};
const rowColumns = ["id", "reservation_id", "provider_account_id", "reference", "amount", "currency", "state", "buyer_name", "buyer_email"] as const;

async function setState(tx: Tx, id: string, state: PaymentState, extra: Partial<{ failure_reason: string | null; authorized_at: Date; captured_at: Date; cancelled_at: Date; aggregate: string }> = {}) {
  await tx.updateTable("payments.payment").set({ state, ...extra, version: sql<number>`version + 1` }).where("id", "=", id).execute();
}

const paymentEvent = async (tx: Tx, tenantId: string, type: string, row: PaymentRow, data: Record<string, unknown> = {}) =>
  emit(tx, tenantId, {
    type, subject: `payment/${row.id}`,
    data: { paymentId: row.id, reservationId: row.reservation_id, reference: row.reference, amount: { amount: row.amount, currency: row.currency }, ...data },
  });

/** Runs `fn` so that a failure rolls back only what it did. */
async function inSavepoint<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
  await sql`savepoint checkout_step`.execute(tx);
  try {
    const r = await fn();
    await sql`release savepoint checkout_step`.execute(tx);
    return r;
  } catch (e) {
    await sql`rollback to savepoint checkout_step`.execute(tx);
    throw e;
  }
}

type Action =
  | { kind: "none" }
  /** Capture what is not captured yet. */
  | { kind: "capture"; amount: number }
  | { kind: "cancel"; reason: string }
  /** Money was taken but the order could not stand: send the refund recorded in the decision. */
  | { kind: "refund"; refundId: string };

/**
 * Moves a payment on from what Vipps says about it (docs/checkout.md, the state table). Returns
 * the payment's state afterwards, or null for an unknown payment. Vipps not answering leaves
 * the payment as it was; the reconcile job tries again.
 */
export async function processPayment(
  db: Db, tenantId: string, paymentId: string,
  /** clock: the time when the capture's answer is settled; by default now, never before `now`. */
  deps: { provider: PaymentProvider; clock?: () => Date },
  now: Date = new Date(),
): Promise<PaymentState | null> {
  const first = await withTenant(db, { tenantId }, async (tx) => {
    const row = await tx.selectFrom("payments.payment").select(rowColumns).where("id", "=", paymentId).executeTakeFirst();
    if (!row) return null;
    return { row, creds: TERMINAL.includes(row.state) ? null : await credentialsFor(tx, tenantId, row.provider_account_id) };
  });
  if (!first) return null;
  if (!first.creds) return first.row.state;
  const creds = first.creds;
  // The time a decision is taken, sampled under the lock: a reconcile batch passes one `now` for
  // all its payments, and an occurrence may end while one waits its turn or a capture is out.
  const settleAt = () => (deps.clock ? deps.clock() : new Date(Math.max(now.getTime(), Date.now())));

  let remote: ProviderPayment;
  try {
    remote = await deps.provider.getPayment(creds, first.row.reference);
  } catch (e) {
    if (providerUnavailable(e)) return first.row.state;
    throw e;
  }

  const { row, action } = await withTenant(db, { tenantId }, async (tx) => {
    const row = await tx.selectFrom("payments.payment").select(rowColumns).where("id", "=", paymentId).forUpdate().executeTakeFirstOrThrow();
    const action = await decide(tx, tenantId, row, remote, settleAt());
    return { row, action };
  });

  if (action.kind === "refund") {
    await sendRefund(db, tenantId, action.refundId, deps);
    return "cancelled";
  }

  if (action.kind === "capture") {
    try {
      // The key names the amount: a merchant capturing part in the Vipps portal changes what is left.
      const key = action.amount === row.amount ? `capture-${row.id}` : `capture-${row.id}-${action.amount}`;
      await deps.provider.capture(creds, row.reference, { currency: row.currency, value: action.amount }, key);
    } catch (e) {
      if (providerUnavailable(e)) {
        // Vipps did not answer (or the payment is locked): the reconcile job captures later.
        await recordReason(db, tenantId, row.id, `Capture not done yet: ${providerMessage(e)}`);
        return "authorized";
      }
      // Vipps refused the capture: the buyer has not paid, so the order is called off. The tickets
      // go only once Vipps confirms the authorisation is cancelled; until then the capture is retried.
      return callOff(db, tenantId, row, creds, `Vipps refused the capture (${providerMessage(e)}); the order was cancelled`, deps, settleAt());
    }
    // The capture is done at Vipps. What it covers now (a portal refund may have come in between).
    // Without that answer nothing is activated: the reconcile job reads it again and settles it.
    const after = await deps.provider.getPayment(creds, row.reference).catch(() => null);
    if (!after) {
      await recordReason(db, tenantId, row.id, "Captured at Vipps; waiting to read the payment back before the tickets are activated");
      return "authorized";
    }
    const settled = await withTenant(db, { tenantId }, async (tx) => {
      const locked = await tx.selectFrom("payments.payment").select(rowColumns).where("id", "=", paymentId).forUpdate().executeTakeFirstOrThrow();
      // Settled meanwhile (the webhook or the return page got there first, maybe calling the order
      // off and refunding it): that outcome stands.
      if (TERMINAL.includes(locked.state)) return { state: locked.state, refundId: null };
      await storeAggregate(tx, row.id, after);
      // The time now, not when processing began: the occurrence may have ended while the capture was out.
      const at = settleAt();
      const captured = after.aggregate.capturedAmount.value;
      const refunded = after.aggregate.refundedAmount.value;
      const net = captured - refunded;
      // A successful answer is not proof of the capture: until Vipps shows the full amount captured
      // (and nothing refunded explains the gap), the payment stays open and the reconcile job reads
      // it again. Nothing is released and the authorisation is not given up.
      if (captured < row.amount && refunded === 0) {
        await tx.updateTable("payments.payment").set({ failure_reason: "Captured at Vipps, but Vipps does not show it yet; checking again" }).where("id", "=", row.id).execute();
        return { state: locked.state, refundId: null };
      }
      // Refunded at Vipps (in the portal) before the answer came: not paid for, as in decide.
      // Or no longer deliverable: give the money back.
      const gone = net < row.amount ? "refunded_at_vipps" : await unfulfillable(tx, row.reservation_id, at);
      if (gone) {
        if (net > 0) return { state: "cancelled" as const, refundId: await returnMoney(tx, tenantId, row, net, `Captured, but the order cannot stand (${gone}); the money still held is refunded`, at) };
        await releaseReservation(tx, tenantId, row.reservation_id, at);
        await setState(tx, row.id, "cancelled", { cancelled_at: at, failure_reason: `The order cannot stand (${gone})` });
        await paymentEvent(tx, tenantId, "payment.cancelled.v1", row, { reason: gone });
        return { state: "cancelled" as const, refundId: null };
      }
      await activateTickets(tx, row.reservation_id);
      await setState(tx, row.id, "captured", { captured_at: at, failure_reason: null });
      await paymentEvent(tx, tenantId, "payment.captured.v1", row);
      return { state: "captured" as const, refundId: null };
    });
    if (settled.refundId) await sendRefund(db, tenantId, settled.refundId, deps);
    return settled.state;
  }

  if (action.kind === "cancel") return callOff(db, tenantId, row, creds, action.reason, deps, settleAt());

  return withTenant(db, { tenantId }, async (tx) => (await tx.selectFrom("payments.payment").select("state").where("id", "=", paymentId).executeTakeFirstOrThrow()).state);
}

/** Keeps what Vipps last said about the payment: its state and the amounts authorised, captured, cancelled and refunded. */
async function storeAggregate(tx: Tx, paymentId: string, remote: ProviderPayment) {
  await tx.updateTable("payments.payment").set({ aggregate: JSON.stringify({ state: remote.state, ...remote.aggregate }) }).where("id", "=", paymentId).execute();
}

async function recordReason(db: Db, tenantId: string, paymentId: string, reason: string) {
  await withTenant(db, { tenantId }, (tx) => tx.updateTable("payments.payment").set({ failure_reason: reason.slice(0, 500) }).where("id", "=", paymentId).execute());
}

/**
 * Cancels the authorisation at Vipps and, once Vipps confirms it, releases the reservation (or its
 * tickets) and records the payment as cancelled. Vipps refusing the cancel is not taken as done:
 * the payment is read again, and only a cancelled amount or a final state (aborted, expired,
 * terminated) counts. Otherwise the payment stays as it is, with the reason, and the reconcile job
 * tries again.
 */
async function callOff(db: Db, tenantId: string, row: PaymentRow, creds: ProviderCredentials, reason: string, deps: { provider: PaymentProvider }, now: Date): Promise<PaymentState> {
  let done = false;
  try {
    await deps.provider.cancel(creds, row.reference, `cancel-${row.id}`);
    done = true;
  } catch (e) {
    if (!providerUnavailable(e)) {
      // Refused: already cancelled or final (fine), or still processing at Vipps (not yet).
      const now2 = await deps.provider.getPayment(creds, row.reference).catch(() => null);
      done = !!now2 && (now2.aggregate.cancelledAmount.value > 0 || ["ABORTED", "EXPIRED", "TERMINATED"].includes(now2.state));
    }
    if (!done) {
      await recordReason(db, tenantId, row.id, `${reason}; waiting for Vipps to confirm the cancellation (${providerMessage(e)})`);
      return row.state;
    }
  }
  // A cancel only covers what was not captured. Money captured meanwhile (in the Vipps portal) is given back.
  const after = await deps.provider.getPayment(creds, row.reference).catch(() => null);
  if (!after) {
    await recordReason(db, tenantId, row.id, `${reason}; cancelled at Vipps, checking what was captured`);
    return row.state;
  }
  const net = after.aggregate.capturedAmount.value - after.aggregate.refundedAmount.value;
  const refundId = await withTenant(db, { tenantId }, async (tx) => {
    const locked = await tx.selectFrom("payments.payment").select(rowColumns).where("id", "=", row.id).forUpdate().executeTakeFirstOrThrow();
    if (TERMINAL.includes(locked.state)) return null;
    // The snapshot the refund is sized from: what Vipps had refunded already is not refunded again.
    await storeAggregate(tx, row.id, after);
    if (net > 0) return returnMoney(tx, tenantId, row, net, `${reason}; ${net} was captured in Vipps and is refunded`, now);
    await releaseReservation(tx, tenantId, row.reservation_id, now);
    await setState(tx, row.id, "cancelled", { cancelled_at: now, failure_reason: reason.slice(0, 500) });
    await paymentEvent(tx, tenantId, "payment.cancelled.v1", row, { reason });
    return null;
  });
  if (refundId) await sendRefund(db, tenantId, refundId, deps);
  return withTenant(db, { tenantId }, async (tx) => (await tx.selectFrom("payments.payment").select("state").where("id", "=", row.id).executeTakeFirstOrThrow()).state);
}

/**
 * Money was taken for an order that cannot stand (captured in the Vipps portal before the tickets
 * could be issued, or captured in part and the rest cancelled): releases the reservation or its
 * tickets, records the payment as cancelled and a refund of the net captured amount, which the
 * caller sends. A refund Vipps does not answer is sent again by the reconcile job; one it refuses
 * is shown to staff in Sales, with a retry.
 */
async function returnMoney(tx: Tx, tenantId: string, row: PaymentRow, amount: number, reason: string, now: Date): Promise<string> {
  await releaseReservation(tx, tenantId, row.reservation_id, now);
  const id = newId();
  await tx.insertInto("payments.refund").values({
    id, tenant_id: tenantId, payment_id: row.id, amount, ticket_ids: [], idempotency_key: `refund-${id}`, created_by: null, created_at: now, updated_at: now,
  }).execute();
  await setState(tx, row.id, "cancelled", { cancelled_at: now, failure_reason: reason.slice(0, 500) });
  await paymentEvent(tx, tenantId, "payment.cancelled.v1", row, { reason, refunded: { amount, currency: row.currency } });
  return id;
}

/**
 * The reservation's hold expired while the payment still waited for the buyer (the sweeper's
 * reservation.expired). Cancels the payment at Vipps so it can no longer be approved, and records
 * it as expired. If the buyer approved meanwhile, it is processed as usual instead: confirm takes
 * the places again if they are free.
 */
export async function abandonPayment(db: Db, tenantId: string, paymentId: string, deps: { provider: PaymentProvider }, now: Date = new Date()): Promise<PaymentState | null> {
  const first = await withTenant(db, { tenantId }, async (tx) => {
    const row = await tx.selectFrom("payments.payment").select(rowColumns).where("id", "=", paymentId).executeTakeFirst();
    if (!row) return null;
    const r = await tx.selectFrom("sales.reservation").select("status").where("id", "=", row.reservation_id).executeTakeFirstOrThrow();
    return { row, held: r.status === "held", creds: row.state === "created" ? await credentialsFor(tx, tenantId, row.provider_account_id) : null };
  });
  if (!first) return null;
  if (!first.creds || first.held) return first.row.state;
  // Errors (Vipps not answering) fail the job, which retries.
  const remote = await deps.provider.getPayment(first.creds, first.row.reference);
  if (remote.state !== "CREATED") return processPayment(db, tenantId, paymentId, deps, now);
  try {
    // Only if the buyer still has not approved: an approval that wins the race is settled as usual.
    await deps.provider.cancel(first.creds, first.row.reference, `abandon-${paymentId}`, { transactionOnly: true });
  } catch (e) {
    // Approved or expired at Vipps meanwhile: settle it from what Vipps says now.
    if (!providerUnavailable(e)) return processPayment(db, tenantId, paymentId, deps, now);
    throw e;
  }
  return withTenant(db, { tenantId }, async (tx) => {
    const row = await tx.selectFrom("payments.payment").select(rowColumns).where("id", "=", paymentId).forUpdate().executeTakeFirstOrThrow();
    if (row.state !== "created") return row.state;
    await releaseReservation(tx, tenantId, row.reservation_id, now);
    await setState(tx, row.id, "expired", { failure_reason: "The hold expired before the buyer approved" });
    await paymentEvent(tx, tenantId, "payment.failed.v1", row, { providerState: "TERMINATED", reason: "hold_expired" });
    return "expired" as const;
  });
}

/** Decides what to do, under the lock on the payment, and records what needs no call to Vipps. */
async function decide(tx: Tx, tenantId: string, row: PaymentRow, remote: ProviderPayment, now: Date): Promise<Action> {
  if (TERMINAL.includes(row.state)) return { kind: "none" };
  await storeAggregate(tx, row.id, remote);
  const agg = remote.aggregate;

  if (remote.state === "CREATED") return { kind: "none" };

  const captured = agg.capturedAmount.value;
  const net = captured - agg.refundedAmount.value;

  if (remote.state === "AUTHORIZED") {
    if (captured >= row.amount && net < row.amount) {
      // Captured, then refunded in part or in full (in the Vipps portal) before we settled it: the
      // order is not paid for. Give back what is still held, and the tickets go.
      if (net > 0) return { kind: "refund", refundId: await returnMoney(tx, tenantId, row, net, "Captured and then partly refunded in Vipps; the rest is refunded and the order cancelled", now) };
      await releaseReservation(tx, tenantId, row.reservation_id, now);
      await setState(tx, row.id, "cancelled", { cancelled_at: now, failure_reason: "Captured and refunded in Vipps before the platform settled it" });
      await paymentEvent(tx, tenantId, "payment.cancelled.v1", row, { reason: "refunded at Vipps" });
      return { kind: "none" };
    }
    if (captured >= row.amount) {
      // Fully captured at Vipps but not recorded here: we crashed after capturing, or the merchant
      // captured in the Vipps portal. Not confirmed yet: confirm now, or give the money back.
      if (row.state === "created") {
        const failed = await confirmTickets(tx, tenantId, row, now);
        if (failed) return { kind: "refund", refundId: await returnMoney(tx, tenantId, row, net, `Captured in Vipps, but the tickets could not be issued (${failed}); the money is refunded`, now) };
        await setState(tx, row.id, "authorized", { authorized_at: now });
        await paymentEvent(tx, tenantId, "payment.authorized.v1", row);
      }
      // Paid, but the order may no longer be deliverable (occurrence cancelled or ended, tickets
      // cancelled): give the money back rather than activate tickets nobody can use.
      const gone = await unfulfillable(tx, row.reservation_id, now);
      if (gone) return { kind: "refund", refundId: await returnMoney(tx, tenantId, row, net, `Captured in Vipps, but the order can no longer be fulfilled (${gone}); the money is refunded`, now) };
      await activateTickets(tx, row.reservation_id);
      await setState(tx, row.id, "captured", { captured_at: now, failure_reason: null });
      await paymentEvent(tx, tenantId, "payment.captured.v1", row);
      return { kind: "none" };
    }
    if (agg.cancelledAmount.value > 0) {
      // The rest was cancelled at Vipps. Anything captured before that is not the whole price: give it back.
      if (net > 0) return { kind: "refund", refundId: await returnMoney(tx, tenantId, row, net, "Part of the payment was captured and the rest cancelled in Vipps; the captured part is refunded", now) };
      await releaseReservation(tx, tenantId, row.reservation_id, now);
      await setState(tx, row.id, "cancelled", { cancelled_at: now });
      await paymentEvent(tx, tenantId, "payment.cancelled.v1", row, { reason: "cancelled at Vipps" });
      return { kind: "none" };
    }
    if (agg.refundedAmount.value > 0) {
      // Captured in part and refunded in the Vipps portal, the rest still authorised: the order is
      // being reversed, not paid. Cancel the rest; anything still held is refunded (callOff).
      return { kind: "cancel", reason: "Part of the payment was captured and refunded in Vipps; the order was cancelled" };
    }
    if (row.state === "created") {
      const failed = await confirmTickets(tx, tenantId, row, now);
      if (failed) return { kind: "cancel", reason: `The tickets could not be issued (${failed}); the payment was cancelled` };
      await setState(tx, row.id, "authorized", { authorized_at: now });
      await paymentEvent(tx, tenantId, "payment.authorized.v1", row);
    }
    // Charge only for an order that can still be fulfilled: the occurrence may have been cancelled
    // or ended, or the tickets cancelled, while the capture waited.
    const gone = await unfulfillable(tx, row.reservation_id, now);
    if (gone) return { kind: "cancel", reason: `The order can no longer be fulfilled (${gone}); the payment was cancelled` };
    return { kind: "capture", amount: row.amount - captured };
  }

  // ABORTED (the buyer said no), EXPIRED (no answer), TERMINATED (cancelled).
  // If confirm had issued tickets (the authorisation went away before capture), they go too, and
  // anything captured before it ended is given back.
  if (net > 0) return { kind: "refund", refundId: await returnMoney(tx, tenantId, row, net, `The payment ended at Vipps (${remote.state}) after part of it was captured; the captured part is refunded`, now) };
  const state: PaymentState = remote.state === "ABORTED" ? "failed" : remote.state === "EXPIRED" ? "expired" : "cancelled";
  await releaseReservation(tx, tenantId, row.reservation_id, now);
  await setState(tx, row.id, state, state === "cancelled" ? { cancelled_at: now } : {});
  await paymentEvent(tx, tenantId, state === "cancelled" ? "payment.cancelled.v1" : "payment.failed.v1", row, { providerState: remote.state });
  return { kind: "none" };
}

async function reservationChannel(tx: Tx, reservationId: string): Promise<string> {
  return (await tx.selectFrom("sales.reservation").select("channel_id").where("id", "=", reservationId).executeTakeFirstOrThrow()).channel_id;
}

/** Why a confirmed order can no longer be delivered, or null when it can. */
async function unfulfillable(tx: Tx, reservationId: string, now: Date): Promise<string | null> {
  const r = await tx.selectFrom("sales.reservation").select("status").where("id", "=", reservationId).executeTakeFirstOrThrow();
  if (r.status !== "confirmed") return "not_confirmed";
  const valid = await tx.selectFrom("sales.ticket").select("id").where("reservation_id", "=", reservationId).where("status", "=", "valid").executeTakeFirst();
  if (!valid) return "tickets_cancelled";
  const occs = await tx.selectFrom("sales.reservation_line as l").innerJoin("catalog.occurrence as o", "o.id", "l.occurrence_id").innerJoin("catalog.event as e", "e.id", "o.event_id")
    .select(["o.status", "o.end_utc", "e.status as event_status"]).where("l.reservation_id", "=", reservationId).execute();
  if (occs.some((o) => o.status === "cancelled" || o.event_status === "cancelled")) return "occurrence_cancelled";
  if (occs.some((o) => o.end_utc <= now)) return "occurrence_ended";
  return null;
}

/**
 * Confirms the reservation for the payment: the places are committed, and the tickets admit no
 * one and get no links until capture. Returns the reason code when it cannot be confirmed.
 */
async function confirmTickets(tx: Tx, tenantId: string, row: PaymentRow, now: Date): Promise<string | null> {
  const channelId = await reservationChannel(tx, row.reservation_id);
  try {
    await inSavepoint(tx, async () => {
      const locale = (await tx.selectFrom("sales.reservation").select("locale").where("id", "=", row.reservation_id).executeTakeFirstOrThrow()).locale;
      await sales.confirm(tx, caller(tenantId, channelId), row.reservation_id, { externalOrderRef: row.reference, buyer: { name: row.buyer_name, email: row.buyer_email, locale } }, now, { admissionsPending: true });
    });
    return null;
  } catch (e) {
    if (!(e instanceof DomainError)) throw e;
    // A deactivated channel cannot confirm either; say so in plain words.
    return e.code === "forbidden" ? "channel_inactive" : e.code;
  }
}

/** Paid: the tickets' admissions start to admit, and the tickets get their links. */
async function activateTickets(tx: Tx, reservationId: string) {
  const tickets = await tx.selectFrom("sales.ticket").select("id").where("reservation_id", "=", reservationId).where("status", "=", "valid").execute();
  await admission.activateTicketAdmissions(tx, tickets.map((t) => t.id));
}

/**
 * Releases the places, or cancels the tickets if confirm already issued them, also when staff
 * have deactivated the hosted channel since. Nothing when the reservation is cancelled already.
 */
async function releaseReservation(tx: Tx, tenantId: string, reservationId: string, now: Date) {
  try {
    await inSavepoint(tx, () => sales.releaseForPlatform(tx, tenantId, reservationId, now));
  } catch (e) {
    // occurrence_started: tickets for a show that has begun stay; staff settle it.
    if (!(e instanceof DomainError)) throw e;
  }
}

// ── Status, for the return page ─────────────────────────────────────────────────

export interface CheckoutStatus {
  state: PaymentState | "free";
  reservation: sales.Reservation;
  accountName: string;
  /** VAT per rate, for the receipt. */
  vat: { ratePct: number; amount: number }[];
  reference: string | null;
  /**
   * Money given back through Vipps for a cancelled order that had been charged: the total, in the
   * Vipps portal and by the platform, how far the platform's part has got (done, pending: sent again
   * until Vipps answers, failed: staff follow it up), and how much of it is not back yet. Null:
   * nothing to give back.
   */
  refund: { amount: number; state: "done" | "pending" | "failed"; outstanding: number } | null;
}

/** The payment behind a checkout token (or the free reservation), with the reservation. Null for an invalid token. */
export async function checkoutStatus(tx: Tx, token: string, now: Date = new Date()): Promise<CheckoutStatus | null> {
  const account = await getAccount(tx);
  if (checkoutTokenTenant(token) !== account.id) return null;
  const claims = await registration.verifyToken(tx, token, "checkout");
  if (!claims) return null;
  // Version 0: a free checkout, whose subject is the reservation; version 1: a payment.
  let reservationId = claims.subjectId;
  let state: CheckoutStatus["state"] = "free";
  let reference: string | null = null;
  let portalRefunded = 0;
  if (claims.tokenVersion !== 0) {
    const p = await tx.selectFrom("payments.payment").select(["reservation_id", "state", "reference", "aggregate"]).where("id", "=", claims.subjectId).executeTakeFirst();
    if (!p) return null;
    ({ reservation_id: reservationId, state, reference } = p);
    // What Vipps last said had been refunded, including refunds made in its portal.
    portalRefunded = Number((p.aggregate as { refundedAmount?: { value?: number } } | null)?.refundedAmount?.value ?? 0);
  }
  const r = await tx.selectFrom("sales.reservation").select("id").where("id", "=", reservationId).executeTakeFirst();
  if (!r) return null;
  // The signed token is the buyer's access. Not as the channel: a completed order stays readable
  // after staff deactivate the hosted channel.
  const reservation = await sales.getReservationView(tx, claims.tenantId, reservationId, now);
  // Only refunds the platform made when it called the order off (no tickets named); staff refunds of tickets show in Sales.
  const refunds = claims.tokenVersion === 0 ? [] : await tx.selectFrom("payments.refund").select(["amount", "state"])
    .where("payment_id", "=", claims.subjectId).where(sql<boolean>`cardinality(ticket_ids) = 0`).execute();
  // The platform sizes its refund from the Vipps snapshot it stores alongside (captured minus what
  // Vipps had refunded then), so the snapshot's refunds are the portal's, and the two add up.
  const ours = refunds.reduce((s, r) => s + r.amount, 0);
  const outstanding = refunds.filter((r) => r.state !== "done").reduce((s, r) => s + r.amount, 0);
  const refund = refunds.length || (state === "cancelled" && portalRefunded > 0)
    ? {
        amount: portalRefunded + ours,
        state: refunds.some((r) => r.state === "failed") ? ("failed" as const) : refunds.some((r) => r.state === "pending") ? ("pending" as const) : ("done" as const),
        outstanding,
      }
    : null;
  return { state, reservation, accountName: account.name, vat: vatPerRate(reservation.lines), reference, refund };
}

/** The tenant a checkout token names, unverified: the caller opens that tenant's transaction to verify it. */
export function checkoutTokenTenant(token: string): string | null {
  const c = registration.peekToken(token);
  return c?.purpose === "checkout" ? c.tenantId : null;
}

/** Verifies a checkout token and gives its payment id; null for a free checkout or an invalid token. */
export async function paymentOfToken(tx: Tx, token: string): Promise<string | null> {
  if (checkoutTokenTenant(token) !== (await getAccount(tx)).id) return null;
  const c = await registration.verifyToken(tx, token, "checkout");
  return c && c.tokenVersion !== 0 ? c.subjectId : null;
}

// ── Receipts ──────────────────────────────────────────────────────────────────

/** VAT included in an amount at a rate (minor units, rounded). */
export const vatIn = (amount: number, ratePct: number) => Math.round((amount * ratePct) / (100 + ratePct));

export function vatPerRate(lines: readonly { amount: number; vatRatePct: number }[]): { ratePct: number; amount: number }[] {
  const by = new Map<number, number>();
  for (const l of lines) by.set(l.vatRatePct, (by.get(l.vatRatePct) ?? 0) + l.amount);
  return [...by.entries()].sort((a, b) => b[0] - a[0]).map(([ratePct, amount]) => ({ ratePct, amount: vatIn(amount, ratePct) }));
}

export interface Receipt {
  paymentId: string;
  reference: string;
  capturedAt: Date;
  locale: string;
  buyer: { name: string | null; email: string | null };
  merchant: { name: string; legalName: string | null; orgNumber: string | null; address: string | null; vatRegistered: boolean };
  lines: { name: string; quantity: number; unitPrice: number; amount: number; vatRatePct: number; vat: number }[];
  total: { amount: number; currency: string };
  vat: { ratePct: number; amount: number }[];
  /** Already sent (email and Vipps app). */
  sentAt: Date | null;
}

/** The receipt for a captured payment, from the frozen snapshot and the merchant details. Null until captured. */
export async function receiptFor(tx: Tx, paymentId: string): Promise<Receipt | null> {
  const p = await tx.selectFrom("payments.payment")
    .select(["id", "reference", "state", "captured_at", "reservation_id", "buyer_name", "buyer_email", "amount", "currency", "receipt_sent_at"])
    .where("id", "=", paymentId).executeTakeFirst();
  if (!p || p.state !== "captured" || !p.captured_at) return null;
  const account = await getAccount(tx);
  const r = await tx.selectFrom("sales.reservation").select("locale").where("id", "=", p.reservation_id).executeTakeFirstOrThrow();
  const lines = (await tx.selectFrom("sales.reservation_line").select(["line_name", "quantity", "unit_price", "vat_rate_pct"]).where("reservation_id", "=", p.reservation_id).orderBy("line_no").execute())
    .map((l) => {
      const amount = l.unit_price * l.quantity;
      const rate = Number(l.vat_rate_pct);
      return { name: l.line_name, quantity: l.quantity, unitPrice: l.unit_price, amount, vatRatePct: rate, vat: vatIn(amount, rate) };
    });
  return {
    paymentId: p.id, reference: p.reference, capturedAt: p.captured_at, locale: r.locale,
    buyer: { name: p.buyer_name, email: p.buyer_email },
    merchant: { name: account.name, ...account.merchant },
    lines, total: { amount: p.amount, currency: p.currency }, vat: vatPerRate(lines), sentAt: p.receipt_sent_at,
  };
}

/** Marks the receipt sent; false if it already was (another job got there first). */
export async function markReceiptSent(tx: Tx, paymentId: string, now: Date = new Date()): Promise<boolean> {
  const r = await tx.updateTable("payments.payment").set({ receipt_sent_at: now }).where("id", "=", paymentId).where("receipt_sent_at", "is", null).executeTakeFirst();
  return Number(r.numUpdatedRows) > 0;
}

/** Sends the receipt to the buyer's Vipps app (Order Management). Best effort: the email is the receipt of record. */
export async function sendReceiptToProvider(db: Db, tenantId: string, paymentId: string, deps: { provider: PaymentProvider }): Promise<void> {
  const prep = await withTenant(db, { tenantId }, async (tx) => {
    const receipt = await receiptFor(tx, paymentId);
    if (!receipt) return null;
    const p = await tx.selectFrom("payments.payment").select("provider_account_id").where("id", "=", paymentId).executeTakeFirstOrThrow();
    return { receipt, creds: await credentialsFor(tx, tenantId, p.provider_account_id) };
  });
  if (!prep?.creds) return;
  const creds: ProviderCredentials = prep.creds;
  const { receipt } = prep;
  await deps.provider.sendReceipt(creds, receipt.reference, {
    currency: receipt.total.currency,
    receiptNumber: receipt.reference,
    lines: receipt.lines.map((l, i) => ({
      name: l.name, id: String(i + 1), totalAmount: l.amount, totalAmountExcludingTax: l.amount - l.vat, totalTaxAmount: l.vat,
      taxPercentage: Math.round(l.vatRatePct), unitPrice: l.unitPrice, quantity: l.quantity,
    })),
  });
}

/** The tenant of a published ticketed event's occurrence, for the buy page; runs without a tenant (SECURITY DEFINER lookup). */
export async function checkoutOccurrenceTenant(tx: Tx, occurrenceId: string): Promise<string | null> {
  const r = await sql<{ id: string | null }>`select payments.checkout_occurrence_tenant(${occurrenceId}::uuid) as id`.execute(tx);
  return r.rows[0]?.id ?? null;
}

/** The worker's job that settles one payment (apps/worker/src/payments.ts). */
export const PROCESS_PAYMENT_JOB = "payments.process";

/** Queues processPayment for the worker; the job key collapses repeats while one is waiting. */
export async function queueProcessing(tx: Tx, tenantId: string, paymentId: string): Promise<void> {
  await sql`select graphile_worker.add_job(
    ${PROCESS_PAYMENT_JOB},
    json_build_object('tenantId', ${tenantId}::text, 'paymentId', ${paymentId}::text),
    job_key := ${`payment:${paymentId}`},
    max_attempts := 10)`.execute(tx);
}

// ── Reconcile ─────────────────────────────────────────────────────────────────

/** Accounts with payments not settled since `before`; runs without a tenant (SECURITY DEFINER lookup). */
export async function openPaymentTenants(tx: Tx, before: Date): Promise<string[]> {
  const r = await sql<{ id: string }>`select payments.open_payment_tenants(${before}) as id`.execute(tx);
  return r.rows.map((x) => x.id);
}

/** A tenant's payments in created or authorized, unchanged since `before`, oldest first. */
export async function openPayments(tx: Tx, before: Date, limit = 200): Promise<string[]> {
  const rows = await tx.selectFrom("payments.payment").select("id").where("state", "in", ["created", "authorized"]).where("updated_at", "<=", before).orderBy("updated_at").limit(limit).execute();
  return rows.map((r) => r.id);
}

/** The payment for a reservation, if it was made in the hosted checkout. */
export async function paymentForReservation(tx: Tx, reservationId: string): Promise<{ id: string; state: PaymentState } | null> {
  return (await tx.selectFrom("payments.payment").select(["id", "state"]).where("reservation_id", "=", reservationId).executeTakeFirst()) ?? null;
}

/** The payment with a Vipps reference (webhooks name it). */
export async function paymentByReference(tx: Tx, reference: string): Promise<string | null> {
  return (await tx.selectFrom("payments.payment").select("id").where("reference", "=", reference).executeTakeFirst())?.id ?? null;
}
