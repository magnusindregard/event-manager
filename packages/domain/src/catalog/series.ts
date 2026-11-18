import { type LocalDateTime, newId, sql, type Tx } from "@event-manager/db";
import { emit } from "../outbox/index.js";
import { type ActorContext, DomainError } from "../shared/index.js";
import { assertCan, getAccount, isValidTimezone, recordAudit } from "../tenancy/index.js";
import { expand, normalizeLocal, normalizeRrule, remapExdates, type SeriesDef, type Slot, slotAt, splitRules } from "./recurrence.js";
import { type ExistingOccurrence, planRegeneration, type RegenerationPlan } from "./regenerate.js";
import { resolveEventOccurrences } from "./resolve.js";
import { invalid, lockScheduleEvent, notFound, versionConflict } from "./shared.js";

// Series and Outlook-style edits (docs/mvp.md, "Series"). Every change regenerates the
// series' materialized occurrences in the caller's transaction, or only plans it (dryRun),
// which powers the admin's preview.

export interface Series extends SeriesDef {
  id: string;
  eventId: string;
  generatedUntil: Date;
  complete: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SeriesInput {
  rrule: string;
  dtstartLocal: LocalDateTime;
  /** Defaults to the event's default duration. */
  durationMin?: number;
  /** Defaults to the event's timezone. */
  timezone?: string;
}

export type SeriesPatch = Partial<SeriesInput>;

export interface SlotSummary {
  occurrenceId: string | null;
  recurrenceIdLocal: LocalDateTime | null;
  startUtc: Date;
  endUtc: Date;
}

/** What a change does to the occurrences. Lists are capped; counts are exact. */
export interface SeriesChanges {
  counts: { created: number; moved: number; deleted: number; conflicts: number; unchanged: number };
  created: SlotSummary[];
  moved: (SlotSummary & { fromStartUtc: Date; fromEndUtc: Date })[];
  deleted: SlotSummary[];
  conflicts: (SlotSummary & { reason: "moved" | "removed" })[];
}

export interface SeriesChangeResult {
  /** Null for the preview of a series that does not exist yet. */
  series: Series | null;
  changes: SeriesChanges;
}

export interface ChangeOptions {
  dryRun?: boolean;
  /** Clock for tests. Occurrences starting before now are history and stay as they are. */
  now?: Date;
}

const LIST_CAP = 200;
const CHUNK = 1000;

const columns = [
  "id", "event_id", "rrule", "dtstart_local", "duration_min", "timezone", "exdates", "generated_until", "complete",
  "version", "created_at", "updated_at",
] as const;
type Row = {
  id: string; event_id: string; rrule: string; dtstart_local: string; duration_min: number; timezone: string;
  exdates: string[]; generated_until: Date; complete: boolean; version: number; created_at: Date; updated_at: Date;
};

const toSeries = (r: Row): Series => ({
  id: r.id,
  eventId: r.event_id,
  rrule: r.rrule,
  dtstartLocal: r.dtstart_local,
  durationMin: r.duration_min,
  timezone: r.timezone,
  exdates: [...r.exdates].sort(),
  generatedUntil: r.generated_until,
  complete: r.complete,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export async function getSeries(tx: Tx, id: string): Promise<Series> {
  const row = await tx.selectFrom("catalog.series").select(columns).where("id", "=", id).executeTakeFirst();
  if (!row) throw notFound("Series");
  return toSeries(row);
}

export async function listSeries(tx: Tx, eventId: string): Promise<Series[]> {
  const rows = await tx.selectFrom("catalog.series").select(columns).where("event_id", "=", eventId).orderBy("dtstart_local").orderBy("id").execute();
  return rows.map(toSeries);
}

const addMonths = (d: Date, n: number) => {
  const x = new Date(d);
  x.setUTCMonth(x.getUTCMonth() + n);
  return x;
};

async function horizonFor(tx: Tx, now: Date, generatedUntil?: Date): Promise<Date> {
  const target = addMonths(now, (await getAccount(tx)).horizonMonths);
  return generatedUntil && generatedUntil > target ? generatedUntil : target;
}

const loadEvent = lockScheduleEvent;

/** Locks the series row: series edits, splits, deletes and horizon runs take turns. */
async function seriesForUpdate(tx: Tx, id: string): Promise<Series> {
  const row = await tx.selectFrom("catalog.series").select(columns).where("id", "=", id).forUpdate().executeTakeFirst();
  if (!row) throw notFound("Series");
  return toSeries(row);
}

function validateDef(def: SeriesDef): SeriesDef {
  if (!isValidTimezone(def.timezone)) throw invalid("timezone", "Unknown IANA timezone");
  if (!Number.isInteger(def.durationMin) || def.durationMin < 1 || def.durationMin > 100_000) throw invalid("durationMin", "Duration is 1 to 100000 minutes");
  return { ...def, rrule: normalizeRrule(def.rrule), dtstartLocal: normalizeLocal("dtstartLocal", def.dtstartLocal) };
}

/**
 * The series' occurrences, locked (by id, like other schedule changes): a hand edit committed
 * while regeneration waited is seen here (detached), and one started later waits for it and then
 * fails its version check if the occurrence was moved. The plan never overwrites a hand edit.
 */
async function loadExisting(tx: Tx, seriesId: string): Promise<ExistingOccurrence[]> {
  const rows = await tx
    .selectFrom("catalog.occurrence")
    .select(["id", "recurrence_id_local", "start_utc", "end_utc", "detached", "conflict"])
    .where("series_id", "=", seriesId)
    .orderBy("id")
    .forUpdate()
    .execute();
  return rows.map((r) => ({
    id: r.id, recurrenceIdLocal: r.recurrence_id_local!, startUtc: r.start_utc, endUtc: r.end_utc, detached: r.detached, conflict: r.conflict,
  }));
}

function summarize(plan: RegenerationPlan, createdIds?: string[]): SeriesChanges {
  const slot = (s: Slot, id: string | null): SlotSummary => ({ occurrenceId: id, recurrenceIdLocal: s.recurrenceIdLocal, startUtc: s.startUtc, endUtc: s.endUtc });
  return {
    counts: { created: plan.create.length, moved: plan.move.length, deleted: plan.delete.length, conflicts: plan.conflicts.length, unchanged: plan.unchanged },
    created: plan.create.slice(0, LIST_CAP).map((s, i) => slot(s, createdIds?.[i] ?? null)),
    moved: plan.move.slice(0, LIST_CAP).map((m) => ({ ...slot(m.to, m.id), fromStartUtc: m.from.startUtc, fromEndUtc: m.from.endUtc })),
    deleted: plan.delete.slice(0, LIST_CAP).map((d) => ({ occurrenceId: d.id, recurrenceIdLocal: null, startUtc: d.startUtc, endUtc: d.endUtc })),
    conflicts: plan.conflicts.slice(0, LIST_CAP).map((c) => ({ occurrenceId: c.id, recurrenceIdLocal: null, startUtc: c.startUtc, endUtc: c.endUtc, reason: c.reason })),
  };
}

const chunks = <T>(xs: readonly T[]) => Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, (i + 1) * CHUNK));

/** Writes a plan. Every touched occurrence gets a new version and is resolved again. */
async function applyPlan(tx: Tx, tenantId: string, eventId: string, seriesId: string, plan: RegenerationPlan): Promise<string[]> {
  const createdIds = plan.create.map(() => newId());
  for (const ids of chunks(plan.delete.map((d) => d.id))) {
    await tx.deleteFrom("catalog.occurrence").where("id", "in", ids).execute();
  }
  for (const part of chunks(plan.create.map((s, i) => ({ s, id: createdIds[i]! })))) {
    await tx
      .insertInto("catalog.occurrence")
      .values(part.map(({ s, id }) => ({
        id, tenant_id: tenantId, event_id: eventId, series_id: seriesId, recurrence_id_local: s.recurrenceIdLocal, start_utc: s.startUtc, end_utc: s.endUtc,
      })))
      .execute();
  }
  for (const part of chunks(plan.move)) {
    const values = sql.join(part.map((m) => sql`(${m.id}::uuid, ${m.to.startUtc.toISOString()}::timestamptz, ${m.to.endUtc.toISOString()}::timestamptz, ${m.to.recurrenceIdLocal}::timestamp)`));
    await sql`
      UPDATE catalog.occurrence o
         SET start_utc = v.s, end_utc = v.e, recurrence_id_local = v.k, conflict = false, version = o.version + 1
        FROM (VALUES ${values}) AS v(id, s, e, k)
       WHERE o.id = v.id`.execute(tx);
  }
  for (const part of chunks(plan.rekey)) {
    const values = sql.join(part.map((r) => sql`(${r.id}::uuid, ${r.recurrenceIdLocal}::timestamp)`));
    await sql`
      UPDATE catalog.occurrence o SET recurrence_id_local = v.k, version = o.version + 1
        FROM (VALUES ${values}) AS v(id, k) WHERE o.id = v.id`.execute(tx);
  }
  const flagged = plan.conflicts.map((c) => c.id);
  for (const ids of chunks(flagged)) {
    await tx.updateTable("catalog.occurrence").set({ conflict: true, version: sql<number>`version + 1` }).where("id", "in", ids).where("conflict", "=", false).execute();
  }
  const touched = [...new Set([...createdIds, ...plan.move.map((m) => m.id), ...plan.rekey.map((r) => r.id), ...flagged])];
  for (const ids of chunks(touched)) await resolveEventOccurrences(tx, eventId, ids);
  return createdIds;
}

interface Regeneration {
  plan: RegenerationPlan;
  untilUtc: Date;
  complete: boolean;
}

function regenerate(before: SeriesDef | null, after: SeriesDef, existing: ExistingOccurrence[], untilUtc: Date, cutoff: Date, fromUtc?: Date): Regeneration {
  const { slots, complete } = expand(after, { untilUtc, fromUtc });
  return { plan: planRegeneration({ before, after, existing, slots, cutoff }), untilUtc, complete };
}

const ruleDiff = (s: SeriesDef) => ({ rrule: s.rrule, dtstartLocal: s.dtstartLocal, durationMin: s.durationMin, timezone: s.timezone });

async function record(tx: Tx, ctx: ActorContext, action: string, series: { id: string; eventId: string }, changes: SeriesChanges, extra: Record<string, unknown>) {
  await recordAudit(tx, ctx, { action, entityType: "event", entityId: series.eventId, diff: { seriesId: series.id, ...extra, ...changes.counts } });
  await emit(tx, ctx.tenantId, {
    type: "series.changed.v1",
    subject: `series/${series.id}`,
    data: { id: series.id, eventId: series.eventId, change: action.replace(/^series\./, ""), ...changes.counts },
  });
}

/** Creates a series on an event and generates its occurrences up to the account horizon. */
export async function createSeries(tx: Tx, ctx: ActorContext, eventId: string, input: SeriesInput, opts: ChangeOptions = {}): Promise<SeriesChangeResult> {
  assertCan(ctx, "content.write");
  const event = await loadEvent(tx, eventId);
  const now = opts.now ?? new Date();
  const def = validateDef({
    rrule: input.rrule,
    dtstartLocal: input.dtstartLocal,
    durationMin: input.durationMin ?? event.default_duration_min,
    timezone: input.timezone ?? event.timezone,
    exdates: [],
  });
  const untilUtc = await horizonFor(tx, now);
  // A new series starts at its DTSTART, even in the past (imports); later edits leave the past alone.
  const r = regenerate(null, def, [], untilUtc, new Date(0));
  if (r.plan.create.length === 0) throw invalid("rrule", "The rule gives no occurrences in the planning horizon");
  if (opts.dryRun) return { series: null, changes: summarize(r.plan) };

  const id = newId();
  await tx
    .insertInto("catalog.series")
    .values({
      id, tenant_id: ctx.tenantId, event_id: eventId, rrule: def.rrule, dtstart_local: def.dtstartLocal, duration_min: def.durationMin,
      timezone: def.timezone, generated_until: r.untilUtc, complete: r.complete,
    })
    .execute();
  const createdIds = await applyPlan(tx, ctx.tenantId, eventId, id, r.plan);
  const changes = summarize(r.plan, createdIds);
  await record(tx, ctx, "series.created", { id, eventId }, changes, ruleDiff(def));
  return { series: await getSeries(tx, id), changes };
}

async function lockedSeries(tx: Tx, id: string, expectedVersion: number): Promise<Series> {
  const { eventId } = await getSeries(tx, id);
  await loadEvent(tx, eventId);
  const s = await seriesForUpdate(tx, id);
  if (s.version !== expectedVersion) throw versionConflict("Series", s.version);
  return s;
}

/** Outlook "edit entire series": the rule changes and upcoming occurrences follow it. */
export async function updateSeries(tx: Tx, ctx: ActorContext, id: string, expectedVersion: number, patch: SeriesPatch, opts: ChangeOptions = {}): Promise<SeriesChangeResult> {
  assertCan(ctx, "content.write");
  const before = await lockedSeries(tx, id, expectedVersion);
  const now = opts.now ?? new Date();
  const changed = validateDef({ ...before, ...stripUndefined(patch) });
  const after: SeriesDef = { ...changed, exdates: remapExdates(before, changed) };
  const untilUtc = await horizonFor(tx, now, before.generatedUntil);
  const r = regenerate(before, after, await loadExisting(tx, id), untilUtc, now);
  if (opts.dryRun) return { series: { ...before, ...after }, changes: summarize(r.plan) };

  const res = await tx
    .updateTable("catalog.series")
    .set({
      rrule: after.rrule, dtstart_local: after.dtstartLocal, duration_min: after.durationMin, timezone: after.timezone,
      exdates: [...after.exdates], generated_until: r.untilUtc, complete: r.complete, version: sql<number>`version + 1`,
    })
    .where("id", "=", id)
    .where("version", "=", expectedVersion)
    .executeTakeFirst();
  if (!res.numUpdatedRows) throw versionConflict("Series", before.version);
  const createdIds = await applyPlan(tx, ctx.tenantId, before.eventId, id, r.plan);
  const changes = summarize(r.plan, createdIds);
  await record(tx, ctx, "series.updated", before, changes, { from: ruleDiff(before), to: ruleDiff(after) });
  return { series: await getSeries(tx, id), changes };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Outlook "edit this and following": the series ends just before the slot, and a new
 * series with the changes starts at it. Upcoming occurrences from the slot on move to the
 * new series (same IDs) and follow its rule; detached ones stay and are flagged.
 */
export async function splitSeries(
  tx: Tx, ctx: ActorContext, id: string, expectedVersion: number, atLocal: LocalDateTime, patch: SeriesPatch, opts: ChangeOptions = {},
): Promise<SeriesChangeResult> {
  assertCan(ctx, "content.write");
  const old = await lockedSeries(tx, id, expectedVersion);
  const now = opts.now ?? new Date();
  const at = normalizeLocal("at", atLocal);
  const existing = await loadExisting(tx, id);
  const atOcc = existing.find((o) => o.recurrenceIdLocal === at);
  if (!atOcc && !expand(old, { untilUtc: old.generatedUntil }).slots.some((s) => s.recurrenceIdLocal === at)) {
    throw invalid("at", "Not an occurrence of this series");
  }
  if (slotAt(old, at).startUtc < now || (atOcc && atOcc.startUtc < now)) throw new DomainError("conflict", "Only upcoming occurrences can start a new series");
  if (at <= old.dtstartLocal) throw invalid("at", "Edit the entire series to change it from its first occurrence");

  const rules = splitRules(old, at);
  const head: SeriesDef = { ...old, rrule: rules.before, exdates: old.exdates.filter((x) => x < at) };
  const tailChanged = validateDef({ ...old, rrule: rules.after, dtstartLocal: at, ...stripUndefined(patch) });
  const tail: SeriesDef = { ...tailChanged, exdates: remapExdates({ ...old, exdates: old.exdates.filter((x) => x >= at) }, tailChanged) };
  const untilUtc = await horizonFor(tx, now, old.generatedUntil);
  const moving = existing.filter((o) => o.recurrenceIdLocal >= at);
  const headR = regenerate(old, head, existing.filter((o) => o.recurrenceIdLocal < at), untilUtc, now);
  // The tail's occurrences come from the old rule, so the old rule is "before" for conflicts.
  const tailR = regenerate(old, tail, moving, untilUtc, now);
  const plan: RegenerationPlan = {
    create: tailR.plan.create,
    move: [...headR.plan.move, ...tailR.plan.move],
    rekey: [...headR.plan.rekey, ...tailR.plan.rekey],
    delete: [...headR.plan.delete, ...tailR.plan.delete],
    conflicts: [...headR.plan.conflicts, ...tailR.plan.conflicts],
    unchanged: headR.plan.unchanged + tailR.plan.unchanged,
  };
  if (opts.dryRun) return { series: null, changes: summarize(plan) };

  const res = await tx
    .updateTable("catalog.series")
    .set({ rrule: head.rrule, exdates: [...head.exdates], complete: true, version: sql<number>`version + 1` })
    .where("id", "=", id)
    .where("version", "=", expectedVersion)
    .executeTakeFirst();
  if (!res.numUpdatedRows) throw versionConflict("Series", old.version);
  const newIdValue = newId();
  await tx
    .insertInto("catalog.series")
    .values({
      id: newIdValue, tenant_id: ctx.tenantId, event_id: old.eventId, rrule: tail.rrule, dtstart_local: tail.dtstartLocal, duration_min: tail.durationMin,
      timezone: tail.timezone, exdates: [...tail.exdates], generated_until: tailR.untilUtc, complete: tailR.complete,
    })
    .execute();
  for (const ids of chunks(moving.map((o) => o.id))) {
    await tx.updateTable("catalog.occurrence").set({ series_id: newIdValue }).where("id", "in", ids).execute();
  }
  await applyPlan(tx, ctx.tenantId, old.eventId, id, headR.plan);
  const createdIds = await applyPlan(tx, ctx.tenantId, old.eventId, newIdValue, tailR.plan);
  const changes = summarize(plan, [...createdIds]);
  await record(tx, ctx, "series.split", old, changes, { at, newSeriesId: newIdValue, from: ruleDiff(old), to: ruleDiff(tail) });
  return { series: await getSeries(tx, newIdValue), changes };
}

/**
 * Deletes a series. Its upcoming occurrences go, unless edited by hand; those and past
 * occurrences are kept as one-off occurrences of the event.
 */
export async function deleteSeries(tx: Tx, ctx: ActorContext, id: string, expectedVersion: number, opts: ChangeOptions = {}): Promise<SeriesChanges> {
  assertCan(ctx, "content.write");
  const s = await lockedSeries(tx, id, expectedVersion);
  const now = opts.now ?? new Date();
  const existing = await loadExisting(tx, id);
  const remove = existing.filter((o) => !o.detached && o.startUtc >= now);
  const keep = existing.filter((o) => !remove.includes(o));
  for (const ids of chunks(remove.map((o) => o.id))) await tx.deleteFrom("catalog.occurrence").where("id", "in", ids).execute();
  for (const ids of chunks(keep.map((o) => o.id))) {
    await tx
      .updateTable("catalog.occurrence")
      .set({ series_id: null, recurrence_id_local: null, conflict: false, version: sql<number>`version + 1` })
      .where("id", "in", ids)
      .execute();
    await resolveEventOccurrences(tx, s.eventId, ids);
  }
  await tx.deleteFrom("catalog.series").where("id", "=", id).execute();
  const changes: SeriesChanges = {
    counts: { created: 0, moved: 0, deleted: remove.length, conflicts: 0, unchanged: keep.length },
    created: [], moved: [], conflicts: [],
    deleted: remove.slice(0, LIST_CAP).map((o) => ({ occurrenceId: o.id, recurrenceIdLocal: o.recurrenceIdLocal, startUtc: o.startUtc, endUtc: o.endUtc })),
  };
  await record(tx, ctx, "series.deleted", s, changes, ruleDiff(s));
  return changes;
}

/**
 * Series that need extending at `at`, across tenants (SECURITY DEFINER; ids only). Run
 * without a tenant, then extend each one under its tenant.
 */
export async function seriesDueForExtension(tx: Tx, at: Date): Promise<{ tenantId: string; seriesId: string }[]> {
  const res = await sql<{ tenant_id: string; series_id: string }>`select tenant_id, series_id from catalog.series_due_for_extension(${at})`.execute(tx);
  return res.rows.map((r) => ({ tenantId: r.tenant_id, seriesId: r.series_id }));
}

/**
 * Nightly horizon job: generates an open-ended series up to the account horizon. Nothing
 * else changes, so there is no audit entry; the outbox event lets caches refresh.
 */
export async function extendSeriesHorizon(tx: Tx, tenantId: string, id: string, now: Date = new Date()): Promise<number> {
  const ref = await tx.selectFrom("catalog.series").select("event_id").where("id", "=", id).executeTakeFirst();
  if (!ref) return 0; // deleted since it was found due
  // Same lock order as other schedule changes: the event first (FOR SHARE; not
  // lockScheduleEvent, which refuses archived events), then the series and its occurrences.
  // Taking the event share only later, when resolving the new occurrences, deadlocked with a
  // rule save, which holds the event for update and then waits for the occurrences.
  await tx.selectFrom("catalog.event").select("id").where("id", "=", ref.event_id).forShare().execute();
  // The series is locked, and read after any edit in progress commits: a rule changed meanwhile
  // (shortened, completed) is the one extended, and overlapping runs see each other's slots.
  const s = await seriesForUpdate(tx, id).catch((e: unknown) => {
    if (e instanceof DomainError && e.code === "not_found") return null; // deleted while we waited
    throw e;
  });
  if (!s || s.complete) return 0;
  const untilUtc = await horizonFor(tx, now, s.generatedUntil);
  const { slots, complete } = expand(s, { untilUtc, fromUtc: s.generatedUntil });
  // Only new slots; existing occurrences are untouched.
  const keys = new Set((await loadExisting(tx, id)).map((o) => o.recurrenceIdLocal));
  const create = slots.filter((x) => x.startUtc >= now && !keys.has(x.recurrenceIdLocal));
  const plan: RegenerationPlan = { create, move: [], rekey: [], delete: [], conflicts: [], unchanged: 0 };
  await tx.updateTable("catalog.series").set({ generated_until: untilUtc, complete }).where("id", "=", id).execute();
  if (create.length === 0) return 0;
  await applyPlan(tx, tenantId, s.eventId, id, plan);
  await emit(tx, tenantId, {
    type: "series.changed.v1",
    subject: `series/${id}`,
    data: { id, eventId: s.eventId, change: "extended", created: create.length, generatedUntil: untilUtc.toISOString() },
  });
  return create.length;
}
