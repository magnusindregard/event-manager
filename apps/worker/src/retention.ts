import type { Task } from "graphile-worker";
import { type Db, withoutTenant, withTenant } from "@event-manager/db";
import { payments, registration, sales } from "@event-manager/domain";

// Crontab task names may not contain dots, so this one uses a colon.
export const RETENTION_TASK = "registration:retention";
/** Nightly at 03:00 UTC, after the horizon job. */
export const RETENTION_CRONTAB = `0 3 * * * ${RETENTION_TASK}`;

export interface RetentionRun extends registration.RetentionResult {
  /** Reservations whose buyer was removed (docs/ticketing.md, "Reservation"). */
  reservationsAnonymised: number;
  /** Hosted payments whose copy of the buyer was removed (docs/checkout.md, "Data"). */
  paymentsAnonymised: number;
  tenants: number;
  failed: number;
}

/**
 * Deletes sensitive answers and anonymises registrations and ticket buyers past the account's
 * retention periods (docs/registration.md, "Retention"; docs/ticketing.md, "Reservation"). Each tenant runs in its own transaction, so
 * one failure does not hold back the others; every step is idempotent and simply repeats
 * the next night.
 */
export async function runRetention(db: Db, now: Date, log: (msg: string) => void): Promise<RetentionRun> {
  const tenants = await withoutTenant(db, (tx) => registration.retentionTenants(tx));
  const total: RetentionRun = { tenants: tenants.length, failed: 0, sensitiveDeleted: 0, anonymised: 0, invitationsDeleted: 0, importsDeleted: 0, reservationsAnonymised: 0, paymentsAnonymised: 0 };
  for (const tenantId of tenants) {
    try {
      const r = await withTenant(db, { tenantId }, async (tx) => ({ ...(await registration.applyRetention(tx, now)), ...(await sales.applySalesRetention(tx, now)), ...(await payments.applyPaymentRetention(tx)) }));
      total.sensitiveDeleted += r.sensitiveDeleted;
      total.anonymised += r.anonymised;
      total.invitationsDeleted += r.invitationsDeleted;
      total.importsDeleted += r.importsDeleted;
      total.reservationsAnonymised += r.reservationsAnonymised;
      total.paymentsAnonymised += r.paymentsAnonymised;
    } catch (e) {
      total.failed++;
      log(`retention: tenant ${tenantId} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  log(`retention: ${total.tenants} accounts, ${total.sensitiveDeleted} sensitive answers deleted, ${total.anonymised} registrations and ${total.reservationsAnonymised} buyers (${total.paymentsAnonymised} on payments) anonymised, ${total.invitationsDeleted} invitations and ${total.importsDeleted} uploads deleted, ${total.failed} failed`);
  return total;
}

export function retentionTask(db: Db): Task {
  return async (_payload, helpers) => {
    const r = await runRetention(db, new Date(), (m) => helpers.logger.info(m));
    if (r.failed) throw new Error(`Retention failed for ${r.failed} accounts`);
  };
}
