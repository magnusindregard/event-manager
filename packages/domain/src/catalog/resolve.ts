import { type AdmissionMode, sql, type Tx } from "@event-manager/db";
import * as rules from "../rules/index.js";
import { utcToLocal } from "./recurrence.js";

// Resolution per occurrence and field (docs/mvp.md): occurrence override → highest-priority
// matching rule → event default. The rule engine lives in the rules module; this loads the
// catalog side (event defaults, occurrences) and materializes the result in
// rules.effective_value. resolved_version = version marks an occurrence as safe to publish.

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

export type Resolved<T> = rules.Resolved<T>;

export interface EffectiveValues {
  location: Resolved<string | null>;
  tags: Resolved<string[]>;
  externalUrl: Resolved<string | null>;
}

export function defaultValues(event: EventDefaults): rules.FieldValues {
  return {
    location: event.defaultLocationId,
    tags: [...event.tagIds].sort(),
    externalUrl: event.admissionMode === "external" ? event.externalUrl : null,
  };
}

export function overrideValues(occ: OccurrenceOverrides): Partial<rules.FieldValues> {
  const out: Partial<rules.FieldValues> = {};
  if (occ.locationOverrideId !== null) out.location = occ.locationOverrideId;
  if (occ.tagsOverride !== null) out.tags = [...occ.tagsOverride].sort();
  // An override link applies even when the event has no admission link of its own.
  if (occ.externalUrlOverride !== null) out.externalUrl = occ.externalUrlOverride;
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
  defaults: rules.FieldValues;
  rules: rules.Rule[];
}

/** What every occurrence of an event resolves against: its defaults, timezone and rules. */
export async function resolutionContext(tx: Tx, eventId: string): Promise<ResolutionContext> {
  const event = await tx
    .selectFrom("catalog.event")
    .select(["timezone", "default_location_id", "admission_mode", "external_url"])
    .where("id", "=", eventId)
    .executeTakeFirstOrThrow();
  const tags = await tx.selectFrom("catalog.event_tag").select("tag_id").where("event_id", "=", eventId).execute();
  return {
    timezone: event.timezone,
    defaults: defaultValues({
      defaultLocationId: event.default_location_id,
      admissionMode: event.admission_mode,
      externalUrl: event.external_url,
      tagIds: tags.map((t) => t.tag_id),
    }),
    rules: await rules.listRules(tx, eventId),
  };
}

const occColumns = ["id", "tenant_id", "start_utc", "location_override_id", "external_url_override", "tags_override"] as const;

/** An event's occurrences as the rule preview sees them. */
export async function previewOccurrences(tx: Tx, eventId: string, timezone: string): Promise<rules.PreviewOccurrence[]> {
  const rows = await tx.selectFrom("catalog.occurrence").select(occColumns).where("event_id", "=", eventId).orderBy("start_utc").orderBy("id").execute();
  return rows.map((o) => ({
    id: o.id,
    startUtc: o.start_utc,
    startLocal: utcToLocal(o.start_utc, timezone),
    overrides: overrideValues({ locationOverrideId: o.location_override_id, externalUrlOverride: o.external_url_override, tagsOverride: o.tags_override }),
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
    const rows = occs.map((o) => ({
      tenantId: o.tenant_id,
      occurrenceId: o.id,
      values: rules.resolve(
        {
          defaults: c.defaults,
          overrides: overrideValues({ locationOverrideId: o.location_override_id, externalUrlOverride: o.external_url_override, tagsOverride: o.tags_override }),
          startLocal: utcToLocal(o.start_utc, c.timezone),
        },
        ordered,
      ).values,
    }));
    await rules.writeEffectiveValues(tx, rows);
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
