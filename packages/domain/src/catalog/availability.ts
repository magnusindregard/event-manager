import type { AccessPolicy, AdmissionMode, EventStatus, OccurrenceStatus, Tx } from "@event-manager/db";
import * as inventory from "../inventory/index.js";
import { loadEffectiveValues } from "./resolve.js";
import { notFound } from "./shared.js";

// Whether an occurrence takes registrations now, and how full it is (docs/registration.md,
// "Public API"). One pure function, used by the public API, the attendee API and the
// registration module, so they never disagree about "open".

export type AvailabilityStatus = "available" | "few_left" | "full" | "closed";

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
  if (available <= 0) return { status: "full", opensAt, closesAt };
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
  });

/**
 * An occurrence with registrations keeps its time: a series occurrence is detached, so
 * regeneration never moves or deletes it and reports a conflict instead. The version is not
 * bumped, so the occurrence stays resolved and visible in the public API.
 */
export async function detachForRegistrations(tx: Tx, occurrenceId: string): Promise<void> {
  await tx.updateTable("catalog.occurrence").set({ detached: true }).where("id", "=", occurrenceId).where("series_id", "is not", null).where("detached", "=", false).execute();
}

/** Ids of an event's occurrences that have not started, e.g. to notify attendees when the event is cancelled. */
export async function upcomingOccurrenceIds(tx: Tx, eventId: string, now: Date = new Date()): Promise<string[]> {
  const rows = await tx.selectFrom("catalog.occurrence").select("id").where("event_id", "=", eventId).where("start_utc", ">", now).execute();
  return rows.map((r) => r.id);
}
