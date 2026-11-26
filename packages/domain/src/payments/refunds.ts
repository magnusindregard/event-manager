import { type Db, newId, type RefundState, sql, type Tx, withTenant } from "@event-manager/db";
import { emit } from "../outbox/index.js";
import * as sales from "../sales/index.js";
import { type ActorContext, DomainError } from "../shared/index.js";
import { assertCan } from "../tenancy/index.js";
import { credentialsFor } from "./accounts.js";
import { type PaymentProvider, providerMessage, providerUnavailable } from "./provider.js";

// Refunds of hosted sales (docs/checkout.md, "Refunds"). Staff cancel tickets of a hosted
// reservation and the platform gives those tickets' amounts back through Vipps:
//   1. one transaction cancels the tickets (their places go back on sale) and records a pending
//      refund, whose idempotency key is also the tickets' externalRefundRef;
//   2. the refund is sent to Vipps with that key;
//   3. the refund is marked done (payment.refunded.v1), or failed with Vipps' reason.
// A refund Vipps did not answer stays pending and the reconcile job sends it again; one Vipps
// refused can be retried by staff. Either way the same key, so the money moves once.
//
// Staff confirm the amount first: the request carries the amount they were shown, and a
// different amount (someone cancelled tickets meanwhile) is refused.

export interface Refund {
  id: string;
  paymentId: string;
  amount: number;
  ticketIds: string[];
  state: RefundState;
  failureReason: string | null;
  reference: string;
  createdAt: Date;
}

export interface PaymentSummary {
  id: string;
  state: string;
  reference: string;
  amount: { amount: number; currency: string };
  /** Refunded through Vipps so far (done). */
  refunded: number;
  refunds: Refund[];
}

const columns = ["id", "payment_id", "amount", "ticket_ids", "state", "failure_reason", "idempotency_key", "created_at"] as const;
type Row = { id: string; payment_id: string; amount: number; ticket_ids: string[]; state: RefundState; failure_reason: string | null; idempotency_key: string; created_at: Date };
const toRefund = (r: Row): Refund => ({
  id: r.id, paymentId: r.payment_id, amount: r.amount, ticketIds: r.ticket_ids, state: r.state, failureReason: r.failure_reason, reference: r.idempotency_key, createdAt: r.created_at,
});

/** The hosted payments of these reservations, with their refunds; reservations without one are left out. */
export async function paymentSummaries(tx: Tx, reservationIds: readonly string[]): Promise<Map<string, PaymentSummary>> {
  const out = new Map<string, PaymentSummary>();
  if (!reservationIds.length) return out;
  const pays = await tx.selectFrom("payments.payment").select(["id", "reservation_id", "state", "reference", "amount", "currency"]).where("reservation_id", "in", reservationIds).execute();
  if (!pays.length) return out;
  const refunds = await tx.selectFrom("payments.refund").select(columns).where("payment_id", "in", pays.map((p) => p.id)).orderBy("created_at").execute();
  for (const p of pays) {
    const rs = refunds.filter((r) => r.payment_id === p.id).map(toRefund);
    out.set(p.reservation_id, {
      id: p.id, state: p.state, reference: p.reference, amount: { amount: p.amount, currency: p.currency },
      refunded: rs.filter((r) => r.state === "done").reduce((s, r) => s + r.amount, 0), refunds: rs,
    });
  }
  return out;
}

export interface RefundInput {
  /** The tickets to cancel and refund; all valid tickets when left out. */
  ticketIds?: string[] | null;
  /** The amount staff were shown and confirmed, in minor units. */
  amount: number;
}

/**
 * Staff (sales.write): cancels tickets of a hosted reservation and refunds them through Vipps.
 * Throws conflict when the reservation was not paid in the hosted checkout or the amount is not
 * what the tickets cost, and the cancel's reasons (already_cancelled, occurrence_started).
 * Returns the refund: done, pending (Vipps did not answer; it is sent again) or failed; null
 * when the tickets were free, so they are cancelled and nothing is refunded.
 */
export async function refundTickets(db: Db, ctx: ActorContext, reservationId: string, input: RefundInput, deps: { provider: PaymentProvider }, now: Date = new Date()): Promise<Refund | null> {
  assertCan(ctx, "sales.write");
  const refundId = await withTenant(db, ctx, async (tx) => {
    const p = await tx.selectFrom("payments.payment").select(["id", "state", "amount", "reference", "provider_account_id"]).where("reservation_id", "=", reservationId).forUpdate().executeTakeFirst();
    if (!p) throw new DomainError("conflict", "The reservation was not paid in the hosted checkout; refund it in its channel");
    if (p.state !== "captured") throw new DomainError("conflict", "The payment is not captured, so there is nothing to refund yet");
    // Share lock on the merchant: a disconnect then either sees this refund pending (and waits),
    // or has finished, and this refuses before any ticket is cancelled.
    const merchant = await tx.selectFrom("payments.provider_account").select(["credentials"]).where("id", "=", p.provider_account_id).forShare().executeTakeFirstOrThrow();
    if (!merchant.credentials) throw new DomainError("conflict", "The Vipps merchant this was paid with is disconnected; connect it again to refund");

    const tickets = await tx.selectFrom("sales.ticket as t").innerJoin("sales.reservation_line as l", "l.id", "t.line_id")
      .select(["t.id", "t.status", "l.unit_price"]).where("t.reservation_id", "=", reservationId).execute();
    const chosen = input.ticketIds ? tickets.filter((t) => input.ticketIds!.includes(t.id)) : tickets.filter((t) => t.status === "valid");
    const amount = chosen.reduce((s, t) => s + t.unit_price, 0);
    if (!Number.isInteger(input.amount) || input.amount !== amount) {
      throw new DomainError("conflict", "The amount is not what these tickets cost; look again", { amount });
    }
    const id = newId();
    const key = `refund-${id}`;
    // Cancels the tickets (and checks them: listed ones exist and are valid, the show has not started).
    await sales.cancelTicketsAsStaff(tx, ctx, reservationId, { ticketIds: chosen.map((t) => t.id), externalRefundRef: key }, now);
    const refunded = await tx.selectFrom("payments.refund").select((eb) => eb.fn.coalesce(eb.fn.sum<number>("amount"), sql<number>`0`).as("n"))
      .where("payment_id", "=", p.id).where("state", "<>", "failed").executeTakeFirstOrThrow();
    if (Number(refunded.n) + amount > p.amount) throw new DomainError("conflict", "More than was paid would be refunded");
    if (amount > 0) {
      await tx.insertInto("payments.refund").values({
        id, tenant_id: ctx.tenantId, payment_id: p.id, amount, ticket_ids: chosen.map((t) => t.id), idempotency_key: key, created_by: ctx.userId, created_at: now, updated_at: now,
      }).execute();
    }
    return amount > 0 ? id : null;
  });
  if (!refundId) return null;
  return sendRefund(db, ctx.tenantId, refundId, deps);
}

/** Staff (sales.write): sends a failed refund again, with the same key. */
export async function retryRefund(db: Db, ctx: ActorContext, refundId: string, deps: { provider: PaymentProvider }): Promise<Refund> {
  assertCan(ctx, "sales.write");
  const r = await withTenant(db, ctx, (tx) => tx.selectFrom("payments.refund").select(columns).where("id", "=", refundId).executeTakeFirst());
  if (!r) throw new DomainError("not_found", "Refund not found");
  if (r.state === "done") return toRefund(r);
  return sendRefund(db, ctx.tenantId, refundId, deps);
}

/** Sends a pending or failed refund to Vipps and records the outcome. */
export async function sendRefund(db: Db, tenantId: string, refundId: string, deps: { provider: PaymentProvider }): Promise<Refund> {
  const prep = await withTenant(db, { tenantId }, async (tx) => {
    const r = await tx.selectFrom("payments.refund as r").innerJoin("payments.payment as p", "p.id", "r.payment_id")
      .select(["r.id", "r.amount", "r.idempotency_key", "r.state", "p.reference", "p.currency", "p.provider_account_id", "p.id as payment_id", "p.reservation_id"])
      .where("r.id", "=", refundId).executeTakeFirstOrThrow();
    return { r, creds: r.state === "done" ? null : await credentialsFor(tx, tenantId, r.provider_account_id) };
  });
  const { r } = prep;
  if (r.state !== "done") {
    let outcome: { state: RefundState; reason: string | null };
    if (!prep.creds) {
      outcome = { state: "failed", reason: "Vipps MobilePay is disconnected; connect it again and retry" };
    } else {
      try {
        await deps.provider.refund(prep.creds, r.reference, { currency: r.currency, value: r.amount }, r.idempotency_key);
        outcome = { state: "done", reason: null };
      } catch (e) {
        outcome = providerUnavailable(e) ? { state: "pending", reason: `Vipps did not answer; sent again later. (${providerMessage(e)})` } : { state: "failed", reason: providerMessage(e) };
      }
    }
    await withTenant(db, { tenantId }, async (tx) => {
      const locked = await tx.selectFrom("payments.refund").select("state").where("id", "=", refundId).forUpdate().executeTakeFirstOrThrow();
      if (locked.state === "done") return;
      await tx.updateTable("payments.refund").set({ state: outcome.state, failure_reason: outcome.reason?.slice(0, 500) ?? null }).where("id", "=", refundId).execute();
      if (outcome.state === "done") {
        await emit(tx, tenantId, {
          type: "payment.refunded.v1", subject: `payment/${r.payment_id}`,
          data: { paymentId: r.payment_id, reservationId: r.reservation_id, refundId, reference: r.reference, refundReference: r.idempotency_key, amount: { amount: r.amount, currency: r.currency } },
        });
      }
    });
  }
  return withTenant(db, { tenantId }, async (tx) => toRefund(await tx.selectFrom("payments.refund").select(columns).where("id", "=", refundId).executeTakeFirstOrThrow()));
}

/** A tenant's refunds Vipps did not answer, unchanged since `before`; the reconcile job sends them again. */
export async function pendingRefunds(tx: Tx, before: Date, limit = 200): Promise<string[]> {
  const rows = await tx.selectFrom("payments.refund").select("id").where("state", "=", "pending").where("updated_at", "<=", before).orderBy("updated_at").limit(limit).execute();
  return rows.map((r) => r.id);
}
