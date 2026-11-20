import type { Tx, ValueSource } from "@event-manager/db";
import type * as rules from "../rules/index.js";

// Storage the resolver and read models share (docs/ticketing.md, "Prices"): an event's offers
// as resolution targets, overrides per (offer, occurrence), and the materialized effective
// prices. No catalog imports here, so the catalog's resolver can use it without a cycle.

/** An offer as the resolver sees it. */
export interface PriceTarget {
  id: string;
  defaultPrice: number;
  /** The offer's own prices per user group (docs/user-groups.md). */
  groupPrices: { groupId: string; amount: number }[];
}

export const targetDefaults = (t: PriceTarget): rules.TargetValues => ({ price: t.defaultPrice, offerAvailable: true });

/** Every offer of the event, archived ones too, so their effective prices stay current. */
export async function priceTargets(tx: Tx, eventId: string): Promise<PriceTarget[]> {
  const [rows, groups] = await Promise.all([
    tx.selectFrom("offers.offer").select(["id", "default_price"]).where("event_id", "=", eventId).orderBy("id").execute(),
    tx.selectFrom("offers.offer_group_price as gp").innerJoin("offers.offer as o", "o.id", "gp.offer_id")
      .select(["gp.offer_id", "gp.group_id", "gp.amount"]).where("o.event_id", "=", eventId).orderBy("gp.group_id").execute(),
  ]);
  return rows.map((r) => ({
    id: r.id, defaultPrice: r.default_price,
    groupPrices: groups.filter((g) => g.offer_id === r.id).map((g) => ({ groupId: g.group_id, amount: g.amount })),
  }));
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

/** Whether the occurrence has any offer override, for everyone or for a group. */
export async function hasOverrides(tx: Tx, occurrenceId: string): Promise<boolean> {
  const row = await tx.selectFrom("offers.offer_override").select("offer_id").where("occurrence_id", "=", occurrenceId).limit(1).executeTakeFirst();
  if (row) return true;
  const group = await tx.selectFrom("offers.offer_group_override").select("offer_id").where("occurrence_id", "=", occurrenceId).limit(1).executeTakeFirst();
  return group !== undefined;
}

/** Removes every offer override of an occurrence, group overrides too, e.g. when it is reattached to its series. */
export async function clearOverrides(tx: Tx, occurrenceId: string): Promise<void> {
  await tx.deleteFrom("offers.offer_override").where("occurrence_id", "=", occurrenceId).execute();
  await tx.deleteFrom("offers.offer_group_override").where("occurrence_id", "=", occurrenceId).execute();
}

/** Group overrides per occurrence, keyed by rules.groupKey(offer, group). */
export async function loadGroupOverrides(tx: Tx, occurrenceIds: readonly string[]): Promise<Map<string, Record<string, number>>> {
  const out = new Map<string, Record<string, number>>();
  for (let i = 0; i < occurrenceIds.length; i += CHUNK) {
    const rows = await tx
      .selectFrom("offers.offer_group_override")
      .select(["occurrence_id", "offer_id", "group_id", "amount"])
      .where("occurrence_id", "in", occurrenceIds.slice(i, i + CHUNK))
      .execute();
    for (const r of rows) {
      const m = out.get(r.occurrence_id) ?? {};
      m[`${r.offer_id}|${r.group_id}`] = r.amount;
      out.set(r.occurrence_id, m);
    }
  }
  return out;
}

export interface EffectiveGroupPriceRow {
  tenantId: string;
  occurrenceId: string;
  offerId: string;
  groupId: string;
  price: rules.Resolved<number>;
}

/** Replaces the group prices of the given occurrences: pairs not in rows pay the general price. */
export async function writeEffectiveGroupPrices(tx: Tx, occurrenceIds: readonly string[], rows: readonly EffectiveGroupPriceRow[]): Promise<void> {
  for (let i = 0; i < occurrenceIds.length; i += CHUNK) {
    await tx.deleteFrom("offers.effective_group_price").where("occurrence_id", "in", occurrenceIds.slice(i, i + CHUNK)).execute();
  }
  for (let i = 0; i < rows.length; i += CHUNK) {
    await tx
      .insertInto("offers.effective_group_price")
      .values(rows.slice(i, i + CHUNK).map((r) => ({
        tenant_id: r.tenantId, occurrence_id: r.occurrenceId, offer_id: r.offerId, group_id: r.groupId,
        amount: r.price.value, amount_source: r.price.source, amount_rule_id: r.price.ruleId,
      })))
      .execute();
  }
}

/**
 * Group prices per occurrence, then offer, then group. Only pairs whose group settings applied:
 * a missing pair pays the general price. activeOnly leaves out archived groups, as buyers see them.
 */
export async function loadGroupPrices(
  tx: Tx, occurrenceIds: readonly string[], opts: { activeOnly?: boolean } = {},
): Promise<Map<string, Map<string, Map<string, rules.Resolved<number>>>>> {
  const out = new Map<string, Map<string, Map<string, rules.Resolved<number>>>>();
  for (let i = 0; i < occurrenceIds.length; i += CHUNK) {
    let q = tx
      .selectFrom("offers.effective_group_price as p")
      .select(["p.occurrence_id", "p.offer_id", "p.group_id", "p.amount", "p.amount_source", "p.amount_rule_id"])
      .where("p.occurrence_id", "in", occurrenceIds.slice(i, i + CHUNK));
    if (opts.activeOnly) q = q.where((eb) => eb.exists(eb.selectFrom("catalog.user_group as g").whereRef("g.id", "=", "p.group_id").where("g.archived_at", "is", null).select("g.id")));
    for (const r of await q.execute()) {
      const byOffer = out.get(r.occurrence_id) ?? new Map<string, Map<string, rules.Resolved<number>>>();
      const byGroup = byOffer.get(r.offer_id) ?? new Map<string, rules.Resolved<number>>();
      byGroup.set(r.group_id, { value: r.amount, source: r.amount_source as ValueSource, ruleId: r.amount_rule_id });
      byOffer.set(r.offer_id, byGroup);
      out.set(r.occurrence_id, byOffer);
    }
  }
  return out;
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
