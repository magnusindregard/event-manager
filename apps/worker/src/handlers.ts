import type { Tx } from "@event-manager/db";
import type { outbox } from "@event-manager/domain";

/**
 * Internal consumers of domain events (ADR 0008). Each runs in the event's tenant
 * transaction and must be idempotent; claimHandling guarantees at-most-once per
 * handler even though dispatch is at-least-once.
 *
 * Milestone 2+ adds: resolver (effective values), cache purge. Webhook delivery
 * subscribes here later without touching core modules.
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

export const defaultHandlers: InternalHandler[] = [auditTrailHandler];
