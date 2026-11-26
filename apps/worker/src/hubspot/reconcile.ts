import type { Task } from "graphile-worker";
import { type Db, sql, type Tx, withoutTenant, withTenant } from "@event-manager/db";
import { integrations } from "@event-manager/domain";
import { HubSpotError } from "@event-manager/hubspot";
import { withHubSpot } from "./session.js";
import type { HubSpotDeps } from "./setup.js";
import { queueSync } from "./sync.js";

// The nightly segment reconcile (docs/hubspot.md, "Kept in step under the hood"). The outbox
// keeps segments in step as things happen; this catches what that cannot see: an update that
// failed, a guest removed from the list (which emits nothing), a sync setting changed, and hand
// edits or deletions in HubSpot. It first works out membership again from the platform, then
// reads each segment and fixes the difference. The sync log shows what it fixed.

// Crontab task names may not contain dots, so this one uses a colon.
export const HUBSPOT_RECONCILE_TASK = "hubspot:reconcile";
/** Nightly at 04:00 UTC, after retention (03:00), so anonymised guests leave the segments the same night. */
export const HUBSPOT_RECONCILE_CRONTAB = `0 4 * * * ${HUBSPOT_RECONCILE_TASK}`;

const BATCH = 250;

/** Reconciles one account's segments; null when it has no usable connection. */
export async function reconcileSegments(db: Db, tenantId: string, deps: HubSpotDeps, now = () => new Date()): Promise<integrations.ReconcileResult | null> {
  const t = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(db, { tenantId }, fn);
  const run = await withHubSpot(db, tenantId, deps.client, async (accessToken, connection) => {
    const ref = { id: connection.id, generation: connection.generation };
    const result: integrations.ReconcileResult = { at: now().toISOString(), segments: 0, added: 0, removed: 0, recreated: 0, failed: 0 };

    // The platform's side first: who should be where, as of now.
    await t(async (tx) => {
      const target = await integrations.syncTarget(tx, "hubspot");
      if (!target || target.generation !== ref.generation) return;
      for (const eventId of await integrations.segmentEvents(tx, ref.id)) await integrations.markSegments(tx, tenantId, target, eventId);
    });

    const segments = await t((tx) => integrations.liveSegments(tx, ref.id));
    for (const [segment, listId] of segments) {
      result.segments++;
      // The database's clock, so it compares with updated_at as written.
      const before = await t(async (tx) => (await sql<{ now: string }>`select now()::text as now`.execute(tx)).rows[0]!.now);
      const expected = await t((tx) => integrations.expectedMembers(tx, ref.id, segment));
      try {
        const actual = new Set(await deps.client.listMembers(accessToken, listId));
        const add = [...expected].filter((id) => !actual.has(id));
        const remove = [...actual].filter((id) => !expected.has(id));
        for (let i = 0; i < add.length; i += BATCH) {
          const r = await deps.client.addToList(accessToken, listId, add.slice(i, i + BATCH));
          result.added += Math.min(BATCH, add.length - i) - r.missing.length;
        }
        for (let i = 0; i < remove.length; i += BATCH) await deps.client.removeFromList(accessToken, listId, remove.slice(i, i + BATCH));
        result.removed += remove.length;
        await t((tx) => integrations.recordSegmentReconciled(tx, ref, segment, before));
      } catch (e) {
        if (!(e instanceof HubSpotError) || e.retryable || e.unauthorized) throw e;
        if (e.status === 404) {
          await t((tx) => integrations.recordSegmentGone(tx, ref, segment));
          result.recreated++;
        } else {
          result.failed++;
        }
      }
    }

    await t(async (tx) => {
      await integrations.recordReconcile(tx, ref, result);
      if (await integrations.hasDirty(tx, ref.id)) await queueSync(tx, tenantId, 0);
    });
    return result;
  });
  return run?.value ?? null;
}

export function hubspotReconcileTask(db: Db, deps: HubSpotDeps | null): Task {
  return async (_payload, helpers) => {
    if (!deps) return;
    const tenants = await withoutTenant(db, (tx) => integrations.connectedTenants(tx, "hubspot"));
    let failed = 0;
    for (const tenantId of tenants) {
      try {
        const r = await reconcileSegments(db, tenantId, deps);
        if (r && (r.added || r.removed || r.recreated || r.failed)) {
          helpers.logger.info(`hubspot reconcile ${tenantId}: ${r.segments} segments, ${r.added} added, ${r.removed} removed, ${r.recreated} to make again, ${r.failed} refused`);
        }
      } catch (e) {
        failed++;
        helpers.logger.error(`hubspot reconcile ${tenantId} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (failed) throw new Error(`HubSpot reconcile failed for ${failed} accounts`);
  };
}
