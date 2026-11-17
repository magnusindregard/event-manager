import { type AccessPolicy, type AdmissionMode, type EventStatus, type OccurrenceStatus, sql, type Tx } from "@event-manager/db";
import * as inventory from "../inventory/index.js";
import { getAccount } from "../tenancy/index.js";
import { availabilityOf, type AvailabilityStatus } from "./availability.js";
import { loadEffectiveValues } from "./resolve.js";

// Read model for the public API (/public/v1). Only published and cancelled events are
// visible (drafts too with a preview token), and only occurrences whose effective values
// are resolved for their current version, so readers never see half-resolved data.

export interface PublicReadOptions {
  /** Preview tokens also see drafts. */
  preview: boolean;
  locale?: string;
  /** Base URL of the hosted attendee pages; registration links point there. */
  attendeeUrl?: string;
  now?: Date;
}

export interface PublicLocationRef {
  id: string;
  name: string;
  kind: "venue" | "space";
  venue: { id: string; name: string } | null;
}

export interface PublicTag {
  id: string;
  key: string;
  vocabulary: string;
  label: string;
}

export interface PublicEventSummary {
  id: string;
  slug: string;
  status: "published" | "cancelled" | "draft";
  /** Locale of the text fields: the requested one, or the account default as fallback. */
  locale: string;
  title: string;
  shortDescription: string | null;
  image: { url: string; alt: string | null } | null;
  timezone: string;
  externalRefs: Record<string, string>;
}

export type Admission =
  | { mode: "external"; url: string }
  | { mode: "none" }
  /** url: the hosted registration page; null for invite-only occurrences (guests use their personal links). */
  | { mode: "registration"; url: string | null };

export interface PublicAvailability {
  status: AvailabilityStatus;
  opensAt: string | null;
  closesAt: string;
}

export interface PublicOccurrence {
  id: string;
  startUtc: string;
  endUtc: string;
  timezone: string;
  /** Cancelled when the occurrence or its whole event is cancelled. */
  status: OccurrenceStatus;
  location: PublicLocationRef | null;
  tags: PublicTag[];
  admission: Admission;
  /** Registration occurrences only; null otherwise. */
  availability: PublicAvailability | null;
  event: PublicEventSummary;
}

interface Ctx {
  attendeeUrl: string | null;
  now: Date;
  locale: string;
  defaultLocale: string;
  statuses: EventStatus[];
}

async function context(tx: Tx, opts: PublicReadOptions): Promise<Ctx> {
  const account = await getAccount(tx);
  const locale = opts.locale && account.locales.includes(opts.locale) ? opts.locale : account.defaultLocale;
  return { attendeeUrl: opts.attendeeUrl?.replace(/\/+$/, "") ?? null, now: opts.now ?? new Date(), locale, defaultLocale: account.defaultLocale, statuses: opts.preview ? ["published", "cancelled", "draft"] : ["published", "cancelled"] };
}

type EventRow = { id: string; slug: string; status: EventStatus; timezone: string; external_refs: Record<string, string> };

async function eventSummaries(tx: Tx, c: Ctx, rows: EventRow[]): Promise<Map<string, PublicEventSummary>> {
  const ids = [...new Set(rows.map((r) => r.id))];
  const out = new Map<string, PublicEventSummary>();
  if (!ids.length) return out;
  const translations = await tx
    .selectFrom("catalog.event_translation")
    .selectAll()
    .where("event_id", "in", ids)
    .where("locale", "in", [...new Set([c.locale, c.defaultLocale])])
    .execute();
  for (const r of rows) {
    if (out.has(r.id)) continue;
    const t = translations.find((x) => x.event_id === r.id && x.locale === c.locale) ?? translations.find((x) => x.event_id === r.id && x.locale === c.defaultLocale);
    out.set(r.id, {
      id: r.id,
      slug: r.slug,
      status: r.status as PublicEventSummary["status"],
      locale: t?.locale ?? c.defaultLocale,
      title: t?.title ?? r.slug,
      shortDescription: t?.short_description ?? null,
      image: t?.image_url ? { url: t.image_url, alt: t.image_alt } : null,
      timezone: r.timezone,
      externalRefs: r.external_refs,
    });
  }
  return out;
}

async function locationRefs(tx: Tx, ids: string[]): Promise<Map<string, PublicLocationRef>> {
  const out = new Map<string, PublicLocationRef>();
  const unique = [...new Set(ids)];
  if (!unique.length) return out;
  const rows = await tx
    .selectFrom("catalog.location as l")
    .leftJoin("catalog.location as p", "p.id", "l.parent_id")
    .select(["l.id", "l.name", "l.kind", "p.id as parent_id", "p.name as parent_name"])
    .where("l.id", "in", unique)
    .execute();
  for (const r of rows) {
    out.set(r.id, { id: r.id, name: r.name, kind: r.kind, venue: r.parent_id ? { id: r.parent_id, name: r.parent_name! } : null });
  }
  return out;
}

async function tagRefs(tx: Tx, c: Ctx, ids: string[]): Promise<Map<string, PublicTag>> {
  const out = new Map<string, PublicTag>();
  const unique = [...new Set(ids)];
  if (!unique.length) return out;
  const rows = await tx
    .selectFrom("tenancy.tag as t")
    .innerJoin("tenancy.tag_vocabulary as v", "v.id", "t.vocabulary_id")
    .select(["t.id", "t.key", "t.labels", "v.key as vocabulary"])
    .where("t.id", "in", unique)
    .execute();
  for (const r of rows) out.set(r.id, { id: r.id, key: r.key, vocabulary: r.vocabulary, label: r.labels[c.locale] ?? r.labels[c.defaultLocale] ?? r.key });
  return out;
}

export interface PublicOccurrenceFilter {
  from: Date;
  to?: Date;
  /** Event id or slug. */
  event?: string;
  /** A venue matches its spaces too. */
  locationId?: string;
  tagId?: string;
  status?: OccurrenceStatus;
  after?: { startUtc: Date; id: string };
  limit: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listPublicOccurrences(
  tx: Tx,
  opts: PublicReadOptions,
  f: PublicOccurrenceFilter,
): Promise<{ locale: string; items: PublicOccurrence[] }> {
  const c = await context(tx, opts);
  let q = tx
    .selectFrom("catalog.occurrence as o")
    .innerJoin("catalog.event as e", "e.id", "o.event_id")
    .select([
      "o.id", "o.start_utc", "o.end_utc", "o.status as occ_status", "o.access_policy_override", "e.id as event_id", "e.slug", "e.status", "e.timezone", "e.external_refs",
      "e.admission_mode", "e.access_policy", "e.registration_opens_min", "e.registration_closes_min",
    ])
    .where("e.status", "in", c.statuses)
    .where(sql<boolean>`o.resolved_version = o.version`)
    .where("o.end_utc", ">", f.from)
    .orderBy("o.start_utc")
    .orderBy("o.id")
    .limit(f.limit);
  if (f.to) q = q.where("o.start_utc", "<", f.to);
  // Unlisted events (closed events) stay out of listings, but asking for the event by id or slug finds them.
  if (f.event) q = UUID_RE.test(f.event) ? q.where("e.id", "=", f.event) : q.where("e.slug", "=", f.event);
  else q = q.where("e.listed", "=", true);
  if (f.status === "cancelled") q = q.where((eb) => eb.or([eb("o.status", "=", "cancelled"), eb("e.status", "=", "cancelled")]));
  if (f.status === "scheduled") q = q.where("o.status", "=", "scheduled").where("e.status", "<>", "cancelled");
  if (f.after) {
    const { startUtc, id } = f.after;
    q = q.where((eb) => eb.or([eb("o.start_utc", ">", startUtc), eb.and([eb("o.start_utc", "=", startUtc), eb("o.id", ">", id)])]));
  }
  if (f.locationId) {
    const loc = f.locationId;
    q = q.where((eb) =>
      eb.exists(
        eb
          .selectFrom("rules.effective_value as ev")
          .innerJoin("catalog.location as l", (j) => j.on(sql<boolean>`l.id::text = ev.value #>> '{}'`))
          .whereRef("ev.occurrence_id", "=", "o.id")
          .where("ev.field", "=", "location")
          .where((w) => w.or([w("l.id", "=", loc), w("l.parent_id", "=", loc)]))
          .select("ev.field"),
      ),
    );
  }
  if (f.tagId) {
    const tag = f.tagId;
    q = q.where((eb) =>
      eb.exists(
        eb
          .selectFrom("rules.effective_value as ev")
          .whereRef("ev.occurrence_id", "=", "o.id")
          .where("ev.field", "=", "tags")
          .where(sql<boolean>`ev.value @> ${JSON.stringify([tag])}::jsonb`)
          .select("ev.field"),
      ),
    );
  }
  const rows = await q.execute();
  return { locale: c.locale, items: await toPublicOccurrences(tx, c, rows) };
}

type OccRow = {
  id: string; start_utc: Date; end_utc: Date; occ_status: OccurrenceStatus; event_id: string;
  slug: string; status: EventStatus; timezone: string; external_refs: Record<string, string>;
  access_policy_override: AccessPolicy | null; admission_mode: AdmissionMode; access_policy: AccessPolicy;
  registration_opens_min: number | null; registration_closes_min: number;
};

async function toPublicOccurrences(tx: Tx, c: Ctx, rows: OccRow[]): Promise<PublicOccurrence[]> {
  const eff = await loadEffectiveValues(tx, rows.map((r) => r.id));
  const locIds: string[] = [];
  const tagIds: string[] = [];
  for (const e of eff.values()) {
    if (typeof e.location?.value === "string") locIds.push(e.location.value);
    if (Array.isArray(e.tags?.value)) tagIds.push(...e.tags.value);
  }
  const registrationIds = rows.filter((r) => r.admission_mode === "registration").map((r) => r.id);
  const [events, locs, tags, pools] = await Promise.all([
    eventSummaries(tx, c, rows.map((r) => ({ id: r.event_id, slug: r.slug, status: r.status, timezone: r.timezone, external_refs: r.external_refs }))),
    locationRefs(tx, locIds),
    tagRefs(tx, c, tagIds),
    registrationIds.length ? inventory.listPools(tx, registrationIds) : Promise.resolve(new Map<string, inventory.Pool>()),
  ]);
  return rows.map((r) => {
    const e = eff.get(r.id) ?? {};
    const url = e.externalUrl?.value ?? null;
    const status: OccurrenceStatus = r.status === "cancelled" ? "cancelled" : r.occ_status;
    let admission: Admission = url ? { mode: "external", url } : { mode: "none" };
    let availability: PublicAvailability | null = null;
    if (r.admission_mode === "registration") {
      const open = (r.access_policy_override ?? r.access_policy) === "open";
      admission = { mode: "registration", url: open && c.attendeeUrl ? `${c.attendeeUrl}/r/${r.id}` : null };
      const a = availabilityOf({
        now: c.now, startUtc: r.start_utc, eventStatus: r.status, occurrenceStatus: status,
        opensMinBefore: r.registration_opens_min, closesMinBefore: r.registration_closes_min, pool: pools.get(r.id) ?? null,
      });
      availability = { status: a.status, opensAt: a.opensAt?.toISOString() ?? null, closesAt: a.closesAt.toISOString() };
    }
    return {
      id: r.id,
      startUtc: r.start_utc.toISOString(),
      endUtc: r.end_utc.toISOString(),
      timezone: r.timezone,
      status,
      location: typeof e.location?.value === "string" ? (locs.get(e.location.value) ?? null) : null,
      tags: (e.tags?.value ?? []).map((id) => tags.get(id)).filter((t): t is PublicTag => !!t),
      admission,
      availability,
      event: events.get(r.event_id)!,
    };
  });
}

export interface PublicEventFilter {
  from?: Date;
  to?: Date;
  locationId?: string;
  tagId?: string;
  after?: string;
  limit: number;
}

export async function listPublicEvents(tx: Tx, opts: PublicReadOptions, f: PublicEventFilter): Promise<{ locale: string; items: (PublicEventSummary & { tags: PublicTag[] })[] }> {
  const c = await context(tx, opts);
  let q = tx
    .selectFrom("catalog.event as e")
    .select(["e.id", "e.slug", "e.status", "e.timezone", "e.external_refs", "e.default_location_id"])
    .where("e.status", "in", c.statuses)
    .where("e.listed", "=", true)
    .orderBy("e.id")
    .limit(f.limit);
  if (f.after) q = q.where("e.id", ">", f.after);
  if (f.tagId) {
    const tag = f.tagId;
    q = q.where((eb) => eb.exists(eb.selectFrom("catalog.event_tag as t").whereRef("t.event_id", "=", "e.id").where("t.tag_id", "=", tag).select("t.tag_id")));
  }
  if (f.from || f.to || f.locationId) {
    const { from, to, locationId } = f;
    q = q.where((eb) => {
      let sub = eb.selectFrom("catalog.occurrence as o").whereRef("o.event_id", "=", "e.id").where(sql<boolean>`o.resolved_version = o.version`).select("o.id");
      if (from) sub = sub.where("o.end_utc", ">", from);
      if (to) sub = sub.where("o.start_utc", "<", to);
      if (locationId) {
        sub = sub.where((w) =>
          w.exists(
            w.selectFrom("rules.effective_value as ev")
              .innerJoin("catalog.location as l", (j) => j.on(sql<boolean>`l.id::text = ev.value #>> '{}'`))
              .whereRef("ev.occurrence_id", "=", "o.id")
              .where("ev.field", "=", "location")
              .where((x) => x.or([x("l.id", "=", locationId), x("l.parent_id", "=", locationId)]))
              .select("ev.field"),
          ),
        );
      }
      return eb.exists(sub);
    });
  }
  const rows = await q.execute();
  const [summaries, tagRows] = await Promise.all([
    eventSummaries(tx, c, rows),
    rows.length ? tx.selectFrom("catalog.event_tag").select(["event_id", "tag_id"]).where("event_id", "in", rows.map((r) => r.id)).execute() : Promise.resolve([]),
  ]);
  const tags = await tagRefs(tx, c, tagRows.map((t) => t.tag_id));
  return {
    locale: c.locale,
    items: rows.map((r) => ({
      ...summaries.get(r.id)!,
      tags: tagRows.filter((t) => t.event_id === r.id).map((t) => tags.get(t.tag_id)).filter((t): t is PublicTag => !!t),
    })),
  };
}

export async function getPublicEvent(
  tx: Tx,
  opts: PublicReadOptions,
  idOrSlug: string,
  window: { from: Date; to?: Date; limit: number },
): Promise<{ locale: string; event: PublicEventSummary & { tags: PublicTag[]; occurrences: Omit<PublicOccurrence, "event">[] } } | null> {
  const c = await context(tx, opts);
  let q = tx.selectFrom("catalog.event").select(["id", "slug", "status", "timezone", "external_refs"]).where("status", "in", c.statuses);
  q = UUID_RE.test(idOrSlug) ? q.where("id", "=", idOrSlug) : q.where("slug", "=", idOrSlug);
  const row = await q.executeTakeFirst();
  if (!row) return null;
  const [summary] = [...(await eventSummaries(tx, c, [row])).values()];
  const eventTags = await tx.selectFrom("catalog.event_tag").select("tag_id").where("event_id", "=", row.id).execute();
  const tags = await tagRefs(tx, c, eventTags.map((t) => t.tag_id));
  const occs = await listPublicOccurrences(tx, opts, { event: row.id, from: window.from, to: window.to, limit: window.limit });
  return {
    locale: c.locale,
    event: {
      ...summary!,
      tags: [...tags.values()],
      occurrences: occs.items.map(({ event: _e, ...o }) => o),
    },
  };
}

export interface PublicVenue {
  id: string;
  name: string;
  address: string | null;
  geo: { lat: number; lng: number } | null;
  spaces: { id: string; name: string; address: string | null; geo: { lat: number; lng: number } | null }[];
}

export async function publicLocations(tx: Tx): Promise<PublicVenue[]> {
  const rows = await tx
    .selectFrom("catalog.location")
    .select(["id", "kind", "parent_id", "name", "address", "lat", "lng"])
    .where("archived_at", "is", null)
    .orderBy("name")
    .execute();
  const geo = (r: { lat: number | null; lng: number | null }) => (r.lat !== null && r.lng !== null ? { lat: r.lat, lng: r.lng } : null);
  return rows
    .filter((r) => r.kind === "venue")
    .map((v) => ({
      id: v.id,
      name: v.name,
      address: v.address,
      geo: geo(v),
      spaces: rows.filter((s) => s.parent_id === v.id).map((s) => ({ id: s.id, name: s.name, address: s.address, geo: geo(s) })),
    }));
}
