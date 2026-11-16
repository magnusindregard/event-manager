import { type AdmissionMode, type EffectiveField, sql, type Tx, type ValueSource } from "@event-manager/db";

// Resolution per occurrence and field (docs/mvp.md): occurrence override → highest-priority
// matching rule → event default. Rules arrive in milestone 4; until then a value comes from
// the override or the event. The result is materialized in rules.effective_value, and
// resolved_version = version marks the occurrence as safe to publish.

export interface EventDefaults {
  defaultLocationId: string | null;
  admissionMode: AdmissionMode;
  externalUrl: string | null;
  tagIds: string[];
}

export interface OccurrenceOverrides {
  locationOverrideId: string | null;
  externalUrlOverride: string | null;
  tagsOverride: string[] | null;
}

export interface Resolved<T> {
  value: T;
  source: ValueSource;
  ruleId: string | null;
}

export interface EffectiveValues {
  location: Resolved<string | null>;
  tags: Resolved<string[]>;
  externalUrl: Resolved<string | null>;
}

const fromDefault = <T>(value: T): Resolved<T> => ({ value, source: "default", ruleId: null });
const fromOverride = <T>(value: T): Resolved<T> => ({ value, source: "override", ruleId: null });

/** Pure: the effective values of one occurrence. */
export function resolveFields(event: EventDefaults, occ: OccurrenceOverrides): EffectiveValues {
  return {
    location: occ.locationOverrideId !== null ? fromOverride(occ.locationOverrideId) : fromDefault(event.defaultLocationId),
    tags: occ.tagsOverride !== null ? fromOverride([...occ.tagsOverride].sort()) : fromDefault([...event.tagIds].sort()),
    // An override link applies even when the event has no admission link of its own.
    externalUrl:
      occ.externalUrlOverride !== null
        ? fromOverride(occ.externalUrlOverride)
        : fromDefault(event.admissionMode === "external" ? event.externalUrl : null),
  };
}

/**
 * Resolves the given occurrences of an event (all of them when ids is omitted) in the
 * caller's transaction. Cheap for one-off occurrences; series and rule changes move this
 * to the worker in milestones 3 and 4.
 */
export async function resolveEventOccurrences(tx: Tx, eventId: string, ids?: readonly string[]): Promise<void> {
  if (ids && ids.length === 0) return;
  const event = await tx
    .selectFrom("catalog.event")
    .select(["default_location_id", "admission_mode", "external_url"])
    .where("id", "=", eventId)
    .executeTakeFirstOrThrow();
  const tags = await tx.selectFrom("catalog.event_tag").select("tag_id").where("event_id", "=", eventId).execute();
  const defaults: EventDefaults = {
    defaultLocationId: event.default_location_id,
    admissionMode: event.admission_mode,
    externalUrl: event.external_url,
    tagIds: tags.map((t) => t.tag_id),
  };

  let q = tx
    .selectFrom("catalog.occurrence")
    .select(["id", "tenant_id", "version", "location_override_id", "external_url_override", "tags_override"])
    .where("event_id", "=", eventId);
  if (ids) q = q.where("id", "in", ids);
  const occs = await q.execute();
  if (occs.length === 0) return;

  const rows: { tenant_id: string; occurrence_id: string; field: EffectiveField; value: string; source: ValueSource; rule_id: string | null }[] = [];
  for (const o of occs) {
    const eff = resolveFields(defaults, {
      locationOverrideId: o.location_override_id,
      externalUrlOverride: o.external_url_override,
      tagsOverride: o.tags_override,
    });
    for (const field of ["location", "tags", "externalUrl"] as const) {
      const r = eff[field];
      rows.push({ tenant_id: o.tenant_id, occurrence_id: o.id, field, value: JSON.stringify(r.value), source: r.source, rule_id: r.ruleId });
    }
  }
  await tx
    .insertInto("rules.effective_value")
    .values(rows)
    .onConflict((oc) =>
      oc.columns(["occurrence_id", "field"]).doUpdateSet((eb) => ({
        value: eb.ref("excluded.value"),
        source: eb.ref("excluded.source"),
        rule_id: eb.ref("excluded.rule_id"),
      })),
    )
    .execute();
  await tx
    .updateTable("catalog.occurrence")
    .set({ resolved_version: sql<number>`version` })
    .where("id", "in", occs.map((o) => o.id))
    .execute();
}

/** Reads materialized effective values for a set of occurrences. */
export async function loadEffectiveValues(tx: Tx, occurrenceIds: readonly string[]): Promise<Map<string, Partial<EffectiveValues>>> {
  const out = new Map<string, Partial<EffectiveValues>>();
  if (occurrenceIds.length === 0) return out;
  const rows = await tx
    .selectFrom("rules.effective_value")
    .select(["occurrence_id", "field", "value", "source", "rule_id"])
    .where("occurrence_id", "in", occurrenceIds)
    .execute();
  for (const r of rows) {
    const m = out.get(r.occurrence_id) ?? {};
    (m as Record<string, Resolved<unknown>>)[r.field] = { value: r.value, source: r.source, ruleId: r.rule_id };
    out.set(r.occurrence_id, m);
  }
  return out;
}
