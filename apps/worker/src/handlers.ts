import type { Tx } from "@event-manager/db";
import type { outbox } from "@event-manager/domain";
import { queueOccurrenceNotices } from "./occurrence-notice.js";
import { enqueueProvisioning } from "./provision.js";
import { queueRegistrationEmail } from "./registration-email.js";
import { queueResolution } from "./resolver.js";

/**
 * Internal consumers of domain events (ADR 0008). Each runs in the event's tenant
 * transaction and must be idempotent; claimHandling guarantees at-most-once per
 * handler even though dispatch is at-least-once.
 *
 * The resolver queues effective-value resolution for large events (milestone 4). Cache
 * purge and webhook delivery subscribe here later without touching core modules.
 */
export interface InternalHandler {
  name: string;
  /** Event types this handler wants, or "*" for all. */
  types: readonly string[] | "*";
  handle(tx: Tx, event: outbox.DomainEvent, log: Logger): Promise<void>;
}

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
}

export const auditTrailHandler: InternalHandler = {
  name: "log",
  types: "*",
  async handle(_tx, event, log) {
    log.info("domain event", { id: event.id, type: event.type, subject: event.subject, tenantId: event.tenantId });
  },
};

export const defaultHandlers: InternalHandler[] = [auditTrailHandler, enqueueProvisioning, queueResolution, queueRegistrationEmail, queueOccurrenceNotices];
