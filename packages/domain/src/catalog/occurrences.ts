import { newId, type OccurrenceStatus, sql, type Tx } from "@event-manager/db";
import { emit } from "../outbox/index.js";
import { type ActorContext, DomainError } from "../shared/index.js";
import { assertCan, diffFields, recordAudit } from "../tenancy/index.js";
import { assertUsableLocation } from "./locations.js";
import * as inventory from "../inventory/index.js";
import { type EffectiveValues, loadEffectiveValues, resolveEventOccurrences } from "./resolve.js";
import { assertUrl, invalid, lockScheduleEvent, notFound, pgCode, versionConflict } from "./shared.js";
import { isSlot, slotAt } from "./recurrence.js";
import { assertUsableTags } from "./tags.js";

export interface Occurrence {
  id: string;
  eventId: string;
  seriesId: string | null;
  /** The occurrence's slot in its series (local start), null for one-offs. */
  recurrenceIdLocal: string | null;
  startUtc: Date;
  endUtc: Date;
  status: OccurrenceStatus;
  detached: boolean;
  /** Detached, and the series has since moved or removed its slot. */
  conflict: boolean;
  /**
   * locationId / externalUrl null with the matching *Cleared false: inherit. *Cleared true:
   * the occurrence has no location / link, even when a rule or the event default has one.
   */
  overrides: {
    locationId: string | null; locationCleared: boolean; externalUrl: string | null; externalUrlCleared: boolean;
    tagIds: string[] | null; capacity: number | null;
  };
  effective: Partial<EffectiveValues>;
  /** Places, for occurrences of registration events. */
  pool: inventory.Pool | null;
  version: number;
  updatedAt: Date;
}

export interface OccurrenceInput {
  startUtc: Date;
  /** Defaults to start + the event's default duration. */
  endUtc?: Date;
  /** A location sets the override, null inherits. */
  locationOverrideId?: string | null;
  /** true: no location for this occurrence (clear). false: inherit, if it was cleared. */
  locationOverrideCleared?: boolean;
  externalUrlOverride?: string | null;
  /** true: no external link for this occurrence (clear). false: inherit, if it was cleared. */
  externalUrlOverrideCleared?: boolean;
  tagsOverride?: string[] | null;
  capacityOverride?: number | null;
}

export type OccurrencePatch = Partial<OccurrenceInput> & {
  status?: OccurrenceStatus;
  /** false dismisses a series conflict and keeps the occurrence as it is. */
  conflict?: false;
};

const columns = [
  "id", "event_id", "series_id", "recurrence_id_local", "conflict", "start_utc", "end_utc", "status", "detached", "location_override_id",
  "external_url_override", "location_cleared", "external_url_cleared", "tags_override", "capacity_override", "version", "updated_at",
] as const;
type Row = {
  id: string; event_id: string; series_id: string | null; recurrence_id_local: string | null; conflict: boolean; start_utc: Date; end_utc: Date; status: OccurrenceStatus;
  detached: boolean; location_override_id: string | null; external_url_override: string | null; location_cleared: boolean; external_url_cleared: boolean;
  tags_override: string[] | null; capacity_override: number | null; version: number; updated_at: Date;
};

async function hydrate(tx: Tx, rows: Row[]): Promise<Occurrence[]> {
  const eff = await loadEffectiveValues(tx, rows.map((r) => r.id));
  const pools = await inventory.listPools(tx, rows.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id,
    eventId: r.event_id,
    seriesId: r.series_id,
    recurrenceIdLocal: r.recurrence_id_local,
    startUtc: r.start_utc,
    endUtc: r.end_utc,
    status: r.status,
    detached: r.detached,
    conflict: r.conflict,
    overrides: {
      locationId: r.location_override_id, locationCleared: r.location_cleared, externalUrl: r.external_url_override, externalUrlCleared: r.external_url_cleared,
      tagIds: r.tags_override, capacity: r.capacity_override,
    },
    effective: eff.get(r.id) ?? {},
    pool: pools.get(r.id) ?? null,
    version: r.version,
    updatedAt: r.updated_at,
  }));
}

export async function getOccurrence(tx: Tx, id: string): Promise<Occurrence> {
  const row = await tx.selectFrom("catalog.occurrence").select(columns).where("id", "=", id).executeTakeFirst();
  if (!row) throw notFound("Occurrence");
  return (await hydrate(tx, [row]))[0]!;
}

export interface OccurrenceFilter {
  eventId: string;
  seriesId?: string;
  from?: Date;
  to?: Date;
  /** Keyset cursor on (start_utc, id). */
  after?: { startUtc: Date; id: string };
  limit: number;
}

export async function listOccurrences(tx: Tx, f: OccurrenceFilter): Promise<Occurrence[]> {
  let q = tx.selectFrom("catalog.occurrence").select(columns).where("event_id", "=", f.eventId).orderBy("start_utc").orderBy("id").limit(f.limit);
  if (f.seriesId) q = q.where("series_id", "=", f.seriesId);
  if (f.from) q = q.where("end_utc", ">", f.from);
  if (f.to) q = q.where("start_utc", "<", f.to);
  if (f.after) {
    const { startUtc, id } = f.after;
    q = q.where((eb) => eb.or([eb("start_utc", ">", startUtc), eb.and([eb("start_utc", "=", startUtc), eb("id", ">", id)])]));
  }
  return hydrate(tx, await q.execute());
}

async function validateOverrides(tx: Tx, input: Partial<OccurrenceInput>) {
  if (input.locationOverrideCleared && input.locationOverrideId) throw invalid("locationOverrideCleared", "Set a location or clear it, not both");
  if (input.externalUrlOverrideCleared && input.externalUrlOverride) throw invalid("externalUrlOverrideCleared", "Set a link or clear it, not both");
  if (input.locationOverrideId) await assertUsableLocation(tx, input.locationOverrideId, "locationOverrideId");
  assertUrl("externalUrlOverride", input.externalUrlOverride);
  if (input.tagsOverride) await assertUsableTags(tx, input.tagsOverride, "tagsOverride");
  const c = input.capacityOverride;
  if (c !== undefined && c !== null && (!Number.isInteger(c) || c < 0 || c > 1_000_000)) throw invalid("capacityOverride", "Must be a whole number of places, 0–1000000");
}

type OverrideState = { value: string | null; cleared: boolean };

/** The override state after an input: a value sets, null inherits, cleared true clears, cleared false inherits. */
function nextOverride(before: OverrideState, value: string | null | undefined, cleared: boolean | undefined): OverrideState {
  if (cleared === true) return { value: null, cleared: true };
  if (value !== undefined) return { value, cleared: false };
  if (cleared === false) return { value: before.value, cleared: false };
  return before;
}

const inherit: OverrideState = { value: null, cleared: false };

/**
 * An occurrence about to change: its event is locked and not archived (lockScheduleEvent), and
 * the occurrence row is locked, so series regeneration cannot plan from a state this change is
 * about to replace (it locks the same rows, after the event).
 */
async function lockedOccurrence(tx: Tx, id: string): Promise<Occurrence> {
  const ref = await tx.selectFrom("catalog.occurrence").select("event_id").where("id", "=", id).executeTakeFirst();
  if (!ref) throw notFound("Occurrence");
  await lockScheduleEvent(tx, ref.event_id);
  const row = await tx.selectFrom("catalog.occurrence").select(columns).where("id", "=", id).forUpdate().executeTakeFirst();
  if (!row) throw notFound("Occurrence");
  return (await hydrate(tx, [row]))[0]!;
}

const summary = (o: Occurrence) => ({ occurrenceId: o.id, startUtc: o.startUtc.toISOString(), endUtc: o.endUtc.toISOString() });

/** Adds a one-off occurrence (no series) to an event. */
export async function createOccurrence(tx: Tx, ctx: ActorContext, eventId: string, input: OccurrenceInput): Promise<Occurrence> {
  assertCan(ctx, "content.write");
  const event = await lockScheduleEvent(tx, eventId);
  const endUtc = input.endUtc ?? new Date(input.startUtc.getTime() + event.default_duration_min * 60_000);
  if (endUtc <= input.startUtc) throw invalid("endUtc", "End must be after start");
  await validateOverrides(tx, input);
  const location = nextOverride(inherit, input.locationOverrideId, input.locationOverrideCleared);
  const externalUrl = nextOverride(inherit, input.externalUrlOverride, input.externalUrlOverrideCleared);

  const id = newId();
  await tx
    .insertInto("catalog.occurrence")
    .values({
      id,
      tenant_id: ctx.tenantId,
      event_id: eventId,
      start_utc: input.startUtc,
      end_utc: endUtc,
      location_override_id: location.value,
      location_cleared: location.cleared,
      external_url_override: externalUrl.value,
      external_url_cleared: externalUrl.cleared,
      tags_override: input.tagsOverride ?? null,
      capacity_override: input.capacityOverride ?? null,
    })
    .execute();
  await resolveEventOccurrences(tx, eventId, [id]);
  const occ = await getOccurrence(tx, id);
  await recordAudit(tx, ctx, { action: "occurrence.created", entityType: "event", entityId: eventId, diff: summary(occ) });
  await emit(tx, ctx.tenantId, { type: "occurrence.created.v1", subject: `occurrence/${id}`, data: { id, eventId } });
  return occ;
}

interface Patched {
  before: Occurrence;
  diff: Record<string, { from: unknown; to: unknown }>;
  cancelled: boolean;
}

const flat = (o: { startUtc: Date; endUtc: Date; status: OccurrenceStatus; overrides: Occurrence["overrides"] }) => ({
  startUtc: o.startUtc.toISOString(), endUtc: o.endUtc.toISOString(), status: o.status,
  locationOverrideId: o.overrides.locationId, locationOverrideCleared: o.overrides.locationCleared,
  externalUrlOverride: o.overrides.externalUrl, externalUrlOverrideCleared: o.overrides.externalUrlCleared,
  tagsOverride: o.overrides.tagIds, capacityOverride: o.overrides.capacity,
});

/** Writes one occurrence change and its outbox event; the caller resolves and audits. */
async function patchOccurrence(tx: Tx, ctx: ActorContext, before: Occurrence, expectedVersion: number, patch: OccurrencePatch): Promise<Patched> {
  const startUtc = patch.startUtc ?? before.startUtc;
  const endUtc = patch.endUtc ?? (patch.startUtc ? new Date(startUtc.getTime() + (before.endUtc.getTime() - before.startUtc.getTime())) : before.endUtc);
  if (endUtc <= startUtc) throw invalid("endUtc", "End must be after start");
  // Hand edits of time or overrides detach a series occurrence, so regeneration leaves it
  // alone. Cancelling does not: a cancelled occurrence still follows its series.
  const sameTags = (a: string[] | null, b: string[] | null) => JSON.stringify(a && [...a].sort()) === JSON.stringify(b && [...b].sort());
  const b = before.overrides;
  const location = nextOverride({ value: b.locationId, cleared: b.locationCleared }, patch.locationOverrideId, patch.locationOverrideCleared);
  const externalUrl = nextOverride({ value: b.externalUrl, cleared: b.externalUrlCleared }, patch.externalUrlOverride, patch.externalUrlOverrideCleared);
  const edited =
    startUtc.getTime() !== before.startUtc.getTime() ||
    endUtc.getTime() !== before.endUtc.getTime() ||
    location.value !== b.locationId || location.cleared !== b.locationCleared ||
    externalUrl.value !== b.externalUrl || externalUrl.cleared !== b.externalUrlCleared ||
    (patch.tagsOverride !== undefined && !sameTags(patch.tagsOverride, before.overrides.tagIds)) ||
    (patch.capacityOverride !== undefined && patch.capacityOverride !== before.overrides.capacity);
  const detach = before.seriesId !== null && edited;

  const row = await tx
    .updateTable("catalog.occurrence")
    .set({
      start_utc: startUtc,
      end_utc: endUtc,
      status: patch.status,
      location_override_id: location.value,
      location_cleared: location.cleared,
      external_url_override: externalUrl.value,
      external_url_cleared: externalUrl.cleared,
      tags_override: patch.tagsOverride,
      capacity_override: patch.capacityOverride,
      detached: detach ? true : undefined,
      // Editing a conflicted occurrence, or dismissing the conflict, settles it.
      conflict: edited || patch.conflict === false ? false : undefined,
      version: sql<number>`version + 1`,
    })
    .where("id", "=", before.id)
    .where("version", "=", expectedVersion)
    .returning("id")
    .executeTakeFirst();
  if (!row) throw versionConflict("Occurrence", before.version);

  const after = {
    startUtc, endUtc, status: patch.status ?? before.status,
    overrides: {
      locationId: location.value,
      locationCleared: location.cleared,
      externalUrl: externalUrl.value,
      externalUrlCleared: externalUrl.cleared,
      tagIds: patch.tagsOverride !== undefined ? patch.tagsOverride : before.overrides.tagIds,
      capacity: patch.capacityOverride !== undefined ? patch.capacityOverride : before.overrides.capacity,
    },
  };
  const diff = diffFields(flat(before), flat(after));
  const cancelled = patch.status === "cancelled" && before.status !== "cancelled";
  await emit(tx, ctx.tenantId, {
    type: cancelled ? "occurrence.cancelled.v1" : "occurrence.changed.v1",
    subject: `occurrence/${before.id}`,
    data: { id: before.id, eventId: before.eventId, changed: Object.keys(diff) },
  });
  return { before, diff, cancelled };
}

export async function updateOccurrence(tx: Tx, ctx: ActorContext, id: string, expectedVersion: number, patch: OccurrencePatch): Promise<Occurrence> {
  assertCan(ctx, "content.write");
  const before = await lockedOccurrence(tx, id);
  await validateOverrides(tx, patch);
  const r = await patchOccurrence(tx, ctx, before, expectedVersion, patch);
  await resolveEventOccurrences(tx, before.eventId, [id]);
  await recordAudit(tx, ctx, {
    action: r.cancelled ? "occurrence.cancelled" : "occurrence.updated", entityType: "event", entityId: before.eventId, diff: { occurrenceId: id, ...r.diff },
  });
  return getOccurrence(tx, id);
}

export type BulkOccurrencePatch = Pick<
  OccurrencePatch,
  "locationOverrideId" | "locationOverrideCleared" | "externalUrlOverride" | "externalUrlOverrideCleared" | "tagsOverride" | "capacityOverride" | "status"
>;

export const BULK_LIMIT = 1000;

/**
 * Sets the same overrides or status on many occurrences of an event (the admin's "override
 * these"). All or nothing: if any occurrence has moved on from the given version, nothing
 * is saved. Overrides detach series occurrences, as a single edit does. One audit entry.
 */
export async function bulkUpdateOccurrences(
  tx: Tx, ctx: ActorContext, eventId: string, items: readonly { id: string; version: number }[], patch: BulkOccurrencePatch,
): Promise<Occurrence[]> {
  assertCan(ctx, "content.write");
  if (items.length === 0) return [];
  if (items.length > BULK_LIMIT) throw invalid("items", `At most ${BULK_LIMIT} occurrences at a time`);
  if (new Set(items.map((i) => i.id)).size !== items.length) throw invalid("items", "An occurrence is listed twice");
  if (Object.values(patch).every((v) => v === undefined)) throw invalid("set", "Nothing to change");
  await lockScheduleEvent(tx, eventId);
  await validateOverrides(tx, patch);

  const rows = await tx.selectFrom("catalog.occurrence").select(columns).where("id", "in", items.map((i) => i.id)).orderBy("id").forUpdate().execute();
  const befores = new Map((await hydrate(tx, rows)).map((o) => [o.id, o]));
  for (const i of items) {
    const b = befores.get(i.id);
    if (!b || b.eventId !== eventId) throw invalid("items", "Every occurrence must belong to the event");
  }
  let changed = 0;
  for (const i of items) {
    const r = await patchOccurrence(tx, ctx, befores.get(i.id)!, i.version, patch);
    if (Object.keys(r.diff).length) changed++;
  }
  const ids = items.map((i) => i.id);
  await resolveEventOccurrences(tx, eventId, ids);
  const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  await recordAudit(tx, ctx, { action: "occurrence.bulk_updated", entityType: "event", entityId: eventId, diff: { count: items.length, changed, set, occurrenceIds: ids } });
  const after = await tx.selectFrom("catalog.occurrence").select(columns).where("id", "in", ids).orderBy("start_utc").orderBy("id").execute();
  return hydrate(tx, after);
}

/**
 * Deletes an occurrence. A series occurrence's slot is also excluded from its series
 * (EXDATE), so regeneration does not bring it back. A deleted occurrence's ID is never reused.
 */
export async function deleteOccurrence(tx: Tx, ctx: ActorContext, id: string, expectedVersion: number): Promise<void> {
  assertCan(ctx, "content.write");
  const before = await lockedOccurrence(tx, id);
  // Registrations reference the occurrence without cascade (foreign key violation 23503).
  const res = await tx.deleteFrom("catalog.occurrence").where("id", "=", id).where("version", "=", expectedVersion).executeTakeFirst().catch((e: unknown) => {
    if (pgCode(e) === "23503") throw new DomainError("conflict", "The occurrence has registrations; cancel it instead", { occurrenceId: id });
    throw e;
  });
  if (!res.numDeletedRows) throw versionConflict("Occurrence", before.version);
  if (before.seriesId && before.recurrenceIdLocal) {
    await tx
      .updateTable("catalog.series")
      .set({ exdates: sql<string[]>`array_append(exdates, ${before.recurrenceIdLocal}::timestamp)`, version: sql<number>`version + 1` })
      .where("id", "=", before.seriesId)
      .execute();
  }
  await recordAudit(tx, ctx, {
    action: "occurrence.deleted", entityType: "event", entityId: before.eventId,
    diff: { ...summary(before), ...(before.seriesId ? { seriesId: before.seriesId, excluded: before.recurrenceIdLocal } : {}) },
  });
  await emit(tx, ctx.tenantId, { type: "occurrence.deleted.v1", subject: `occurrence/${id}`, data: { id, eventId: before.eventId, seriesId: before.seriesId } });
}

/**
 * Puts a detached series occurrence back on its slot: series time, no overrides (capacity
 * included), no conflict. Fails if the series no longer has the slot. An occurrence with
 * registrations stays detached (detachForRegistrations), so later regeneration still reports a
 * conflict instead of moving or deleting a booked occurrence.
 */
export async function reattachOccurrence(tx: Tx, ctx: ActorContext, id: string, expectedVersion: number): Promise<Occurrence> {
  assertCan(ctx, "content.write");
  const before = await lockedOccurrence(tx, id);
  if (!before.seriesId || !before.recurrenceIdLocal) throw new DomainError("conflict", "Only series occurrences can be reattached");
  const s = await tx.selectFrom("catalog.series").select(["rrule", "dtstart_local", "duration_min", "timezone", "exdates"]).where("id", "=", before.seriesId).executeTakeFirstOrThrow();
  const def = { rrule: s.rrule, dtstartLocal: s.dtstart_local, durationMin: s.duration_min, timezone: s.timezone, exdates: s.exdates };
  if (!isSlot(def, before.recurrenceIdLocal)) throw new DomainError("conflict", "The series no longer has this occurrence's slot");
  const slot = slotAt(def, before.recurrenceIdLocal);
  const row = await tx
    .updateTable("catalog.occurrence")
    .set({
      start_utc: slot.startUtc, end_utc: slot.endUtc, location_override_id: null, external_url_override: null, tags_override: null,
      capacity_override: null, location_cleared: false, external_url_cleared: false, conflict: false, version: sql<number>`version + 1`,
      detached: sql<boolean>`exists (select 1 from registration.registration r where r.occurrence_id = ${id} and r.status <> 'cancelled')`,
    })
    .where("id", "=", id)
    .where("version", "=", expectedVersion)
    .returning("id")
    .executeTakeFirst();
  if (!row) throw versionConflict("Occurrence", before.version);
  await resolveEventOccurrences(tx, before.eventId, [id]);
  await recordAudit(tx, ctx, { action: "occurrence.reattached", entityType: "event", entityId: before.eventId, diff: { ...summary(before), seriesId: before.seriesId } });
  await emit(tx, ctx.tenantId, { type: "occurrence.changed.v1", subject: `occurrence/${id}`, data: { id, eventId: before.eventId, changed: ["reattached"] } });
  return getOccurrence(tx, id);
}
