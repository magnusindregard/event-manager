import { newId, type Tx } from "@event-manager/db";
import type { ActorContext } from "../shared/index.js";

export interface AuditInput {
  action: string;
  entityType: string;
  entityId: string;
  diff?: Record<string, { from: unknown; to: unknown }> | Record<string, unknown>;
}

/** Written in the same transaction as the change it describes. */
export async function recordAudit(tx: Tx, ctx: ActorContext, input: AuditInput): Promise<void> {
  await tx
    .insertInto("tenancy.audit_log")
    .values({
      id: newId(),
      tenant_id: ctx.tenantId,
      actor_user_id: ctx.userId,
      actor_client_id: ctx.clientId,
      action: input.action,
      entity_type: input.entityType,
      entity_id: input.entityId,
      diff: JSON.stringify(input.diff ?? {}),
    })
    .execute();
}

export interface AuditEntry {
  id: string;
  at: Date;
  action: string;
  entityType: string;
  entityId: string;
  diff: unknown;
  actor: { userId: string | null; email: string | null; name: string | null; clientId: string | null };
}

export async function listAudit(
  tx: Tx,
  filter: { entityType?: string; entityId?: string; before?: string; limit: number },
): Promise<AuditEntry[]> {
  let q = tx
    .selectFrom("tenancy.audit_log as a")
    .leftJoin("tenancy.user as u", "u.id", "a.actor_user_id")
    .select(["a.id", "a.at", "a.action", "a.entity_type", "a.entity_id", "a.diff", "a.actor_user_id", "a.actor_client_id", "u.email", "u.name"])
    .orderBy("a.id", "desc")
    .limit(filter.limit);
  if (filter.entityType) q = q.where("a.entity_type", "=", filter.entityType);
  if (filter.entityId) q = q.where("a.entity_id", "=", filter.entityId);
  // IDs are UUIDv7, so id order is time order and works as a keyset cursor.
  if (filter.before) q = q.where("a.id", "<", filter.before);
  const rows = await q.execute();
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    diff: r.diff,
    actor: { userId: r.actor_user_id, email: r.email, name: r.name, clientId: r.actor_client_id },
  }));
}

export function diffFields<T extends Record<string, unknown>>(before: T, after: Partial<T>): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, v] of Object.entries(after)) {
    if (v !== undefined && JSON.stringify(before[k]) !== JSON.stringify(v)) out[k] = { from: before[k], to: v };
  }
  return out;
}
