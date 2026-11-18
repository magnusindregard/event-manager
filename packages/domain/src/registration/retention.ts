import { sql, type Tx } from "@event-manager/db";
import { getAccount } from "../tenancy/index.js";
import { deleteAnswers } from "./forms.js";

// Retention (docs/registration.md, "Retention"), run nightly per tenant by the worker:
//   - sensitive answers are deleted sensitiveDeleteAfterDays after the occurrence ends (default 30);
//   - registrations are anonymised anonymiseAfterMonths after it (default 12): name, email and
//     all answers go, links stop working and the admission is voided, but the row, status and
//     party size stay, so counts per occurrence remain exact;
//   - an accepted invitation goes with its registration; other invitations go when the event's
//     last occurrence is the same period in the past;
//   - staged guest list uploads that were never imported go after a day.
// Every step is idempotent, so a failed run is simply repeated the next night.

export interface RetentionResult {
  sensitiveDeleted: number;
  anonymised: number;
  invitationsDeleted: number;
  importsDeleted: number;
}

const BATCH = 500;

/** Pure: the cut-offs for occurrences that ended before them. */
export function retentionCutoffs(now: Date, policy: { sensitiveDeleteAfterDays: number; anonymiseAfterMonths: number }) {
  const sensitive = new Date(now.getTime() - policy.sensitiveDeleteAfterDays * 86_400_000);
  const anonymise = new Date(now);
  anonymise.setUTCMonth(anonymise.getUTCMonth() - policy.anonymiseAfterMonths);
  return { sensitive, anonymise };
}

/** Registrations of occurrences that ended before the cut-off. */
const endedBefore = (cutoff: Date) =>
  sql<string>`(select r.id from registration.registration r join catalog.occurrence o on o.id = r.occurrence_id where o.end_utc < ${cutoff})`;

export async function applyRetention(tx: Tx, now: Date = new Date()): Promise<RetentionResult> {
  const account = await getAccount(tx);
  const cut = retentionCutoffs(now, account);
  const result: RetentionResult = { sensitiveDeleted: 0, anonymised: 0, invitationsDeleted: 0, importsDeleted: 0 };

  const sens = await tx.deleteFrom("registration.sensitive_answer").where("registration_id", "in", endedBefore(cut.sensitive)).executeTakeFirst();
  result.sensitiveDeleted = Number(sens.numDeletedRows);

  for (;;) {
    const due = await tx.selectFrom("registration.registration as r")
      .innerJoin("catalog.occurrence as o", "o.id", "r.occurrence_id")
      .select(["r.id", "r.invitation_id", "r.status"])
      .where("r.anonymised_at", "is", null).where("o.end_utc", "<", cut.anonymise)
      .orderBy("r.id").limit(BATCH).forUpdate("r").execute();
    if (due.length === 0) break;
    const ids = due.map((r) => r.id);
    await deleteAnswers(tx, ids);
    await tx.updateTable("admission.admission").set({ status: "void" }).where("registration_id", "in", ids).execute();
    await tx.updateTable("registration.registration")
      .set({ name: null, email: null, anonymised_at: now, token_version: sql<number>`token_version + 1` })
      .where("id", "in", ids).execute();
    // The invitation that led to an active registration is spent; it holds the same name and email.
    const spent = due.filter((r) => r.invitation_id && r.status !== "cancelled").map((r) => r.invitation_id!);
    if (spent.length) {
      const d = await tx.deleteFrom("registration.guest_invitation").where("id", "in", spent).executeTakeFirst();
      result.invitationsDeleted += Number(d.numDeletedRows);
    }
    result.anonymised += ids.length;
    if (due.length < BATCH) break;
  }

  // Events whose last occurrence ended before the cut-off.
  const inv = await tx.deleteFrom("registration.guest_invitation")
    .where("event_id", "in", sql<string>`(select o.event_id from catalog.occurrence o group by o.event_id having max(o.end_utc) < ${cut.anonymise})`)
    .executeTakeFirst();
  result.invitationsDeleted += Number(inv.numDeletedRows);

  const imp = await tx.deleteFrom("registration.guest_import").where("expires_at", "<=", now).executeTakeFirst();
  result.importsDeleted = Number(imp.numDeletedRows);
  return result;
}

/** Every account, for the nightly job (SECURITY DEFINER lookup; ids only). */
export async function retentionTenants(tx: Tx): Promise<string[]> {
  const r = await sql<{ id: string }>`select registration.retention_tenants() as id`.execute(tx);
  return r.rows.map((x) => x.id);
}
