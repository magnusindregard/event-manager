import { type AccessPolicy, type AdmissionMode, type EventStatus, type OccurrenceStatus, sql, type Tx } from "@event-manager/db";
import * as inventory from "../inventory/index.js";
import { loadEffectiveValues } from "./resolve.js";
import { notFound } from "./shared.js";

// Whether an occurrence takes registrations now, and how full it is (docs/registration.md,
// "Public API"). One pure function, used by the public API, the attendee API and the
// registration module, so they never disagree about "open".

/** waitlist: full, but people can still join the waitlist and may be offered a place. */
export type AvailabilityStatus = "available" | "few_left" | "full" | "waitlist" | "closed";

export interface Availability {
  status: AvailabilityStatus;
  /** When registration opens; null when it opens as soon as the event is published. */
  opensAt: Date | null;
  closesAt: Date;
}

export interface AvailabilityInput {
  now: Date;
  startUtc: Date;
  eventStatus: EventStatus;
  occurrenceStatus: OccurrenceStatus;
  opensMinBefore: number | null;
  closesMinBefore: number;
  /** Null: no pool, so no registration. */
  pool: Pick<inventory.Pool, "bookableLimit" | "available"> | null;
  /** The event's waitlist; left out or disabled: none. */
  waitlist?: { enabled: boolean; cutoffMinBefore: number };
}

/** No waitlist offers from this time on; joining the waitlist after it would be pointless. */
export const waitlistCutoff = (startUtc: Date, cutoffMinBefore: number) => new Date(startUtc.getTime() - cutoffMinBefore * 60_000);

/**
 * Pure: when a waitlist offer made now must be claimed. The event's claim window, shortened to
 * half the time left before the occurrence starts when that is less, so an offer made close to
 * the start still leaves time for the next in line.
 */
export function claimDeadline(now: Date, startUtc: Date, claimWindowMin: number): Date {
  const window = claimWindowMin * 60_000;
  const half = Math.max(0, Math.floor((startUtc.getTime() - now.getTime()) / 2));
  return new Date(now.getTime() + Math.min(window, half));
}

export const registrationWindow = (startUtc: Date, opensMinBefore: number | null, closesMinBefore: number) => ({
  opensAt: opensMinBefore === null ? null : new Date(startUtc.getTime() - opensMinBefore * 60_000),
  closesAt: new Date(startUtc.getTime() - closesMinBefore * 60_000),
});

/** "Few left" from a tenth of the bookable limit (at least one place). */
export const fewLeftThreshold = (bookableLimit: number) => Math.max(1, Math.ceil(bookableLimit / 10));

/** Pure. Exact numbers stay internal; readers get a status. */
export function availabilityOf(i: AvailabilityInput): Availability {
  const { opensAt, closesAt } = registrationWindow(i.startUtc, i.opensMinBefore, i.closesMinBefore);
  const open =
    i.pool !== null && i.eventStatus === "published" && i.occurrenceStatus === "scheduled" &&
    (opensAt === null || i.now >= opensAt) && i.now < closesAt;
  if (!open) return { status: "closed", opensAt, closesAt };
  const { bookableLimit, available } = i.pool!;
  if (bookableLimit === null || available === null) return { status: "available", opensAt, closesAt };
  if (available <= 0) {
    const w = i.waitlist;
    return { status: w?.enabled && i.now < waitlistCutoff(i.startUtc, w.cutoffMinBefore) ? "waitlist" : "full", opensAt, closesAt };
  }
  return { status: available <= fewLeftThreshold(bookableLimit) ? "few_left" : "available", opensAt, closesAt };
}

/** What the registration module and the attendee pages need to know about an occurrence. */
export interface RegistrationTarget {
  occurrence: { id: string; eventId: string; seriesId: string | null; startUtc: Date; endUtc: Date; status: OccurrenceStatus };
  event: {
    id: string;
    slug: string;
    status: EventStatus;
    timezone: string;
    admissionMode: AdmissionMode;
    /** The occurrence's override, or the event's policy. */
    accessPolicy: AccessPolicy;
    guestAllowed: boolean;
    opensMinBefore: number | null;
    closesMinBefore: number;
    waitlistEnabled: boolean;
    claimWindowMin: number;
    waitlistCutoffMin: number;
    /** Reminder to confirmed attendees this many minutes before start; null: none. */
    reminderMinBefore: number | null;
    translations: Record<string, { title: string; shortDescription: string | null; imageUrl: string | null; imageAlt: string | null }>;
  };
  location: { name: string; address: string | null; venue: string | null } | null;
  pool: inventory.Pool | null;
}

export async function getRegistrationTarget(tx: Tx, occurrenceId: string): Promise<RegistrationTarget> {
  const row = await tx
    .selectFrom("catalog.occurrence as o")
    .innerJoin("catalog.event as e", "e.id", "o.event_id")
    .select([
      "o.id", "o.event_id", "o.series_id", "o.start_utc", "o.end_utc", "o.status as occ_status", "o.access_policy_override",
      "e.slug", "e.status", "e.timezone", "e.admission_mode", "e.access_policy", "e.guest_allowed", "e.registration_opens_min", "e.registration_closes_min",
      "e.reminder_min_before", "e.waitlist_enabled", "e.claim_window_min", "e.waitlist_cutoff_min",
    ])
    .where("o.id", "=", occurrenceId)
    .executeTakeFirst();
  if (!row) throw notFound("Occurrence");
  const [translations, eff, pool] = await Promise.all([
    tx.selectFrom("catalog.event_translation").selectAll().where("event_id", "=", row.event_id).execute(),
    loadEffectiveValues(tx, [row.id]),
    inventory.getPool(tx, row.id),
  ]);
  const locationId = eff.get(row.id)?.location?.value;
  let location: RegistrationTarget["location"] = null;
  if (typeof locationId === "string") {
    const l = await tx
      .selectFrom("catalog.location as l")
      .leftJoin("catalog.location as p", "p.id", "l.parent_id")
      .select(["l.name", "l.address", "p.name as parent_name", "p.address as parent_address"])
      .where("l.id", "=", locationId)
      .executeTakeFirst();
    if (l) location = { name: l.name, address: l.address ?? l.parent_address, venue: l.parent_name };
  }
  return {
    occurrence: { id: row.id, eventId: row.event_id, seriesId: row.series_id, startUtc: row.start_utc, endUtc: row.end_utc, status: row.occ_status },
    event: {
      id: row.event_id,
      slug: row.slug,
      status: row.status,
      timezone: row.timezone,
      admissionMode: row.admission_mode,
      accessPolicy: row.access_policy_override ?? row.access_policy,
      guestAllowed: row.guest_allowed,
      opensMinBefore: row.registration_opens_min,
      closesMinBefore: row.registration_closes_min,
      waitlistEnabled: row.waitlist_enabled,
      claimWindowMin: row.claim_window_min,
      waitlistCutoffMin: row.waitlist_cutoff_min,
      reminderMinBefore: row.reminder_min_before,
      translations: Object.fromEntries(translations.map((t) => [t.locale, { title: t.title, shortDescription: t.short_description, imageUrl: t.image_url, imageAlt: t.image_alt }])),
    },
    location,
    pool,
  };
}

export const targetAvailability = (t: RegistrationTarget, now: Date): Availability =>
  availabilityOf({
    now, startUtc: t.occurrence.startUtc, eventStatus: t.event.status, occurrenceStatus: t.occurrence.status,
    opensMinBefore: t.event.opensMinBefore, closesMinBefore: t.event.closesMinBefore, pool: t.pool,
    waitlist: { enabled: t.event.waitlistEnabled, cutoffMinBefore: t.event.waitlistCutoffMin },
  });

/**
 * An occurrence with registrations keeps its time: a series occurrence is detached, so
 * regeneration never moves or deletes it and reports a conflict instead. The version is not
 * bumped, so the occurrence stays resolved and visible in the public API.
 */
export async function detachForRegistrations(tx: Tx, occurrenceId: string): Promise<void> {
  await tx.updateTable("catalog.occurrence").set({ detached: true }).where("id", "=", occurrenceId).where("series_id", "is not", null).where("detached", "=", false).execute();
}

/**
 * Ids of an event's occurrences that have not ended, optionally only scheduled ones: whose
 * attendees to tell when the event is cancelled or restored. The end, not the start, matches the
 * notice task's own cutoff, so a dispatch delayed past the start still reaches attendees.
 */
export async function unendedOccurrenceIds(tx: Tx, eventId: string, opts: { now?: Date; scheduledOnly?: boolean } = {}): Promise<string[]> {
  let q = tx.selectFrom("catalog.occurrence").select("id").where("event_id", "=", eventId).where("end_utc", ">", opts.now ?? new Date());
  if (opts.scheduledOnly) q = q.where("status", "=", "scheduled");
  return (await q.execute()).map((r) => r.id);
}

/**
 * Ids of occurrences that have not ended and show this location to attendees: it is their
 * effective location, or it is the venue of their effective space (whose venue name and, when
 * the space has none, address they show).
 */
export async function unendedOccurrenceIdsAt(tx: Tx, locationId: string, now: Date = new Date()): Promise<string[]> {
  const rows = await tx
    .selectFrom("rules.effective_value as ev")
    .innerJoin("catalog.occurrence as o", "o.id", "ev.occurrence_id")
    .leftJoin("catalog.location as l", (j) => j.on(sql`l.id::text`, "=", sql`ev.value #>> '{}'`))
    .select("o.id")
    .where("ev.field", "=", "location")
    .where("o.end_utc", ">", now)
    .where((eb) => eb.or([eb(sql`ev.value #>> '{}'`, "=", locationId), eb("l.parent_id", "=", locationId)]))
    .execute();
  return rows.map((r) => r.id);
}

/** Ids of an event's occurrences that have not started, e.g. to notify attendees when the event is cancelled. */
export async function upcomingOccurrenceIds(tx: Tx, eventId: string, now: Date = new Date()): Promise<string[]> {
  const rows = await tx.selectFrom("catalog.occurrence").select("id").where("event_id", "=", eventId).where("start_utc", ">", now).execute();
  return rows.map((r) => r.id);
}

/**
 * The occurrences of an event that a guest can still pick, soonest first: scheduled and not
 * started. Used by the invitation page, where the guest chooses one when accepting.
 */
export async function upcomingRegistrationTargets(tx: Tx, eventId: string, now: Date, limit = 50): Promise<RegistrationTarget[]> {
  const rows = await tx
    .selectFrom("catalog.occurrence")
    .select("id")
    .where("event_id", "=", eventId)
    .where("status", "=", "scheduled")
    .where("start_utc", ">", now)
    .orderBy("start_utc")
    .orderBy("id")
    .limit(limit)
    .execute();
  return Promise.all(rows.map((r) => getRegistrationTarget(tx, r.id)));
}
