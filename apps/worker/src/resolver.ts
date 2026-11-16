import type { Task } from "graphile-worker";
import { type Db, sql, withTenant } from "@event-manager/db";
import { catalog } from "@event-manager/domain";
import type { InternalHandler } from "./handlers.js";

// Resolver in the worker (docs/mvp.md, "Resolution and effective values"). Rule and event
// default changes on large events are not resolved in the request; the change's outbox event
// says resolution "queued", and this queues one job per event. The job key coalesces a burst
// of edits into one run; graphile-worker starts a fresh job if one is already running, so the
// last change is always resolved.

export const RESOLVE_TASK = "rules.resolve_event";

interface ResolvePayload {
  tenantId: string;
  eventId: string;
}

const isPayload = (p: unknown): p is ResolvePayload =>
  typeof p === "object" && p !== null && typeof (p as ResolvePayload).tenantId === "string" && typeof (p as ResolvePayload).eventId === "string";

export const queueResolution: InternalHandler = {
  name: "resolver",
  types: ["rule.changed.v1", "event.changed.v1"],
  async handle(tx, event, log) {
    const data = event.data as { eventId?: unknown; resolution?: unknown };
    if (data.resolution !== "queued" || typeof data.eventId !== "string") return;
    await sql`select graphile_worker.add_job(
      ${RESOLVE_TASK},
      json_build_object('tenantId', ${event.tenantId}::text, 'eventId', ${data.eventId}::text),
      job_key := ${`resolve:${event.tenantId}:${data.eventId}`},
      run_at := now() + interval '2 seconds',
      max_attempts := 10)`.execute(tx);
    log.info("resolution queued", { eventId: data.eventId, cause: event.type });
  },
};

export function resolveTask(db: Db): Task {
  return async (payload, helpers) => {
    if (!isPayload(payload)) throw new Error(`Invalid ${RESOLVE_TASK} payload`);
    const n = await withTenant(db, { tenantId: payload.tenantId }, async (tx) => {
      const exists = await tx.selectFrom("catalog.event").select("id").where("id", "=", payload.eventId).executeTakeFirst();
      return exists ? catalog.resolveEventOccurrences(tx, payload.eventId) : 0;
    });
    helpers.logger.info(`resolved ${n} occurrences of event ${payload.eventId}`);
  };
}
