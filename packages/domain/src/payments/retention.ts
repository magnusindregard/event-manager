import { sql, type Tx } from "@event-manager/db";

// Buyer retention for hosted payments (docs/checkout.md, "Data"). The checkout keeps its own copy
// of the buyer (name, email, phone) on the payment, for the tickets email and the receipt. It goes
// at the same cutoff as the reservation's buyer: once retention has anonymised the reservation
// (sales/retention.ts, also abandoned checkouts), the payment's copy is cleared too. Amounts,
// states, references and refunds stay, so payments can still be reconciled. Idempotent; run
// nightly per tenant, after the sales retention.

export async function applyPaymentRetention(tx: Tx): Promise<{ paymentsAnonymised: number }> {
  const res = await tx.updateTable("payments.payment")
    .set({ buyer_name: null, buyer_email: null, buyer_phone: null })
    .where((eb) => eb.or([eb("buyer_name", "is not", null), eb("buyer_email", "is not", null), eb("buyer_phone", "is not", null)]))
    .where(sql<boolean>`exists (select 1 from sales.reservation r where r.id = payments.payment.reservation_id and r.anonymised_at is not null)`)
    .executeTakeFirst();
  return { paymentsAnonymised: Number(res.numUpdatedRows) };
}
