import { type OccurrenceStatus, sql, type Tx } from "@event-manager/db";
import * as catalog from "../catalog/index.js";
import { type ActorContext, DomainError } from "../shared/index.js";
import { assertCan, recordAudit } from "../tenancy/index.js";
import { getOffer, listOffers, MAX_PRICE, type Offer } from "./offers.js";
import type * as rules from "../rules/index.js";
import { type EffectivePrice, loadEffectivePrices, loadGroupOverrides, loadGroupPrices, loadOverrides, type OfferOverride } from "./store.js";

// Prices per occurrence (docs/ticketing.md, "Prices"): the price grid (offers × occurrences,
// each cell with its effective price and availability and where they come from) and overrides
// for one offer at one occurrence.

export interface PriceCell extends EffectivePrice {
  offerId: string;
  /** Set on this occurrence; null fields inherit from rules and the offer default. */
  override: OfferOverride | null;
  /** With a group asked for (docs/user-groups.md): what that group pays here. */
  group?: GroupCell;
}

export interface GroupCell {
  groupId: string;
  /** The group's price with its source; when inherited, the general price. */
  price: rules.Resolved<number>;
  /** No group setting applies here, so the group pays the general price. */
  inherited: boolean;
  /** The group override at this occurrence, if any. */
  override: number | null;
}

export interface PriceRow {
  occurrenceId: string;
  startUtc: Date;
  endUtc: Date;
  status: OccurrenceStatus;
  /** Offers whose prices are resolved; a new offer on a large event may be missing for a few seconds. */
  cells: PriceCell[];
}

export interface PriceGridFilter {
  from?: Date;
  to?: Date;
  after?: { startUtc: Date; id: string };
  limit: number;
  /** Also show what this user group pays in each cell. */
  groupId?: string;
}

export async function priceGrid(tx: Tx, eventId: string, f: PriceGridFilter): Promise<{ offers: Offer[]; rows: PriceRow[] }> {
  const event = await tx.selectFrom("catalog.event").select("id").where("id", "=", eventId).executeTakeFirst();
  if (!event) throw new DomainError("not_found", "Event not found");
  let q = tx
    .selectFrom("catalog.occurrence")
    .select(["id", "start_utc", "end_utc", "status"])
    .where("event_id", "=", eventId)
    .orderBy("start_utc")
    .orderBy("id")
    .limit(f.limit);
  if (f.from) q = q.where("end_utc", ">", f.from);
  if (f.to) q = q.where("start_utc", "<", f.to);
  if (f.after) {
    const { startUtc, id } = f.after;
    q = q.where((eb) => eb.or([eb("start_utc", ">", startUtc), eb.and([eb("start_utc", "=", startUtc), eb("id", ">", id)])]));
  }
  const occs = await q.execute();
  const ids = occs.map((o) => o.id);
  const [offers, prices, overrides] = await Promise.all([listOffers(tx, eventId), loadEffectivePrices(tx, ids), loadOverrides(tx, ids)]);
  // UUIDs as Postgres returns them (lowercase), so map lookups below match whatever casing the caller sent.
  const groupId = f.groupId?.toLowerCase();
  if (groupId) {
    const known = await tx.selectFrom("catalog.user_group").select("id").where("id", "=", groupId).executeTakeFirst();
    if (!known) throw new DomainError("validation_failed", "Unknown user group", { field: "groupId" });
  }
  const groupPrices = groupId ? await loadGroupPrices(tx, ids) : undefined;
  const groupOverrides = groupId ? await loadGroupOverrides(tx, ids) : undefined;
  const groupCell = (occurrenceId: string, offerId: string, general: EffectivePrice): GroupCell | undefined => {
    if (!groupId) return undefined;
    const own = groupPrices?.get(occurrenceId)?.get(offerId)?.get(groupId);
    const override = groupOverrides?.get(occurrenceId)?.[`${offerId}|${groupId}`] ?? null;
    return { groupId, price: own ?? general.price, inherited: !own, override };
  };
  return {
    offers,
    rows: occs.map((o) => ({
      occurrenceId: o.id,
      startUtc: o.start_utc,
      endUtc: o.end_utc,
      status: o.status,
      cells: offers.flatMap((offer) => {
        const p = prices.get(o.id)?.get(offer.id);
        if (!p) return [];
        const g = groupCell(o.id, offer.id, p);
        return [{ offerId: offer.id, ...p, override: overrides.get(o.id)?.get(offer.id) ?? null, ...(g ? { group: g } : {}) }];
      }),
    })),
  };
}

export interface OverrideInput {
  /** Minor units, VAT included. null inherits; left out keeps the stored value. */
  amount?: number | null;
  /** false takes the offer off sale here. null inherits; left out keeps the stored value. */
  available?: boolean | null;
}

/**
 * Sets or clears an override for one offer at one occurrence, then resolves that occurrence.
 * Lock order as for schedule changes: event (share), then the occurrence.
 */
export async function setOverride(tx: Tx, ctx: ActorContext, rawOfferId: string, rawOccurrenceId: string, input: OverrideInput): Promise<PriceCell> {
  // Lowercase, as Postgres returns UUIDs: the before/after comparison below reads stored rows by these keys.
  const offerId = rawOfferId.toLowerCase();
  const occurrenceId = rawOccurrenceId.toLowerCase();
  assertCan(ctx, "offers.write");
  const offer = await getOffer(tx, offerId);
  // Share lock on the event, as schedule changes take it: offer and rule changes (for update) wait.
  const event = await tx.selectFrom("catalog.event").select("status").where("id", "=", offer.eventId).forShare().executeTakeFirstOrThrow();
  if (event.status === "archived") throw new DomainError("conflict", "The event is archived");
  const occ = await tx.selectFrom("catalog.occurrence").select(["id", "event_id", "series_id"]).where("id", "=", occurrenceId).forUpdate().executeTakeFirst();
  if (!occ || occ.event_id !== offer.eventId) throw new DomainError("not_found", "Occurrence not found for this offer's event");
  if (input.amount != null && (!Number.isInteger(input.amount) || input.amount < 0 || input.amount > MAX_PRICE)) {
    throw new DomainError("validation_failed", `Must be a whole amount in minor units, 0–${MAX_PRICE}`, { field: "amount" });
  }

  const before = (await loadOverrides(tx, [occurrenceId])).get(occurrenceId)?.get(offerId) ?? { amount: null, available: null };
  const after: OfferOverride = {
    amount: input.amount === undefined ? before.amount : input.amount,
    available: input.available === undefined ? before.available : input.available,
  };
  if (after.amount === null && after.available === null) {
    await tx.deleteFrom("offers.offer_override").where("offer_id", "=", offerId).where("occurrence_id", "=", occurrenceId).execute();
  } else {
    await tx
      .insertInto("offers.offer_override")
      .values({ tenant_id: ctx.tenantId, offer_id: offerId, occurrence_id: occurrenceId, ...after })
      .onConflict((oc) => oc.columns(["offer_id", "occurrence_id"]).doUpdateSet(after))
      .execute();
  }
  if (before.amount !== after.amount || before.available !== after.available) {
    // A hand-priced series occurrence is a hand edit like any other override: detach it, so
    // regeneration keeps it (and reports a conflict) instead of moving or deleting it.
    // The version moves so stale copies of the occurrence fail their If-Match.
    if (occ.series_id !== null) {
      await tx.updateTable("catalog.occurrence").set({ detached: true, conflict: false, version: sql<number>`version + 1` }).where("id", "=", occurrenceId).execute();
    }
    await catalog.resolveEventOccurrences(tx, offer.eventId, [occurrenceId]);
    await recordAudit(tx, ctx, {
      action: "offer.override_set", entityType: "occurrence", entityId: occurrenceId,
      diff: { offerId, code: offer.code, amount: { from: before.amount, to: after.amount }, available: { from: before.available, to: after.available } },
    });
  }
  const price = (await loadEffectivePrices(tx, [occurrenceId])).get(occurrenceId)?.get(offerId);
  if (!price) throw new DomainError("conflict", "The occurrence's prices are not resolved yet; try again in a moment");
  return { offerId, ...price, override: after.amount === null && after.available === null ? null : after };
}

/**
 * Sets or clears one user group's price for one offer at one occurrence (docs/user-groups.md),
 * then resolves that occurrence. Lock order as for setOverride.
 */
export async function setGroupOverride(
  tx: Tx, ctx: ActorContext, rawOfferId: string, rawOccurrenceId: string, rawGroupId: string, amount: number | null,
): Promise<GroupCell> {
  // Lowercase, as Postgres returns UUIDs: otherwise an uppercase id misses the stored override,
  // the change looks like a no-op and the occurrence is not resolved again (review on #84).
  const offerId = rawOfferId.toLowerCase();
  const occurrenceId = rawOccurrenceId.toLowerCase();
  const groupId = rawGroupId.toLowerCase();
  assertCan(ctx, "offers.write");
  const offer = await getOffer(tx, offerId);
  const event = await tx.selectFrom("catalog.event").select("status").where("id", "=", offer.eventId).forShare().executeTakeFirstOrThrow();
  if (event.status === "archived") throw new DomainError("conflict", "The event is archived");
  const occ = await tx.selectFrom("catalog.occurrence").select(["id", "event_id", "series_id"]).where("id", "=", occurrenceId).forUpdate().executeTakeFirst();
  if (!occ || occ.event_id !== offer.eventId) throw new DomainError("not_found", "Occurrence not found for this offer's event");
  if (amount !== null && (!Number.isInteger(amount) || amount < 0 || amount > MAX_PRICE)) {
    throw new DomainError("validation_failed", `Must be a whole amount in minor units, 0–${MAX_PRICE}`, { field: "amount" });
  }
  const before = (await loadGroupOverrides(tx, [occurrenceId])).get(occurrenceId)?.[`${offerId}|${groupId}`] ?? null;
  // A new override needs an active group; clearing one works for an archived group too.
  if (amount !== null && before === null) await catalog.assertUsableGroups(tx, [groupId], [], "groupId");
  if (amount === null) {
    await tx.deleteFrom("offers.offer_group_override").where("offer_id", "=", offerId).where("occurrence_id", "=", occurrenceId).where("group_id", "=", groupId).execute();
  } else {
    await tx
      .insertInto("offers.offer_group_override")
      .values({ tenant_id: ctx.tenantId, offer_id: offerId, occurrence_id: occurrenceId, group_id: groupId, amount })
      .onConflict((oc) => oc.columns(["offer_id", "occurrence_id", "group_id"]).doUpdateSet({ amount }))
      .execute();
  }
  if (before !== amount) {
    if (occ.series_id !== null) {
      await tx.updateTable("catalog.occurrence").set({ detached: true, conflict: false, version: sql<number>`version + 1` }).where("id", "=", occurrenceId).execute();
    }
    await catalog.resolveEventOccurrences(tx, offer.eventId, [occurrenceId]);
    await recordAudit(tx, ctx, {
      action: "offer.group_override_set", entityType: "occurrence", entityId: occurrenceId,
      diff: { offerId, code: offer.code, groupId, amount: { from: before, to: amount } },
    });
  }
  const general = (await loadEffectivePrices(tx, [occurrenceId])).get(occurrenceId)?.get(offerId);
  if (!general) throw new DomainError("conflict", "The occurrence's prices are not resolved yet; try again in a moment");
  const own = (await loadGroupPrices(tx, [occurrenceId])).get(occurrenceId)?.get(offerId)?.get(groupId);
  return { groupId, price: own ?? general.price, inherited: !own, override: amount };
}
