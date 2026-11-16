import type { Task } from "graphile-worker";
import { type Db, withoutTenant, withTenant } from "@event-manager/db";
import { catalog } from "@event-manager/domain";

// Crontab task names may not contain dots, so this one uses a colon.
export const HORIZON_TASK = "series:extend_horizons";
/** Nightly at 02:00 UTC (graphile-worker crontab). Staging runs the same job as a Container Apps cron job. */
export const HORIZON_CRONTAB = `0 2 * * * ${HORIZON_TASK}`;

export interface HorizonResult {
  series: number;
  created: number;
  failed: number;
}

/**
 * Extends every open-ended series to its account's horizon (docs/mvp.md: "An open-ended
 * weekly series always has occurrences 18 months ahead"). Each series runs in its own
 * tenant transaction, so one failure does not hold back the others.
 */
export async function extendHorizons(db: Db, now: Date, log: (msg: string) => void): Promise<HorizonResult> {
  const due = await withoutTenant(db, (tx) => catalog.seriesDueForExtension(tx, now));
  const result: HorizonResult = { series: due.length, created: 0, failed: 0 };
  for (const { tenantId, seriesId } of due) {
    try {
      result.created += await withTenant(db, { tenantId }, (tx) => catalog.extendSeriesHorizon(tx, tenantId, seriesId, now));
    } catch (e) {
      result.failed++;
      log(`horizon: series ${seriesId} (tenant ${tenantId}) failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  log(`horizon: ${result.series} series due, ${result.created} occurrences created, ${result.failed} failed`);
  return result;
}

export function horizonTask(db: Db): Task {
  return async (_payload, helpers) => {
    const r = await extendHorizons(db, new Date(), (m) => helpers.logger.info(m));
    if (r.failed) throw new Error(`${r.failed} series could not be extended`);
  };
}
