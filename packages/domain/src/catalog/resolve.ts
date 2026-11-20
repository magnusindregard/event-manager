import { type AdmissionMode, sql, type Tx } from "@event-manager/db";
import * as inventory from "../inventory/index.js";
import * as offerStore from "../offers/index.js";
import { emit } from "../outbox/index.js";
import * as rules from "../rules/index.js";
import { utcToLocal } from "./recurrence.js";

// Resolution per occurrence and field (docs/mvp.md): occurrence override → highest-priority
// matching rule → event default. The rule engine lives in the rules module; this loads the
// catalog side (event defaults, occurrences) and materializes the result in
// rules.effective_value, and offer prices per (occurrence, offer) in offers.effective_price.
// resolved_version = version marks an occurrence as safe to publish.

export interface EventDefaults {
  defaultLocationId: string | null;
  admissionMode: AdmissionMode;
  externalUrl: string | null;
  tagIds: string[];
  /** Places per occurrence; null is no limit. */
  capacity?: number | null;
  overbookingPct?: number;
}

export interface OccurrenceOverrides {
  locationOverrideId: string | null;
  externalUrlOverride: string | null;
  /** Cleared: the occurrence has no location / link, whatever rules and defaults say. */
  locationCleared?: boolean;
  externalUrlCleared?: boolean;
  tagsOverride: string[] | null;
  capacityOverride?: number | null;
}

export type Resolved<T> = rules.Resolved<T>;

export interface EffectiveValues {
  location: Resolved<string | null>;
  tags: Resolved<string[]>;
  externalUrl: Resolved<string | null>;
  capacity: Resolved<number | null>;
  overbooking: Resolved<number>;
}

export function defaultValues(event: EventDefaults): rules.FieldValues {
  return {
    location: event.defaultLocationId,
    tags: [...event.tagIds].sort(),
    externalUrl: event.admissionMode === "external" ? event.externalUrl : null,
    capacity: event.capacity ?? null,
    overbooking: event.overbookingPct ?? 0,
  };
}

export function overrideValues(occ: OccurrenceOverrides): Partial<rules.FieldValues> {
  const out: Partial<rules.FieldValues> = {};
  // A cleared override is an override with no value: it wins over rules and the default.
  if (occ.locationCleared) out.location = null;
  else if (occ.locationOverrideId !== null) out.location = occ.locationOverrideId;
  if (occ.tagsOverride !== null) out.tags = [...occ.tagsOverride].sort();
  // An override link applies even when the event has no admission link of its own.
  if (occ.externalUrlCleared) out.externalUrl = null;
  else if (occ.externalUrlOverride !== null) out.externalUrl = occ.externalUrlOverride;
  if (occ.capacityOverride !== null && occ.capacityOverride !== undefined) out.capacity = occ.capacityOverride;
  return out;
}

/** Pure: the effective values of one occurrence. Rules need the occurrence's local start. */
export function resolveFields(
  event: EventDefaults, occ: OccurrenceOverrides, withRules?: { rules: readonly rules.RuleDef[]; startLocal: string },
): EffectiveValues {
  const input = { defaults: defaultValues(event), overrides: overrideValues(occ), startLocal: withRules?.startLocal ?? "0000-01-01T00:00:00" };
  return rules.resolve(input, rules.ordered(withRules?.rules ?? [])).values as unknown as EffectiveValues;
}

export interface ResolutionContext {
  timezone: string;
  /** Registration events: upcoming occurrences that change place notify their attendees. */
  registration: boolean;
  /** Registration and ticketed events keep a capacity pool per occurrence in step with its effective capacity. */
  pooled: boolean;
  defaults: rules.FieldValues;
  rules: rules.Rule[];
  /** The event's offers, resolved per occurrence for price and availability. */
  offers: offerStore.PriceTarget[];
}

/** What every occurrence of an event resolves against: its defaults, timezone and rules. */
export async function resolutionContext(tx: Tx, eventId: string): Promise<ResolutionContext> {
  // FOR SHARE: configuration changes (rule saves, event defaults) lock the event row for update,
  // so the rules and defaults read here stay current until this transaction commits, and a
  // resolver that started earlier cannot publish values from an older configuration (#41).
  const event = await tx
    .selectFrom("catalog.event")
    .select(["timezone", "default_location_id", "admission_mode", "external_url", "capacity", "overbooking_pct"])
    .where("id", "=", eventId)
    .forShare()
    .executeTakeFirstOrThrow();
  const tags = await tx.selectFrom("catalog.event_tag").select("tag_id").where("event_id", "=", eventId).execute();
  return {
    timezone: event.timezone,
    registration: event.admission_mode === "registration",
    pooled: event.admission_mode === "registration" || event.admission_mode === "tickets",
    defaults: defaultValues({
      defaultLocationId: event.default_location_id,
      admissionMode: event.admission_mode,
      externalUrl: event.external_url,
      tagIds: tags.map((t) => t.tag_id),
      capacity: event.capacity,
      overbookingPct: event.overbooking_pct,
    }),
    rules: await rules.listRules(tx, eventId),
    // Read under the event's share lock: offer changes lock the event for update (like rules).
    offers: await offerStore.priceTargets(tx, eventId),
  };
}

const targetInputs = (c: ResolutionContext, overrides: Map<string, offerStore.OfferOverride> | undefined): rules.TargetInput[] => {
  const byOffer = offerStore.targetOverrides(overrides);
  return c.offers.map((o) => ({ ref: o.id, defaults: offerStore.targetDefaults(o), overrides: byOffer[o.id] ?? {} }));
};

/** The event's offers with their defaults, as the rule preview takes them. */
export const previewTargets = (c: ResolutionContext) => c.offers.map((o) => ({ ref: o.id, defaults: offerStore.targetDefaults(o) }));

/** The offers' own group prices, as the rule preview takes them. */
export const previewGroupTargets = (c: ResolutionContext) =>
  c.offers.flatMap((o) => o.groupPrices.map((g) => ({ ref: o.id, group: g.groupId, groupDefault: g.amount })));

/**
 * (offer, group) pairs to resolve at one occurrence: the offers' group prices, the rules' group
 * effects and the occurrence's group overrides. Offers outside the event are ignored.
 */
function groupInputs(c: ResolutionContext, groupOverrides: Record<string, number> | undefined): rules.GroupTargetInput[] {
  const offers = new Map(c.offers.map((o) => [o.id, o]));
  const pairs = new Map<string, rules.GroupTargetInput>();
  const add = (ref: string, group: string) => {
    const k = rules.groupKey(ref, group);
    if (pairs.has(k) || !offers.has(ref)) return;
    const own = offers.get(ref)!.groupPrices.find((g) => g.groupId === group);
    pairs.set(k, { ref, group, groupDefault: own?.amount ?? null, override: groupOverrides?.[k] });
  };
  for (const o of c.offers) for (const g of o.groupPrices) add(o.id, g.groupId);
  for (const p of rules.groupRuleTargets(c.rules)) add(p.ref, p.group);
  for (const k of Object.keys(groupOverrides ?? {})) {
    const [ref, group] = k.split("|") as [string, string];
    add(ref, group);
  }
  return [...pairs.values()];
}

const occColumns = [
  "id", "tenant_id", "start_utc", "location_override_id", "external_url_override", "location_cleared", "external_url_cleared", "tags_override", "capacity_override",
] as const;
type OccRow = {
  location_override_id: string | null; external_url_override: string | null; location_cleared: boolean; external_url_cleared: boolean;
  tags_override: string[] | null; capacity_override: number | null;
};
const occOverrides = (o: OccRow) => overrideValues({
  locationOverrideId: o.location_override_id, externalUrlOverride: o.external_url_override, locationCleared: o.location_cleared,
  externalUrlCleared: o.external_url_cleared, tagsOverride: o.tags_override, capacityOverride: o.capacity_override,
});

/** An event's occurrences as the rule preview sees them. */
export async function previewOccurrences(tx: Tx, eventId: string, timezone: string, withOffers = false): Promise<rules.PreviewOccurrence[]> {
  const rows = await tx.selectFrom("catalog.occurrence").select(occColumns).where("event_id", "=", eventId).orderBy("start_utc").orderBy("id").execute();
  const ids = rows.map((o) => o.id);
  const [overrides, groupOverrides] = withOffers
    ? await Promise.all([offerStore.loadOverrides(tx, ids), offerStore.loadGroupOverrides(tx, ids)])
    : [new Map<string, Map<string, offerStore.OfferOverride>>(), new Map<string, Record<string, number>>()];
  return rows.map((o) => ({
    id: o.id,
    startUtc: o.start_utc,
    startLocal: utcToLocal(o.start_utc, timezone),
    overrides: occOverrides(o),
    targetOverrides: offerStore.targetOverrides(overrides.get(o.id)),
    groupOverrides: groupOverrides.get(o.id),
  }));
}

const CHUNK = 1000;

/**
 * Resolves the given occurrences of an event (all of them when ids is omitted) in the
 * caller's transaction. The occurrences are locked first, in id order, so a concurrent
 * edit cannot slip in between reading an occurrence and marking it resolved.
 */
export async function resolveEventOccurrences(tx: Tx, eventId: string, ids?: readonly string[]): Promise<number> {
  if (ids && ids.length === 0) return 0;
  const c = await resolutionContext(tx, eventId);
  const ordered = rules.ordered(c.rules);
  const parts = ids ? Array.from({ length: Math.ceil(ids.length / CHUNK) }, (_, i) => ids.slice(i * CHUNK, (i + 1) * CHUNK)) : [null];
  let resolved = 0;
  for (const part of parts) {
    let q = tx.selectFrom("catalog.occurrence").select(occColumns).where("event_id", "=", eventId).orderBy("id").forUpdate();
    if (part) q = q.where("id", "in", part);
    const occs = await q.execute();
    if (occs.length === 0) continue;
    const rows = occs.map((o) => {
      const startLocal = utcToLocal(o.start_utc, c.timezone);
      return {
        tenantId: o.tenant_id,
        occurrenceId: o.id,
        startLocal,
        values: rules.resolve({ defaults: c.defaults, overrides: occOverrides(o), startLocal }, ordered).values,
      };
    });
    // Attendees are told when an upcoming registration occurrence changes place, whether by an
    // override, a rule or the event's default (occurrence.relocated.v1 → worker notices).
    const relocated: { occurrenceId: string; tenantId: string; from: unknown; to: unknown }[] = [];
    if (c.registration) {
      const now = new Date();
      const upcoming = occs.filter((o) => o.start_utc > now).map((o) => o.id);
      const before = upcoming.length ? await loadEffectiveValues(tx, upcoming) : new Map<string, Partial<EffectiveValues>>();
      for (const r of rows) {
        const prev = before.get(r.occurrenceId)?.location;
        if (prev && JSON.stringify(prev.value) !== JSON.stringify(r.values.location.value)) {
          relocated.push({ occurrenceId: r.occurrenceId, tenantId: r.tenantId, from: prev.value, to: r.values.location.value });
        }
      }
    }
    await rules.writeEffectiveValues(tx, rows);
    for (const m of relocated) {
      await emit(tx, m.tenantId, { type: "occurrence.relocated.v1", subject: `occurrence/${m.occurrenceId}`, data: { id: m.occurrenceId, eventId, from: m.from, to: m.to } });
    }
    if (c.offers.length) await resolvePrices(tx, eventId, c, ordered, rows);
    if (c.pooled) {
      await inventory.syncPools(tx, rows.map((r) => ({
        tenantId: r.tenantId, occurrenceId: r.occurrenceId,
        capacity: r.values.capacity.value as number | null, overbookingPct: r.values.overbooking.value as number,
      })));
    }
    for (let i = 0; i < occs.length; i += CHUNK) {
      await tx
        .updateTable("catalog.occurrence")
        .set({ resolved_version: sql<number>`version` })
        .where("id", "in", occs.slice(i, i + CHUNK).map((o) => o.id))
        .execute();
    }
    resolved += occs.length;
  }
  return resolved;
}

/**
 * Prices and availability per (occurrence, offer). The occurrences are locked by the caller, and
 * override writers lock the occurrence first, so the overrides read here stay current. Emits one
 * price.changed per batch, naming the occurrences whose prices or availability changed.
 */
async function resolvePrices(
  tx: Tx, eventId: string, c: ResolutionContext, ordered: readonly rules.RuleDef[],
  occs: readonly { tenantId: string; occurrenceId: string; startLocal: string }[],
): Promise<void> {
  const ids = occs.map((o) => o.occurrenceId);
  const [overrides, before, groupOverrides, groupBefore] = await Promise.all([
    offerStore.loadOverrides(tx, ids), offerStore.loadEffectivePrices(tx, ids), offerStore.loadGroupOverrides(tx, ids), offerStore.loadGroupPrices(tx, ids),
  ]);
  const out: offerStore.EffectivePriceRow[] = [];
  const groupOut: offerStore.EffectiveGroupPriceRow[] = [];
  const changed: string[] = [];
  for (const o of occs) {
    const { values } = rules.resolveTargets(targetInputs(c, overrides.get(o.occurrenceId)), o.startLocal, ordered);
    let differs = false;
    for (const [offerId, v] of values) {
      out.push({ tenantId: o.tenantId, occurrenceId: o.occurrenceId, offerId, values: v });
      const prev = before.get(o.occurrenceId)?.get(offerId);
      if (!prev || !rules.sameResolved(prev.price, v.price) || !rules.sameResolved(prev.available, v.offerAvailable)) differs = true;
    }
    // Group prices (docs/user-groups.md): sparse, so a pair that appears or goes away is a change too.
    const groups = rules.resolveGroupPrices(groupInputs(c, groupOverrides.get(o.occurrenceId)), o.startLocal, ordered).values;
    const prevGroups = groupBefore.get(o.occurrenceId);
    let prevCount = 0;
    for (const m of prevGroups?.values() ?? []) prevCount += m.size;
    if (prevCount !== groups.size) differs = true;
    for (const [k, price] of groups) {
      const [offerId, groupId] = k.split("|") as [string, string];
      groupOut.push({ tenantId: o.tenantId, occurrenceId: o.occurrenceId, offerId, groupId, price });
      const prev = prevGroups?.get(offerId)?.get(groupId);
      if (!prev || !rules.sameResolved(prev, price)) differs = true;
    }
    if (differs) changed.push(o.occurrenceId);
  }
  await offerStore.writeEffectivePrices(tx, out);
  await offerStore.writeEffectiveGroupPrices(tx, ids, groupOut);
  if (changed.length) {
    await emit(tx, occs[0]!.tenantId, { type: "price.changed.v1", subject: `event/${eventId}`, data: { eventId, occurrenceIds: changed } });
  }
}

/** Events with more occurrences than this are resolved by the worker after a rule or default change. */
export const INLINE_RESOLVE_LIMIT = 2000;

/**
 * After a change that can touch every occurrence of an event (rules, event defaults):
 * resolve now if the event is small, otherwise leave it to the worker. The caller puts the
 * returned mode in its outbox event; the worker's resolver queues a job for "queued". Until
 * the job runs, the public API keeps serving the previous effective values.
 */
export async function resolveEventSoon(tx: Tx, eventId: string): Promise<"done" | "queued"> {
  const { n } = await tx
    .selectFrom("catalog.occurrence")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("event_id", "=", eventId)
    .executeTakeFirstOrThrow();
  if (Number(n) > INLINE_RESOLVE_LIMIT) return "queued";
  await resolveEventOccurrences(tx, eventId);
  return "done";
}

/** Reads materialized effective values for a set of occurrences. */
export async function loadEffectiveValues(tx: Tx, occurrenceIds: readonly string[]): Promise<Map<string, Partial<EffectiveValues>>> {
  return (await rules.loadEffectiveValues(tx, occurrenceIds)) as Map<string, Partial<EffectiveValues>>;
}
