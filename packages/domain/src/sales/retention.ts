import { sql, type Tx } from "@event-manager/db";
import { retentionCutoffs } from "../registration/index.js";
import { getAccount } from "../tenancy/index.js";

// Buyer retention (docs/ticketing.md, "Reservation"): buyers are personal data with the same
// retention as registrations. anonymiseAfterMonths after the last occurrence a reservation has
// lines at ends, the buyer's name, email and locale go, the ticket links and QR codes stop
// working and the admissions are voided. Lines, prices, SKUs, order and refund references and
// ticket statuses stay, so sales can still be reconciled. Idempotent; run nightly per tenant.

const BATCH = 500;

export async function applySalesRetention(tx: Tx, now: Date = new Date()): Promise<{ reservationsAnonymised: number }> {
  const account = await getAccount(tx);
  const { anonymise } = retentionCutoffs(now, account);
  let n = 0;
  for (;;) {
    const due = await tx.selectFrom("sales.reservation as r")
      .select("r.id")
      .where("r.anonymised_at", "is", null)
      .where(sql<boolean>`(select max(o.end_utc) from sales.reservation_line l join catalog.occurrence o on o.id = l.occurrence_id where l.reservation_id = r.id) < ${anonymise}`)
      .orderBy("r.id").limit(BATCH).forUpdate().execute();
    if (!due.length) break;
    const ids = due.map((r) => r.id);
    await tx.updateTable("sales.reservation").set({ buyer_name: null, buyer_email: null, buyer_locale: null, anonymised_at: now }).where("id", "in", ids).execute();
    const tickets = await tx.updateTable("sales.ticket").set({ token_version: sql<number>`token_version + 1` }).where("reservation_id", "in", ids).returning("id").execute();
    if (tickets.length) {
      await tx.updateTable("admission.admission").set({ status: "void" }).where("ticket_id", "in", tickets.map((t) => t.id)).execute();
    }
    n += ids.length;
    if (due.length < BATCH) break;
  }
  return { reservationsAnonymised: n };
}
