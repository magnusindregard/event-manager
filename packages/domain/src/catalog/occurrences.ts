import { newId, type OccurrenceStatus, sql, type Tx } from "@event-manager/db";
import { emit } from "../outbox/index.js";
import { type ActorContext, DomainError } from "../shared/index.js";
import { assertCan, diffFields, recordAudit } from "../tenancy/index.js";
import { assertUsableLocation } from "./locations.js";
import { type EffectiveValues, loadEffectiveValues, resolveEventOccurrences } from "./resolve.js";
import { assertUrl, invalid, notFound, versionConflict } from "./shared.js";
import { assertUsableTags } from "./tags.js";

export interface Occurrence {
  id: string;
  eventId: string;
  seriesId: string | null;
  startUtc: Date;
  endUtc: Date;
  status: OccurrenceStatus;
  detached: boolean;
  overrides: { locationId: string | null; externalUrl: string | null; tagIds: string[] | null };
  effective: Partial<EffectiveValues>;
  version: number;
  updatedAt: Date;
}

export interface OccurrenceInput {
  startUtc: Date;
  /** Defaults to start + the event's default duration. */
  endUtc?: Date;
  locationOverrideId?: string | null;
  externalUrlOverride?: string | null;
  tagsOverride?: string[] | null;
}

export type OccurrencePatch = Partial<OccurrenceInput> & { status?: OccurrenceStatus };

const columns = [
  "id", "event_id", "series_id", "start_utc", "end_utc", "status", "detached", "location_override_id",
  "external_url_override", "tags_override", "version", "updated_at",
] as const;
type Row = {
  id: string; event_id: string; series_id: string | null; start_utc: Date; end_utc: Date; status: OccurrenceStatus;
  detached: boolean; location_override_id: string | null; external_url_override: string | null;
  tags_override: string[] | null; version: number; updated_at: Date;
};

async function hydrate(tx: Tx, rows: Row[]): Promise<Occurrence[]> {
  const eff = await loadEffectiveValues(tx, rows.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id,
    eventId: r.event_id,
    seriesId: r.series_id,
    startUtc: r.start_utc,
    endUtc: r.end_utc,
    status: r.status,
    detached: r.detached,
    overrides: { locationId: r.location_override_id, externalUrl: r.external_url_override, tagIds: r.tags_override },
    effective: eff.get(r.id) ?? {},
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
  from?: Date;
  to?: Date;
  /** Keyset cursor on (start_utc, id). */
  after?: { startUtc: Date; id: string };
  limit: number;
}

export async function listOccurrences(tx: Tx, f: OccurrenceFilter): Promise<Occurrence[]> {
  let q = tx.selectFrom("catalog.occurrence").select(columns).where("event_id", "=", f.eventId).orderBy("start_utc").orderBy("id").limit(f.limit);
  if (f.from) q = q.where("end_utc", ">", f.from);
  if (f.to) q = q.where("start_utc", "<", f.to);
  if (f.after) {
    const { startUtc, id } = f.after;
    q = q.where((eb) => eb.or([eb("start_utc", ">", startUtc), eb.and([eb("start_utc", "=", startUtc), eb("id", ">", id)])]));
  }
  return hydrate(tx, await q.execute());
}

async function validateOverrides(tx: Tx, input: Partial<OccurrenceInput>) {
  if (input.locationOverrideId) await assertUsableLocation(tx, input.locationOverrideId, "locationOverrideId");
  assertUrl("externalUrlOverride", input.externalUrlOverride);
  if (input.tagsOverride) await assertUsableTags(tx, input.tagsOverride, "tagsOverride");
}

const summary = (o: Occurrence) => ({ occurrenceId: o.id, startUtc: o.startUtc.toISOString(), endUtc: o.endUtc.toISOString() });

/** Adds a one-off occurrence (no series) to an event. */
export async function createOccurrence(tx: Tx, ctx: ActorContext, eventId: string, input: OccurrenceInput): Promise<Occurrence> {
  assertCan(ctx, "content.write");
  const event = await tx.selectFrom("catalog.event").select(["default_duration_min", "status"]).where("id", "=", eventId).executeTakeFirst();
  if (!event) throw notFound("Event");
  if (event.status === "archived") throw new DomainError("conflict", "The event is archived");
  const endUtc = input.endUtc ?? new Date(input.startUtc.getTime() + event.default_duration_min * 60_000);
  if (endUtc <= input.startUtc) throw invalid("endUtc", "End must be after start");
  await validateOverrides(tx, input);

  const id = newId();
  await tx
    .insertInto("catalog.occurrence")
    .values({
      id,
      tenant_id: ctx.tenantId,
      event_id: eventId,
      start_utc: input.startUtc,
      end_utc: endUtc,
      location_override_id: input.locationOverrideId ?? null,
      external_url_override: input.externalUrlOverride ?? null,
      tags_override: input.tagsOverride ?? null,
    })
    .execute();
  await resolveEventOccurrences(tx, eventId, [id]);
  const occ = await getOccurrence(tx, id);
  await recordAudit(tx, ctx, { action: "occurrence.created", entityType: "event", entityId: eventId, diff: summary(occ) });
  await emit(tx, ctx.tenantId, { type: "occurrence.created.v1", subject: `occurrence/${id}`, data: { id, eventId } });
  return occ;
}

export async function updateOccurrence(tx: Tx, ctx: ActorContext, id: string, expectedVersion: number, patch: OccurrencePatch): Promise<Occurrence> {
  assertCan(ctx, "content.write");
  const before = await getOccurrence(tx, id);
  const startUtc = patch.startUtc ?? before.startUtc;
  const endUtc = patch.endUtc ?? (patch.startUtc ? new Date(startUtc.getTime() + (before.endUtc.getTime() - before.startUtc.getTime())) : before.endUtc);
  if (endUtc <= startUtc) throw invalid("endUtc", "End must be after start");
  await validateOverrides(tx, patch);

  const row = await tx
    .updateTable("catalog.occurrence")
    .set({
      start_utc: startUtc,
      end_utc: endUtc,
      status: patch.status,
      location_override_id: patch.locationOverrideId,
      external_url_override: patch.externalUrlOverride,
      tags_override: patch.tagsOverride,
      // Hand edits to a series occurrence detach it, so regeneration leaves it alone (milestone 3).
      detached: before.seriesId ? true : undefined,
      version: sql<number>`version + 1`,
    })
    .where("id", "=", id)
    .where("version", "=", expectedVersion)
    .returning("id")
    .executeTakeFirst();
  if (!row) throw versionConflict("Occurrence", before.version);
  await resolveEventOccurrences(tx, before.eventId, [id]);
  const after = await getOccurrence(tx, id);

  const flat = (o: Occurrence) => ({
    startUtc: o.startUtc.toISOString(), endUtc: o.endUtc.toISOString(), status: o.status,
    locationOverrideId: o.overrides.locationId, externalUrlOverride: o.overrides.externalUrl, tagsOverride: o.overrides.tagIds,
  });
  const diff = diffFields(flat(before), flat(after));
  const cancelled = patch.status === "cancelled" && before.status !== "cancelled";
  await recordAudit(tx, ctx, { action: cancelled ? "occurrence.cancelled" : "occurrence.updated", entityType: "event", entityId: before.eventId, diff: { occurrenceId: id, ...diff } });
  await emit(tx, ctx.tenantId, {
    type: cancelled ? "occurrence.cancelled.v1" : "occurrence.changed.v1",
    subject: `occurrence/${id}`,
    data: { id, eventId: before.eventId, changed: Object.keys(diff) },
  });
  return after;
}

/**
 * Deletes a one-off occurrence. Series occurrences are excluded from their series instead
 * (EXDATE, milestone 3). A deleted occurrence's ID is never reused.
 */
export async function deleteOccurrence(tx: Tx, ctx: ActorContext, id: string, expectedVersion: number): Promise<void> {
  assertCan(ctx, "content.write");
  const before = await getOccurrence(tx, id);
  if (before.seriesId) throw new DomainError("conflict", "Series occurrences are removed through the series");
  const res = await tx.deleteFrom("catalog.occurrence").where("id", "=", id).where("version", "=", expectedVersion).executeTakeFirst();
  if (!res.numDeletedRows) throw versionConflict("Occurrence", before.version);
  await recordAudit(tx, ctx, { action: "occurrence.deleted", entityType: "event", entityId: before.eventId, diff: summary(before) });
  await emit(tx, ctx.tenantId, { type: "occurrence.deleted.v1", subject: `occurrence/${id}`, data: { id, eventId: before.eventId } });
}
