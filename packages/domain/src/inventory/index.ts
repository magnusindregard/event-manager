import { newId, sql, type Tx } from "@event-manager/db";
import { emit } from "../outbox/index.js";
import { DomainError } from "../shared/index.js";

// Inventory (docs/registration.md, "Capacity and holds"): one capacity pool per occurrence
// of a registration event, kept in step with the occurrence's effective capacity by the
// resolver. Places are taken and held with a conditional update (ADR 0003): the row only
// changes if the places still fit under the bookable limit, so concurrent requests for the
// last place cannot both succeed. Registrations and waitlist offers build on this.

export interface Pool {
  id: string;
  occurrenceId: string;
  /** Null: no limit. */
  capacity: number | null;
  overbookingPct: number;
  /** floor(capacity × (1 + overbookingPct / 100)); null without a limit. */
  bookableLimit: number | null;
  held: number;
  taken: number;
  /** Places left under the bookable limit; null without a limit. Never negative. */
  available: number | null;
  /** More places are taken or held than the limit allows, e.g. after capacity was lowered. */
  overLimit: boolean;
}

const poolColumns = ["id", "occurrence_id", "capacity", "overbooking_pct", "bookable_limit", "held", "taken"] as const;
type PoolRow = { id: string; occurrence_id: string; capacity: number | null; overbooking_pct: number; bookable_limit: number | null; held: number; taken: number };

const toPool = (r: PoolRow): Pool => {
  const used = r.held + r.taken;
  return {
    id: r.id,
    occurrenceId: r.occurrence_id,
    capacity: r.capacity,
    overbookingPct: r.overbooking_pct,
    bookableLimit: r.bookable_limit,
    held: r.held,
    taken: r.taken,
    available: r.bookable_limit === null ? null : Math.max(0, r.bookable_limit - used),
    overLimit: r.bookable_limit !== null && used > r.bookable_limit,
  };
};

/** Pure: the bookable limit for a capacity and overbooking percentage. */
export const bookableLimit = (capacity: number | null, overbookingPct: number): number | null =>
  capacity === null ? null : Math.floor((capacity * (100 + overbookingPct)) / 100);

export interface PoolTarget {
  tenantId: string;
  occurrenceId: string;
  capacity: number | null;
  overbookingPct: number;
}

/**
 * Creates or updates the pools of the given occurrences to their effective capacity. A
 * change of bookable limit emits capacity.changed (cache purge now, connectors later).
 * Lowering capacity below what is taken is allowed; the pool reports overLimit.
 */
export async function syncPools(tx: Tx, targets: readonly PoolTarget[]): Promise<void> {
  if (targets.length === 0) return;
  const CHUNK = 1000;
  for (let i = 0; i < targets.length; i += CHUNK) {
    const part = targets.slice(i, i + CHUNK);
    const before = new Map(
      (await tx.selectFrom("inventory.capacity_pool").select(["occurrence_id", "bookable_limit"]).where("occurrence_id", "in", part.map((t) => t.occurrenceId)).execute())
        .map((r) => [r.occurrence_id, r.bookable_limit]),
    );
    await tx
      .insertInto("inventory.capacity_pool")
      .values(part.map((t) => ({ id: newId(), tenant_id: t.tenantId, occurrence_id: t.occurrenceId, capacity: t.capacity, overbooking_pct: t.overbookingPct })))
      .onConflict((oc) =>
        oc.column("occurrence_id").doUpdateSet((eb) => ({ capacity: eb.ref("excluded.capacity"), overbooking_pct: eb.ref("excluded.overbooking_pct") })).where((eb) =>
          eb.or([
            eb("inventory.capacity_pool.capacity", "is distinct from", eb.ref("excluded.capacity")),
            eb("inventory.capacity_pool.overbooking_pct", "<>", eb.ref("excluded.overbooking_pct")),
          ]),
        ),
      )
      .execute();
    for (const t of part) {
      const limit = bookableLimit(t.capacity, t.overbookingPct);
      if (before.has(t.occurrenceId) && before.get(t.occurrenceId) === limit) continue;
      await emit(tx, t.tenantId, {
        type: "capacity.changed.v1", subject: `occurrence/${t.occurrenceId}`,
        data: { occurrenceId: t.occurrenceId, bookableLimit: limit, previousBookableLimit: before.get(t.occurrenceId) ?? null },
      });
    }
  }
}

export async function getPool(tx: Tx, occurrenceId: string): Promise<Pool | null> {
  const row = await tx.selectFrom("inventory.capacity_pool").select(poolColumns).where("occurrence_id", "=", occurrenceId).executeTakeFirst();
  return row ? toPool(row) : null;
}

export async function listPools(tx: Tx, occurrenceIds: readonly string[]): Promise<Map<string, Pool>> {
  const out = new Map<string, Pool>();
  for (let i = 0; i < occurrenceIds.length; i += 1000) {
    const rows = await tx.selectFrom("inventory.capacity_pool").select(poolColumns).where("occurrence_id", "in", occurrenceIds.slice(i, i + 1000)).execute();
    for (const r of rows) out.set(r.occurrence_id, toPool(r));
  }
  return out;
}

const assertQuantity = (quantity: number) => {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100_000) throw new DomainError("validation_failed", "Quantity must be 1–100000", { field: "quantity" });
};

async function poolFor(tx: Tx, occurrenceId: string): Promise<{ id: string }> {
  const pool = await tx.selectFrom("inventory.capacity_pool").select("id").where("occurrence_id", "=", occurrenceId).executeTakeFirst();
  if (!pool) throw new DomainError("conflict", "This occurrence does not take registrations", { occurrenceId });
  return pool;
}

/**
 * Takes places if they fit under the bookable limit. Returns false when they don't (full),
 * so the caller can offer the waitlist. One conditional update; no lock is held.
 */
export async function takePlaces(tx: Tx, occurrenceId: string, quantity: number): Promise<boolean> {
  assertQuantity(quantity);
  const pool = await poolFor(tx, occurrenceId);
  const res = await tx
    .updateTable("inventory.capacity_pool")
    .set({ taken: sql<number>`taken + ${quantity}` })
    .where("id", "=", pool.id)
    .where((eb) => eb.or([eb("bookable_limit", "is", null), eb(sql<number>`taken + held + ${quantity}`, "<=", eb.ref("bookable_limit"))]))
    .executeTakeFirst();
  return res.numUpdatedRows > 0n;
}

/** Gives places back, e.g. when a registration is cancelled. */
export async function releasePlaces(tx: Tx, occurrenceId: string, quantity: number): Promise<void> {
  assertQuantity(quantity);
  const pool = await poolFor(tx, occurrenceId);
  await tx
    .updateTable("inventory.capacity_pool")
    .set({ taken: sql<number>`greatest(taken - ${quantity}, 0)` })
    .where("id", "=", pool.id)
    .execute();
}

/** Sets places aside until expiresAt, e.g. for a waitlist offer. Returns the hold id, or null when full. */
export async function placeHold(tx: Tx, tenantId: string, occurrenceId: string, quantity: number, expiresAt: Date): Promise<string | null> {
  assertQuantity(quantity);
  const pool = await poolFor(tx, occurrenceId);
  const res = await tx
    .updateTable("inventory.capacity_pool")
    .set({ held: sql<number>`held + ${quantity}` })
    .where("id", "=", pool.id)
    .where((eb) => eb.or([eb("bookable_limit", "is", null), eb(sql<number>`taken + held + ${quantity}`, "<=", eb.ref("bookable_limit"))]))
    .executeTakeFirst();
  if (res.numUpdatedRows === 0n) return null;
  const id = newId();
  await tx.insertInto("inventory.hold").values({ id, tenant_id: tenantId, pool_id: pool.id, quantity, expires_at: expiresAt }).execute();
  return id;
}

/**
 * Ends a hold. With convert, its places become taken (the offer was claimed), but only before
 * it expires (ADR 0003: expiry is checked on confirmation, not only by the sweeper); an expired
 * hold is released instead. Without convert, the places are released. Returns false if nothing
 * was claimed or released: the hold had expired (convert) or no longer exists (swept). The hold
 * row is deleted in the same statement that reads it, so a concurrent sweep or second claim
 * finds nothing and never releases or takes its places twice.
 */
export async function endHold(tx: Tx, holdId: string, convert: boolean, now: Date = new Date()): Promise<boolean> {
  const hold = await tx.deleteFrom("inventory.hold").where("id", "=", holdId).returning(["pool_id", "quantity", "expires_at"]).executeTakeFirst();
  if (!hold) return false;
  const claim = convert && hold.expires_at > now;
  await tx
    .updateTable("inventory.capacity_pool")
    .set(claim
      ? { held: sql<number>`greatest(held - ${hold.quantity}, 0)`, taken: sql<number>`taken + ${hold.quantity}` }
      : { held: sql<number>`greatest(held - ${hold.quantity}, 0)` })
    .where("id", "=", hold.pool_id)
    .execute();
  return convert ? claim : true;
}

/** Moves a hold's expiry, e.g. when a reservation is extended. False if the hold is gone (claimed, released or swept). */
export async function extendHold(tx: Tx, holdId: string, expiresAt: Date): Promise<boolean> {
  const res = await tx.updateTable("inventory.hold").set({ expires_at: expiresAt }).where("id", "=", holdId).executeTakeFirst();
  return res.numUpdatedRows > 0n;
}

/** Releases holds that expired before now. Returns the occurrences whose places came free. */
export async function sweepExpiredHolds(tx: Tx, now: Date = new Date()): Promise<string[]> {
  const expired = await tx.deleteFrom("inventory.hold").where("expires_at", "<=", now).returning(["pool_id", "quantity"]).execute();
  const perPool = new Map<string, number>();
  for (const h of expired) perPool.set(h.pool_id, (perPool.get(h.pool_id) ?? 0) + h.quantity);
  const occurrences: string[] = [];
  for (const [poolId, quantity] of perPool) {
    const r = await tx
      .updateTable("inventory.capacity_pool")
      .set({ held: sql<number>`greatest(held - ${quantity}, 0)` })
      .where("id", "=", poolId)
      .returning("occurrence_id")
      .executeTakeFirstOrThrow();
    occurrences.push(r.occurrence_id);
  }
  return occurrences;
}
