import { type OccurrenceStatus, sql, type Tx } from "@event-manager/db";
import * as catalog from "../catalog/index.js";
import { type ActorContext, DomainError } from "../shared/index.js";
import { assertCan, recordAudit } from "../tenancy/index.js";
import { getOffer, listOffers, MAX_PRICE, type Offer } from "./offers.js";
import { type EffectivePrice, loadEffectivePrices, loadOverrides, type OfferOverride } from "./store.js";

// Prices per occurrence (docs/ticketing.md, "Prices"): the price grid (offers × occurrences,
// each cell with its effective price and availability and where they come from) and overrides
// for one offer at one occurrence.

export interface PriceCell extends EffectivePrice {
  offerId: string;
  /** Set on this occurrence; null fields inherit from rules and the offer default. */
  override: OfferOverride | null;
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
  return {
    offers,
    rows: occs.map((o) => ({
      occurrenceId: o.id,
      startUtc: o.start_utc,
      endUtc: o.end_utc,
      status: o.status,
      cells: offers.flatMap((offer) => {
        const p = prices.get(o.id)?.get(offer.id);
        return p ? [{ offerId: offer.id, ...p, override: overrides.get(o.id)?.get(offer.id) ?? null }] : [];
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
export async function setOverride(tx: Tx, ctx: ActorContext, offerId: string, occurrenceId: string, input: OverrideInput): Promise<PriceCell> {
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
