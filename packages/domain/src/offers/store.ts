import type { Tx, ValueSource } from "@event-manager/db";
import type * as rules from "../rules/index.js";

// Storage the resolver and read models share (docs/ticketing.md, "Prices"): an event's offers
// as resolution targets, overrides per (offer, occurrence), and the materialized effective
// prices. No catalog imports here, so the catalog's resolver can use it without a cycle.

/** An offer as the resolver sees it. */
export interface PriceTarget {
  id: string;
  defaultPrice: number;
}

export const targetDefaults = (t: PriceTarget): rules.TargetValues => ({ price: t.defaultPrice, offerAvailable: true });

/** Every offer of the event, archived ones too, so their effective prices stay current. */
export async function priceTargets(tx: Tx, eventId: string): Promise<PriceTarget[]> {
  const rows = await tx.selectFrom("offers.offer").select(["id", "default_price"]).where("event_id", "=", eventId).orderBy("id").execute();
  return rows.map((r) => ({ id: r.id, defaultPrice: r.default_price }));
}

export interface OfferOverride {
  amount: number | null;
  available: boolean | null;
}

const CHUNK = 1000;

/** Overrides per occurrence, then per offer. */
export async function loadOverrides(tx: Tx, occurrenceIds: readonly string[]): Promise<Map<string, Map<string, OfferOverride>>> {
  const out = new Map<string, Map<string, OfferOverride>>();
  for (let i = 0; i < occurrenceIds.length; i += CHUNK) {
    const rows = await tx
      .selectFrom("offers.offer_override")
      .select(["occurrence_id", "offer_id", "amount", "available"])
      .where("occurrence_id", "in", occurrenceIds.slice(i, i + CHUNK))
      .execute();
    for (const r of rows) {
      const m = out.get(r.occurrence_id) ?? new Map<string, OfferOverride>();
      m.set(r.offer_id, { amount: r.amount, available: r.available });
      out.set(r.occurrence_id, m);
    }
  }
  return out;
}

/** An occurrence's overrides as the rule engine takes them, per offer. */
export function targetOverrides(overrides: Map<string, OfferOverride> | undefined): Record<string, Partial<rules.TargetValues>> {
  const out: Record<string, Partial<rules.TargetValues>> = {};
  for (const [offerId, o] of overrides ?? []) {
    const v: Partial<rules.TargetValues> = {};
    if (o.amount !== null) v.price = o.amount;
    if (o.available !== null) v.offerAvailable = o.available;
    out[offerId] = v;
  }
  return out;
}

/** Whether the occurrence has any offer override. */
export async function hasOverrides(tx: Tx, occurrenceId: string): Promise<boolean> {
  const row = await tx.selectFrom("offers.offer_override").select("offer_id").where("occurrence_id", "=", occurrenceId).limit(1).executeTakeFirst();
  return row !== undefined;
}

/** Removes every offer override of an occurrence, e.g. when it is reattached to its series. */
export async function clearOverrides(tx: Tx, occurrenceId: string): Promise<void> {
  await tx.deleteFrom("offers.offer_override").where("occurrence_id", "=", occurrenceId).execute();
}

export interface EffectivePrice {
  price: rules.Resolved<number>;
  available: rules.Resolved<boolean>;
}

export interface EffectivePriceRow {
  tenantId: string;
  occurrenceId: string;
  offerId: string;
  values: rules.ResolvedTarget;
}

/** Upserts effective prices. */
export async function writeEffectivePrices(tx: Tx, rows: readonly EffectivePriceRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    await tx
      .insertInto("offers.effective_price")
      .values(rows.slice(i, i + CHUNK).map((r) => ({
        tenant_id: r.tenantId,
        occurrence_id: r.occurrenceId,
        offer_id: r.offerId,
        amount: r.values.price.value as number,
        amount_source: r.values.price.source,
        amount_rule_id: r.values.price.ruleId,
        available: r.values.offerAvailable.value as boolean,
        available_source: r.values.offerAvailable.source,
        available_rule_id: r.values.offerAvailable.ruleId,
      })))
      .onConflict((oc) =>
        oc.columns(["occurrence_id", "offer_id"]).doUpdateSet((eb) => ({
          amount: eb.ref("excluded.amount"),
          amount_source: eb.ref("excluded.amount_source"),
          amount_rule_id: eb.ref("excluded.amount_rule_id"),
          available: eb.ref("excluded.available"),
          available_source: eb.ref("excluded.available_source"),
          available_rule_id: eb.ref("excluded.available_rule_id"),
        })),
      )
      .execute();
  }
}

/** Effective prices per occurrence, then per offer. */
export async function loadEffectivePrices(tx: Tx, occurrenceIds: readonly string[]): Promise<Map<string, Map<string, EffectivePrice>>> {
  const out = new Map<string, Map<string, EffectivePrice>>();
  for (let i = 0; i < occurrenceIds.length; i += CHUNK) {
    const rows = await tx
      .selectFrom("offers.effective_price")
      .select(["occurrence_id", "offer_id", "amount", "amount_source", "amount_rule_id", "available", "available_source", "available_rule_id"])
      .where("occurrence_id", "in", occurrenceIds.slice(i, i + CHUNK))
      .execute();
    for (const r of rows) {
      const m = out.get(r.occurrence_id) ?? new Map<string, EffectivePrice>();
      m.set(r.offer_id, {
        price: { value: r.amount, source: r.amount_source as ValueSource, ruleId: r.amount_rule_id },
        available: { value: r.available, source: r.available_source as ValueSource, ruleId: r.available_rule_id },
      });
      out.set(r.occurrence_id, m);
    }
  }
  return out;
}
