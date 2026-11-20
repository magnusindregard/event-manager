import type { Task } from "graphile-worker";
import { type Db, withoutTenant, withTenant } from "@event-manager/db";
import { sales } from "@event-manager/domain";

// The reservation sweeper (docs/ticketing.md, "Reservation"): every minute, held reservations
// past their expiry release their places and become expired (reservation.expired). Confirm
// checks expiry itself and reads an overdue reservation as expired, so the sweeper only decides
// how soon the places go back on sale. Each reservation is expired in its own transaction, so
// the sweeper never holds more than one reservation's pool locks at a time.

// Crontab task names may not contain dots, so this one uses a colon.
export const RESERVATION_SWEEP_TASK = "sales:sweep_reservations";
export const RESERVATION_SWEEP_CRONTAB = `* * * * * ${RESERVATION_SWEEP_TASK}`;

const BATCH = 500;

export interface SweepResult {
  tenants: number;
  expired: number;
  failed: number;
}

export async function sweepReservations(db: Db, now: Date, log: (msg: string) => void): Promise<SweepResult> {
  const tenants = await withoutTenant(db, (tx) => sales.overdueReservationTenants(tx, now));
  const result: SweepResult = { tenants: tenants.length, expired: 0, failed: 0 };
  for (const tenantId of tenants) {
    try {
      // Batches of BATCH ids until the tenant has none left due; each expiry is its own transaction.
      for (;;) {
        const ids = await withTenant(db, { tenantId }, (tx) => sales.overdueReservations(tx, now, BATCH));
        for (const id of ids) {
          await withTenant(db, { tenantId }, (tx) => sales.expireReservation(tx, tenantId, id, now));
          result.expired++;
        }
        if (ids.length < BATCH) break;
      }
    } catch (e) {
      result.failed++;
      log(`reservations: tenant ${tenantId} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (result.tenants) log(`reservations: ${result.expired} expired in ${result.tenants} accounts, ${result.failed} failed`);
  return result;
}

export function reservationSweepTask(db: Db, clock: () => Date = () => new Date()): Task {
  return async (_payload, helpers) => {
    const r = await sweepReservations(db, clock(), (m) => helpers.logger.info(m));
    if (r.failed) throw new Error(`Reservation sweep failed for ${r.failed} accounts`);
  };
}
