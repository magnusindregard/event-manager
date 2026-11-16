import { newId, type Tx } from "@event-manager/db";

export interface DomainEventInput {
  /** Versioned CloudEvents type, e.g. "occurrence.changed.v1". */
  type: string;
  /** Entity the event is about, e.g. "account/<id>". */
  subject: string;
  data: Record<string, unknown>;
}

export interface DomainEvent extends DomainEventInput {
  id: string;
  tenantId: string;
  source: string;
  createdAt: Date;
}

const SOURCE = "event-manager/core";

/**
 * Writes a domain event in the caller's transaction (ADR 0008). The insert trigger
 * enqueues the dispatch job, so commit and event are atomic.
 */
export async function emit(tx: Tx, tenantId: string, event: DomainEventInput): Promise<string> {
  const id = newId();
  await tx
    .insertInto("outbox.event")
    .values({ id, tenant_id: tenantId, type: event.type, source: SOURCE, subject: event.subject, data: JSON.stringify(event.data) })
    .execute();
  return id;
}

export async function loadEvent(tx: Tx, id: string): Promise<DomainEvent | undefined> {
  const row = await tx.selectFrom("outbox.event").selectAll().where("id", "=", id).executeTakeFirst();
  if (!row) return undefined;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    type: row.type,
    source: row.source,
    subject: row.subject,
    data: row.data as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

/** Idempotency for at-least-once delivery: returns false if this handler already processed the event. */
export async function claimHandling(tx: Tx, handler: string, event: DomainEvent): Promise<boolean> {
  const res = await tx
    .insertInto("outbox.handled")
    .values({ handler, event_id: event.id, tenant_id: event.tenantId })
    .onConflict((oc) => oc.doNothing())
    .executeTakeFirst();
  return (res.numInsertedOrUpdatedRows ?? 0n) > 0n;
}

export async function markDispatched(tx: Tx, id: string): Promise<void> {
  await tx.updateTable("outbox.event").set({ dispatched_at: new Date() }).where("id", "=", id).execute();
}
