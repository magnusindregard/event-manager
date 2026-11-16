import type { Task, TaskList } from "graphile-worker";
import { type Db, withTenant } from "@event-manager/db";
import { outbox } from "@event-manager/domain";
import type { InternalHandler } from "./handlers.js";
import { HORIZON_TASK, horizonTask } from "./horizon.js";
import { PROVISION_TASK, type ProvisionDeps, provisionTask } from "./provision.js";

interface DispatchPayload {
  eventId: string;
  tenantId: string;
}

function isDispatchPayload(p: unknown): p is DispatchPayload {
  return typeof p === "object" && p !== null && typeof (p as DispatchPayload).eventId === "string" && typeof (p as DispatchPayload).tenantId === "string";
}

/** outbox.dispatch: enqueued by the outbox insert trigger, runs under the event's tenant. */
export function dispatchTask(db: Db, handlers: InternalHandler[]): Task {
  return async (payload, helpers) => {
    if (!isDispatchPayload(payload)) throw new Error("Invalid outbox.dispatch payload");
    await withTenant(db, { tenantId: payload.tenantId }, async (tx) => {
      const event = await outbox.loadEvent(tx, payload.eventId);
      if (!event) {
        helpers.logger.warn(`outbox event ${payload.eventId} not found`);
        return;
      }
      for (const h of handlers) {
        if (h.types !== "*" && !h.types.includes(event.type)) continue;
        if (!(await outbox.claimHandling(tx, h.name, event))) continue;
        await h.handle(tx, event, { info: (m, meta) => helpers.logger.info(`${m} ${meta ? JSON.stringify(meta) : ""}`) });
      }
      await outbox.markDispatched(tx, event.id);
    });
  };
}

export function buildTaskList(db: Db, handlers: InternalHandler[], provision?: ProvisionDeps): TaskList {
  return {
    "outbox.dispatch": dispatchTask(db, handlers),
    [HORIZON_TASK]: horizonTask(db),
    ...(provision ? { [PROVISION_TASK]: provisionTask(db, provision) } : {}),
  };
}
