import { type AccessPolicy, type AdmissionMode, type EventStatus, type OccurrenceStatus, sql, type Tx } from "@event-manager/db";
import * as inventory from "../inventory/index.js";
import * as offers from "../offers/index.js";
import { DomainError } from "../shared/index.js";
import { getAccount } from "../tenancy/index.js";
import { availabilityOf, type AvailabilityStatus, fewLeftThreshold } from "./availability.js";
import { admits, eventAccessGroups, type GroupRef, groupByCode, groupName } from "./groups.js";
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
  /**
   * A sales channel's key (docs/ticketing.md, "Public API"): only the offers that channel
   * sells, each with its SKU and limits, and availability with exact places left.
   */
  channelId?: string;
  /**
   * One user group's view (docs/user-groups.md, "Public API"), by code: prices are that group's,
   * and offers it may not buy are left out. A projection of public data, not access control.
   */
  group?: string;
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
  /** User groups that may attend (docs/user-groups.md); empty: everyone. The frontend decides how to show a restricted event. */
  access: PublicAccess;
}

export interface PublicAccess {
  groups: { code: string; name: string }[];
}

export type Admission =
  | { mode: "external"; url: string }
  | { mode: "none" }
  /** url: the hosted registration page; null for invite-only occurrences (guests use their personal links). */
  | { mode: "registration"; url: string | null }
  /** Sold through the account's own sales channels; offers lists what is for sale. */
  | { mode: "tickets" };

/** Tickets are priced in the account's currency; NOK only for now (docs/ticketing.md). */
export const CURRENCY = "NOK";

export interface PublicOffer {
  id: string;
  code: string;
  name: string;
  description: string | null;
  /** Minor units (øre), VAT included. With a group asked for: that group's price. */
  price: PublicPrice;
  /** False when the occurrence is cancelled, or outside the offer's sales window. Channel callers: also without a SKU. */
  onSale: boolean;
  /** The sales window here; opensAt null: on sale as soon as the event is published. */
  opensAt: string | null;
  closesAt: string;
  /** User groups that may buy the offer, on top of the event's; empty: everyone the event admits. */
  access: PublicAccess;
  /** Groups with a price of their own here that may buy the offer; other groups pay price. */
  groupPrices: { group: string; price: PublicPrice }[];
  /** Channel callers only. */
  sku?: string | null;
  placesPerUnit?: number;
  minPerReservation?: number;
  maxPerReservation?: number;
}

export interface PublicPrice {
  amount: number;
  currency: string;
  vatIncluded: true;
}

const priceOf = (amount: number): PublicPrice => ({ amount, currency: CURRENCY, vatIncluded: true });

export type TicketAvailabilityStatus = "available" | "few_left" | "sold_out" | "not_on_sale";

export interface PublicAvailability {
  status: AvailabilityStatus;
  opensAt: string | null;
  closesAt: string;
}

/** Ticketed occurrences. */
export interface PublicTicketAvailability {
  status: TicketAvailabilityStatus;
  opensAt: string | null;
  closesAt: string;
  /** Channel callers only; null without a limit. */
  placesLeft?: number | null;
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
  /** Registration and ticketed occurrences; null otherwise. */
  availability: PublicAvailability | PublicTicketAvailability | null;
  /** Ticketed occurrences: the offers available here, in display order, with their prices. Empty otherwise. */
  offers: PublicOffer[];
  event: PublicEventSummary;
}

interface Ctx {
  channelId: string | null;
  /** The group asked for with ?group=. */
  group: GroupRef | null;
  attendeeUrl: string | null;
  now: Date;
  locale: string;
  defaultLocale: string;
  statuses: EventStatus[];
}

async function context(tx: Tx, opts: PublicReadOptions): Promise<Ctx> {
  const account = await getAccount(tx);
  const locale = opts.locale && account.locales.includes(opts.locale) ? opts.locale : account.defaultLocale;
  const group = opts.group ? await groupByCode(tx, opts.group) : null;
  if (opts.group && !group) throw new DomainError("unknown_group", "No active user group has this code", { field: "group", group: opts.group });
  return { channelId: opts.channelId ?? null, group, attendeeUrl: opts.attendeeUrl?.replace(/\/+$/, "") ?? null, now: opts.now ?? new Date(), locale, defaultLocale: account.defaultLocale, statuses: opts.preview ? ["published", "cancelled", "draft"] : ["published", "cancelled"] };
}

type EventRow = { id: string; slug: string; status: EventStatus; timezone: string; external_refs: Record<string, string> };

async function eventSummaries(tx: Tx, c: Ctx, rows: EventRow[]): Promise<Map<string, PublicEventSummary>> {
  const ids = [...new Set(rows.map((r) => r.id))];
  const out = new Map<string, PublicEventSummary>();
  if (!ids.length) return out;
  const [translations, access] = await Promise.all([
    tx.selectFrom("catalog.event_translation")
      .selectAll()
      .where("event_id", "in", ids)
      .where("locale", "in", [...new Set([c.locale, c.defaultLocale])])
      .execute(),
    eventAccessGroups(tx, ids),
  ]);
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
      access: publicAccess(c, access.get(r.id) ?? []),
    });
  }
  return out;
}

const publicAccess = (c: Ctx, groups: GroupRef[]): PublicAccess => ({
  groups: groups.map((g) => ({ code: g.code, name: groupName(g.names, c.locale, c.defaultLocale) })),
});

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
  /** One occurrence by id; like asking for its event, this finds unlisted events too. */
  occurrenceId?: string;
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
      "e.admission_mode", "e.access_policy", "e.registration_opens_min", "e.registration_closes_min", "e.waitlist_enabled", "e.waitlist_cutoff_min",
    ])
    .where("e.status", "in", c.statuses)
    .where(sql<boolean>`o.resolved_version = o.version`)
    .where("o.end_utc", ">", f.from)
    .orderBy("o.start_utc")
    .orderBy("o.id")
    .limit(f.limit);
  if (f.to) q = q.where("o.start_utc", "<", f.to);
  // Unlisted events (closed events) stay out of listings, but asking for the event by id or slug finds them.
  if (f.occurrenceId) q = q.where("o.id", "=", f.occurrenceId);
  if (f.event) q = UUID_RE.test(f.event) ? q.where("e.id", "=", f.event) : q.where("e.slug", "=", f.event);
  else if (!f.occurrenceId) q = q.where("e.listed", "=", true);
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
  registration_opens_min: number | null; registration_closes_min: number; waitlist_enabled: boolean; waitlist_cutoff_min: number;
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
  const ticketed = rows.filter((r) => r.admission_mode === "tickets");
  const poolIds = [...registrationIds, ...ticketed.map((r) => r.id)];
  const [events, locs, tags, pools, offerData] = await Promise.all([
    eventSummaries(tx, c, rows.map((r) => ({ id: r.event_id, slug: r.slug, status: r.status, timezone: r.timezone, external_refs: r.external_refs }))),
    locationRefs(tx, locIds),
    tagRefs(tx, c, tagIds),
    poolIds.length ? inventory.listPools(tx, poolIds) : Promise.resolve(new Map<string, inventory.Pool>()),
    ticketed.length ? offersFor(tx, c, ticketed) : Promise.resolve({ byOccurrence: new Map<string, PublicOffer[]>(), smallest: new Map<string, number>() }),
  ]);
  const { byOccurrence: offers, smallest } = offerData;
  return rows.map((r) => {
    const e = eff.get(r.id) ?? {};
    const url = e.externalUrl?.value ?? null;
    const event = events.get(r.event_id)!;
    const status: OccurrenceStatus = r.status === "cancelled" ? "cancelled" : r.occ_status;
    let admission: Admission = url ? { mode: "external", url } : { mode: "none" };
    let availability: PublicOccurrence["availability"] = null;
    if (r.admission_mode === "registration") {
      // Attendees cannot prove their group, so a restricted event is by invitation (docs/user-groups.md, "Registration").
      const open = (r.access_policy_override ?? r.access_policy) === "open" && event.access.groups.length === 0;
      admission = { mode: "registration", url: open && c.attendeeUrl ? `${c.attendeeUrl}/r/${r.id}` : null };
      const a = availabilityOf({
        now: c.now, startUtc: r.start_utc, eventStatus: r.status, occurrenceStatus: status,
        opensMinBefore: r.registration_opens_min, closesMinBefore: r.registration_closes_min, pool: pools.get(r.id) ?? null,
        waitlist: { enabled: r.waitlist_enabled, cutoffMinBefore: r.waitlist_cutoff_min },
      });
      availability = { status: a.status, opensAt: a.opensAt?.toISOString() ?? null, closesAt: a.closesAt.toISOString() };
    }
    if (r.admission_mode === "tickets") {
      admission = { mode: "tickets" };
      const a = ticketAvailability(offers.get(r.id) ?? [], pools.get(r.id) ?? null, smallest);
      // Exact places left for channel callers only (docs/registration.md, open question 6).
      availability = c.channelId ? a : { status: a.status, opensAt: a.opensAt, closesAt: a.closesAt };
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
      offers: offers.get(r.id) ?? [],
      event,
    };
  });
}

/**
 * Pure: a ticketed occurrence's availability. Channel callers also get placesLeft. Not on sale while none of
 * its offers is; sold out once no on-sale offer's smallest purchase (places per unit × minimum
 * per reservation) fits in the places left.
 */
export function ticketAvailability(
  list: readonly PublicOffer[], pool: Pick<inventory.Pool, "bookableLimit" | "available"> | null,
  /** Smallest purchase per offer id, for callers whose offers do not carry the limits. */
  smallest: ReadonlyMap<string, number> = new Map(),
): PublicTicketAvailability {
  const smallestPurchase = (o: PublicOffer) => smallest.get(o.id) ?? (o.placesPerUnit ?? 1) * (o.minPerReservation ?? 1);
  const opens = list.map((o) => o.opensAt);
  const opensAt = opens.length && !opens.includes(null) ? opens.reduce((a, b) => (a! < b! ? a : b)) : null;
  const closesAt = list.length ? list.map((o) => o.closesAt).reduce((a, b) => (a > b ? a : b)) : new Date(0).toISOString();
  const placesLeft = pool?.available ?? null;
  const selling = list.filter((o) => o.onSale);
  let status: TicketAvailabilityStatus;
  if (!selling.length || !pool) status = "not_on_sale";
  else if (placesLeft === null) status = "available";
  // An offer fits only if its smallest allowed purchase does.
  else if (!selling.some((o) => smallestPurchase(o) <= placesLeft)) status = "sold_out";
  else status = placesLeft <= fewLeftThreshold(pool.bookableLimit!) ? "few_left" : "available";
  return { status, opensAt, closesAt, placesLeft };
}

/**
 * Active offers per occurrence with their effective prices, leaving out offers taken off sale
 * there (offerAvailable false) and offers whose prices are not resolved yet. Channel callers
 * see only the offers their channel sells, with the channel's SKU and the offer's limits.
 */
async function offersFor(tx: Tx, c: Ctx, rows: OccRow[]): Promise<{ byOccurrence: Map<string, PublicOffer[]>; smallest: Map<string, number> }> {
  const eventIds = [...new Set(rows.map((r) => r.event_id))];
  let offerQuery = tx.selectFrom("offers.offer as o")
    .select(["o.id", "o.event_id", "o.code", "o.sort_order", "o.vat_class_id", "o.places_per_unit", "o.min_per_reservation", "o.max_per_reservation",
      "o.on_sale_min_before", "o.on_sale_at", "o.off_sale_min_before", "o.off_sale_at"])
    .where("o.event_id", "in", eventIds).where("o.status", "=", "active")
    .orderBy("o.sort_order").orderBy("o.code");
  const channelId = c.channelId;
  if (channelId) {
    offerQuery = offerQuery.where((eb) => eb.exists(eb.selectFrom("offers.offer_channel as oc").whereRef("oc.offer_id", "=", "o.id").where("oc.channel_id", "=", channelId).select("oc.offer_id")));
  }
  const occIds = rows.map((r) => r.id);
  const [offerRows, translations, prices, skus, accessRows, groupPrices, eventAccess, activeGroups] = await Promise.all([
    offerQuery.execute(),
    tx.selectFrom("offers.offer_translation as t").innerJoin("offers.offer as o", "o.id", "t.offer_id")
      .select(["t.offer_id", "t.locale", "t.name", "t.description"])
      .where("o.event_id", "in", eventIds).where("t.locale", "in", [...new Set([c.locale, c.defaultLocale])]).execute(),
    offers.loadEffectivePrices(tx, occIds),
    channelId
      ? tx.selectFrom("offers.sku_mapping").select(["vat_class_id", "external_sku"]).where("channel_id", "=", channelId).execute()
      : Promise.resolve([]),
    tx.selectFrom("offers.offer_access_group as oa").innerJoin("offers.offer as o", "o.id", "oa.offer_id").innerJoin("catalog.user_group as g", "g.id", "oa.group_id")
      .select(["oa.offer_id", "g.id", "g.code", "g.names"]).where("o.event_id", "in", eventIds).orderBy("g.sort_order").orderBy("g.code").execute(),
    offers.loadGroupPrices(tx, occIds, { activeOnly: true }),
    eventAccessGroups(tx, eventIds),
    tx.selectFrom("catalog.user_group").select(["id", "code"]).where("archived_at", "is", null).orderBy("sort_order").orderBy("code").execute(),
  ]);
  const offerAccessIds = new Map<string, { id: string }[]>();
  for (const a of accessRows) offerAccessIds.set(a.offer_id, [...(offerAccessIds.get(a.offer_id) ?? []), { id: a.id }]);
  // A group may buy an offer when both the event's and the offer's lists admit it.
  const mayBuy = (eventId: string, offerId: string, groupId: string | null) =>
    admits(eventAccess.get(eventId) ?? [], groupId) && admits(offerAccessIds.get(offerId) ?? [], groupId);
  const offerAccess = new Map<string, PublicAccess>();
  for (const a of accessRows) {
    const list = offerAccess.get(a.offer_id) ?? { groups: [] };
    list.groups.push({ code: a.code, name: groupName(a.names, c.locale, c.defaultLocale) });
    offerAccess.set(a.offer_id, list);
  }
  const skuOf = new Map(skus.map((m) => [m.vat_class_id, m.external_sku]));
  // Places per unit × minimum per reservation: what sold out compares with the places left.
  const smallest = new Map(offerRows.map((o) => [o.id, o.places_per_unit * o.min_per_reservation]));
  const out = new Map<string, PublicOffer[]>();
  for (const r of rows) {
    const scheduled = r.status !== "cancelled" && r.occ_status === "scheduled";
    const list: PublicOffer[] = [];
    for (const o of offerRows.filter((x) => x.event_id === r.event_id)) {
      const p = prices.get(r.id)?.get(o.id);
      if (!p || !p.available.value) continue;
      // One group's view: only what it may buy, at its price.
      if (c.group && !mayBuy(r.event_id, o.id, c.group.id)) continue;
      const own = groupPrices.get(r.id)?.get(o.id);
      const amount = (c.group ? own?.get(c.group.id)?.value : undefined) ?? p.price.value;
      const t = translations.find((x) => x.offer_id === o.id && x.locale === c.locale) ?? translations.find((x) => x.offer_id === o.id && x.locale === c.defaultLocale);
      const w = offers.salesWindow(r.start_utc, { onSaleMinBefore: o.on_sale_min_before, onSaleAt: o.on_sale_at, offSaleMinBefore: o.off_sale_min_before, offSaleAt: o.off_sale_at });
      const sku = skuOf.get(o.vat_class_id) ?? null;
      const offer: PublicOffer = {
        id: o.id, code: o.code, name: t?.name ?? o.code, description: t?.description ?? null,
        price: priceOf(amount),
        onSale: scheduled && offers.windowOpen(w, c.now) && (!channelId || sku !== null),
        opensAt: w.opensAt?.toISOString() ?? null,
        closesAt: w.closesAt.toISOString(),
        access: offerAccess.get(o.id) ?? { groups: [] },
        groupPrices: activeGroups
          .filter((g) => own?.has(g.id) && mayBuy(r.event_id, o.id, g.id))
          .map((g) => ({ group: g.code, price: priceOf(own!.get(g.id)!.value) })),
      };
      if (channelId) Object.assign(offer, { sku, placesPerUnit: o.places_per_unit, minPerReservation: o.min_per_reservation, maxPerReservation: o.max_per_reservation });
      list.push(offer);
    }
    out.set(r.id, list);
  }
  return { byOccurrence: out, smallest };
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
