import { newId, type OfferStatus, sql, type Tx } from "@event-manager/db";
import * as catalog from "../catalog/index.js";
import { emit } from "../outbox/index.js";
import { type ActorContext, DomainError } from "../shared/index.js";
import { assertCan, diffFields, getAccount, recordAudit } from "../tenancy/index.js";
import { assertUsableVatClass } from "./vat.js";

// Offers (docs/ticketing.md, "Offer"): the ticket types a ticketed event sells, such as Adult,
// Student or Family. Each has a default price in minor units, VAT included; rules and overrides
// vary it per occurrence. Offer changes lock the event row for update, like rule changes, so a
// resolver that started earlier cannot publish prices from an older configuration (#41).

export interface OfferTranslation {
  name: string;
  description: string | null;
}

export interface Offer {
  id: string;
  eventId: string;
  code: string;
  vatClassId: string;
  sortOrder: number;
  status: OfferStatus;
  placesPerUnit: number;
  minPerReservation: number;
  maxPerReservation: number;
  /** Minor units (øre), VAT included. */
  defaultPrice: number;
  translations: Record<string, OfferTranslation>;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OfferInput {
  code?: string;
  vatClassId: string;
  sortOrder?: number;
  placesPerUnit?: number;
  minPerReservation?: number;
  maxPerReservation?: number;
  defaultPrice: number;
  translations: Record<string, { name: string; description?: string | null }>;
}

export type OfferPatch = Partial<Omit<OfferInput, "translations">> & {
  status?: OfferStatus;
  /** Per locale: replaces the stored translation, null removes it. Locales left out are unchanged. */
  translations?: Record<string, { name: string; description?: string | null } | null>;
};

export interface OfferChangeResult {
  offer: Offer | null;
  /** "queued": the worker resolves the event's prices shortly. "none": no prices change. */
  resolution: "done" | "queued" | "none";
}

const CODE_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
export const MAX_PRICE = 100_000_000;
const invalid = (field: string, message: string) => new DomainError("validation_failed", message, { field });

const columns = [
  "id", "event_id", "code", "vat_class_id", "sort_order", "status", "places_per_unit", "min_per_reservation", "max_per_reservation",
  "default_price", "version", "created_at", "updated_at",
] as const;
type Row = {
  id: string; event_id: string; code: string; vat_class_id: string; sort_order: number; status: OfferStatus; places_per_unit: number;
  min_per_reservation: number; max_per_reservation: number; default_price: number; version: number; created_at: Date; updated_at: Date;
};

async function hydrate(tx: Tx, rows: Row[]): Promise<Offer[]> {
  if (rows.length === 0) return [];
  const translations = await tx.selectFrom("offers.offer_translation").selectAll().where("offer_id", "in", rows.map((r) => r.id)).execute();
  return rows.map((r) => ({
    id: r.id,
    eventId: r.event_id,
    code: r.code,
    vatClassId: r.vat_class_id,
    sortOrder: r.sort_order,
    status: r.status,
    placesPerUnit: r.places_per_unit,
    minPerReservation: r.min_per_reservation,
    maxPerReservation: r.max_per_reservation,
    defaultPrice: r.default_price,
    translations: Object.fromEntries(translations.filter((t) => t.offer_id === r.id).map((t) => [t.locale, { name: t.name, description: t.description }])),
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

/** An event's offers in display order. */
export async function listOffers(tx: Tx, eventId: string): Promise<Offer[]> {
  const rows = await tx.selectFrom("offers.offer").select(columns).where("event_id", "=", eventId).orderBy("sort_order").orderBy("code").execute();
  return hydrate(tx, rows);
}

export async function getOffer(tx: Tx, id: string): Promise<Offer> {
  const row = await tx.selectFrom("offers.offer").select(columns).where("id", "=", id).executeTakeFirst();
  if (!row) throw new DomainError("not_found", "Offer not found");
  return (await hydrate(tx, [row]))[0]!;
}

/** Locks the event for the whole offer change. Offers are sold by ticketed events only. */
async function writableEvent(tx: Tx, eventId: string, requireTickets = true) {
  const event = await tx.selectFrom("catalog.event").select(["id", "status", "admission_mode"]).where("id", "=", eventId).forUpdate().executeTakeFirst();
  if (!event) throw new DomainError("not_found", "Event not found");
  if (event.status === "archived") throw new DomainError("conflict", "The event is archived");
  if (requireTickets && event.admission_mode !== "tickets") throw new DomainError("conflict", "The event does not sell tickets; set its admission to tickets first", { eventId });
}

const int = (field: string, v: number | undefined, min: number, max: number) => {
  if (v !== undefined && (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max)) throw invalid(field, `Must be a whole number, ${min}–${max}`);
};

function validateNumbers(o: Partial<Pick<Offer, "sortOrder" | "placesPerUnit" | "minPerReservation" | "maxPerReservation" | "defaultPrice">>) {
  int("sortOrder", o.sortOrder, -10_000, 10_000);
  int("placesPerUnit", o.placesPerUnit, 1, 100);
  int("minPerReservation", o.minPerReservation, 1, 1000);
  int("maxPerReservation", o.maxPerReservation, 1, 1000);
  int("defaultPrice", o.defaultPrice, 0, MAX_PRICE);
  if (o.minPerReservation !== undefined && o.maxPerReservation !== undefined && o.minPerReservation > o.maxPerReservation) {
    throw invalid("maxPerReservation", "The maximum is below the minimum");
  }
}

function validateTranslation(locale: string, t: { name: string; description?: string | null }, locales: string[]) {
  if (!locales.includes(locale)) throw invalid(`translations.${locale}`, `Locale ${locale} is not enabled for the account`);
  if (!t.name?.trim() || t.name.trim().length > 200) throw invalid(`translations.${locale}.name`, "Name the offer (at most 200 characters)");
  if (t.description != null && t.description.length > 2000) throw invalid(`translations.${locale}.description`, "At most 2000 characters");
}

async function writeTranslations(tx: Tx, tenantId: string, offerId: string, translations: Record<string, { name: string; description?: string | null } | null>) {
  for (const [locale, t] of Object.entries(translations)) {
    if (t === null) {
      await tx.deleteFrom("offers.offer_translation").where("offer_id", "=", offerId).where("locale", "=", locale).execute();
      continue;
    }
    const values = { name: t.name.trim(), description: t.description?.trim() || null };
    await tx
      .insertInto("offers.offer_translation")
      .values({ tenant_id: tenantId, offer_id: offerId, locale, ...values })
      .onConflict((oc) => oc.columns(["offer_id", "locale"]).doUpdateSet(values))
      .execute();
  }
}

const codeFrom = (name: string) => catalog.slugify(name).slice(0, 63).replace(/-+$/, "") || "offer";

async function uniqueCode(tx: Tx, eventId: string, base: string): Promise<string> {
  const taken = new Set((await tx.selectFrom("offers.offer").select("code").where("event_id", "=", eventId).execute()).map((r) => r.code));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const c = `${base.slice(0, 60)}-${i}`;
    if (!taken.has(c)) return c;
  }
}

function codeConflict(e: unknown): never {
  if (typeof e === "object" && e !== null && (e as { code?: string }).code === "23505") throw new DomainError("conflict", "Another offer of the event uses this code", { field: "code" });
  throw e;
}

async function changed(tx: Tx, ctx: ActorContext, eventId: string, offerId: string, change: "created" | "updated" | "deleted", resolve: boolean, audit: Record<string, unknown>) {
  const resolution = resolve ? await catalog.resolveEventSoon(tx, eventId) : "none";
  await recordAudit(tx, ctx, { action: `offer.${change}`, entityType: "event", entityId: eventId, diff: { offerId, ...audit } });
  await emit(tx, ctx.tenantId, { type: "offer.changed.v1", subject: `offer/${offerId}`, data: { id: offerId, eventId, change, resolution } });
  return resolution;
}

async function insertOffer(tx: Tx, ctx: ActorContext, eventId: string, input: OfferInput, locales: string[], defaultLocale: string): Promise<string> {
  for (const [locale, t] of Object.entries(input.translations ?? {})) validateTranslation(locale, t, locales);
  const defaultName = input.translations?.[defaultLocale]?.name;
  if (!defaultName?.trim()) throw invalid(`translations.${defaultLocale}.name`, "A name in the account's default language is required");
  if (input.code !== undefined && !CODE_RE.test(input.code)) throw invalid("code", "Use lowercase letters, digits, - and _");
  const n = { placesPerUnit: 1, minPerReservation: 1, maxPerReservation: 20, ...input };
  validateNumbers(n);
  if (n.defaultPrice === undefined) throw invalid("defaultPrice", "Give the offer a price");
  await assertUsableVatClass(tx, input.vatClassId);

  const id = newId();
  const code = input.code ?? (await uniqueCode(tx, eventId, codeFrom(defaultName)));
  await tx
    .insertInto("offers.offer")
    .values({
      id, tenant_id: ctx.tenantId, event_id: eventId, code, vat_class_id: input.vatClassId, sort_order: input.sortOrder ?? (await nextSortOrder(tx, eventId)),
      places_per_unit: n.placesPerUnit, min_per_reservation: n.minPerReservation, max_per_reservation: n.maxPerReservation, default_price: n.defaultPrice,
    })
    .execute()
    .catch(codeConflict);
  await writeTranslations(tx, ctx.tenantId, id, input.translations);
  return id;
}

async function nextSortOrder(tx: Tx, eventId: string): Promise<number> {
  const r = await tx.selectFrom("offers.offer").select(sql<number | null>`max(sort_order)`.as("m")).where("event_id", "=", eventId).executeTakeFirst();
  return r?.m === null || r?.m === undefined ? 0 : Math.min(r.m + 10, 10_000);
}

export async function createOffer(tx: Tx, ctx: ActorContext, eventId: string, input: OfferInput): Promise<OfferChangeResult> {
  assertCan(ctx, "offers.write");
  await writableEvent(tx, eventId);
  const account = await getAccount(tx);
  const id = await insertOffer(tx, ctx, eventId, input, account.locales, account.defaultLocale);
  const offer = await getOffer(tx, id);
  const resolution = await changed(tx, ctx, eventId, id, "created", true, { code: offer.code, defaultPrice: offer.defaultPrice });
  return { offer, resolution };
}

export async function updateOffer(tx: Tx, ctx: ActorContext, id: string, expectedVersion: number, patch: OfferPatch): Promise<OfferChangeResult> {
  assertCan(ctx, "offers.write");
  const found = await getOffer(tx, id);
  // An archived offer may be edited (and restored) after the event stopped selling tickets.
  await writableEvent(tx, found.eventId, false);
  const before = await getOffer(tx, id);
  if (before.version !== expectedVersion) throw new DomainError("version_conflict", "Offer was changed by someone else", { currentVersion: before.version });
  const account = await getAccount(tx);

  if (patch.translations) {
    for (const [locale, t] of Object.entries(patch.translations)) if (t) validateTranslation(locale, t, account.locales);
    if (patch.translations[account.defaultLocale] === null) throw invalid(`translations.${account.defaultLocale}`, "The default-language name cannot be removed");
  }
  if (patch.code !== undefined && !CODE_RE.test(patch.code)) throw invalid("code", "Use lowercase letters, digits, - and _");
  if (patch.status !== undefined && patch.status !== "active" && patch.status !== "archived") throw invalid("status", "active or archived");
  validateNumbers({
    ...patch,
    minPerReservation: patch.minPerReservation ?? before.minPerReservation,
    maxPerReservation: patch.maxPerReservation ?? before.maxPerReservation,
  });
  if (patch.vatClassId !== undefined && patch.vatClassId !== before.vatClassId) await assertUsableVatClass(tx, patch.vatClassId);

  const res = await tx
    .updateTable("offers.offer")
    .set({
      code: patch.code,
      vat_class_id: patch.vatClassId,
      sort_order: patch.sortOrder,
      status: patch.status,
      places_per_unit: patch.placesPerUnit,
      min_per_reservation: patch.minPerReservation,
      max_per_reservation: patch.maxPerReservation,
      default_price: patch.defaultPrice,
      version: sql<number>`version + 1`,
    })
    .where("id", "=", id)
    .where("version", "=", expectedVersion)
    .executeTakeFirst()
    .catch(codeConflict);
  if (!res.numUpdatedRows) throw new DomainError("version_conflict", "Offer was changed by someone else", { currentVersion: before.version });
  if (patch.translations) await writeTranslations(tx, ctx.tenantId, id, patch.translations);

  const offer = await getOffer(tx, id);
  const { translations: _t, ...rest } = patch;
  const diff = diffFields(before as unknown as Record<string, unknown>, rest as Record<string, unknown>);
  if (patch.translations) diff.translations = { from: before.translations, to: offer.translations };
  const resolution = await changed(tx, ctx, offer.eventId, id, "updated", "defaultPrice" in diff, { code: offer.code, ...diff });
  return { offer, resolution };
}

/**
 * Deletes an offer that no rule refers to. Its overrides and effective prices go with it.
 * Once tickets are sold (a later milestone) offers are archived instead.
 */
export async function deleteOffer(tx: Tx, ctx: ActorContext, id: string, expectedVersion: number): Promise<OfferChangeResult> {
  assertCan(ctx, "offers.write");
  const found = await getOffer(tx, id);
  await writableEvent(tx, found.eventId, false);
  const before = await getOffer(tx, id);
  if (before.version !== expectedVersion) throw new DomainError("version_conflict", "Offer was changed by someone else", { currentVersion: before.version });
  const rules = await tx
    .selectFrom("rules.rule_effect as e")
    .innerJoin("rules.rule as r", "r.id", "e.rule_id")
    .select(["r.id", "r.name"])
    .where("r.event_id", "=", before.eventId)
    .where("e.target_ref", "=", id)
    .distinct()
    .execute();
  if (rules.length) {
    throw new DomainError("conflict", `Rules set this offer's price or availability: ${rules.map((r) => r.name).join(", ")}. Remove those effects first`, { ruleIds: rules.map((r) => r.id) });
  }
  await tx.deleteFrom("offers.offer").where("id", "=", id).execute();
  await changed(tx, ctx, before.eventId, id, "deleted", false, { code: before.code });
  return { offer: null, resolution: "none" };
}

/**
 * Copies the active offers of another event: names, VAT class, limits and default prices
 * (docs/ticketing.md, decision 3). Offers whose code the event already has are skipped.
 */
export async function copyOffers(tx: Tx, ctx: ActorContext, eventId: string, fromEventId: string): Promise<{ created: Offer[]; skipped: string[]; resolution: OfferChangeResult["resolution"] }> {
  assertCan(ctx, "offers.write");
  if (fromEventId === eventId) throw invalid("fromEventId", "Pick another event");
  await writableEvent(tx, eventId);
  const source = await tx.selectFrom("catalog.event").select("id").where("id", "=", fromEventId).executeTakeFirst();
  if (!source) throw invalid("fromEventId", "Unknown event");
  const account = await getAccount(tx);
  const existing = new Set((await listOffers(tx, eventId)).map((o) => o.code));
  const created: string[] = [];
  const skipped: string[] = [];
  for (const o of (await listOffers(tx, fromEventId)).filter((x) => x.status === "active")) {
    if (existing.has(o.code)) {
      skipped.push(o.code);
      continue;
    }
    // Locales the account no longer has are left behind.
    const translations = Object.fromEntries(Object.entries(o.translations).filter(([l]) => account.locales.includes(l)));
    created.push(await insertOffer(tx, ctx, eventId, {
      code: o.code, vatClassId: o.vatClassId, sortOrder: o.sortOrder, placesPerUnit: o.placesPerUnit, minPerReservation: o.minPerReservation,
      maxPerReservation: o.maxPerReservation, defaultPrice: o.defaultPrice, translations,
    }, account.locales, account.defaultLocale));
  }
  let resolution: OfferChangeResult["resolution"] = "none";
  if (created.length) {
    resolution = await catalog.resolveEventSoon(tx, eventId);
    await recordAudit(tx, ctx, { action: "offer.copied", entityType: "event", entityId: eventId, diff: { fromEventId, offerIds: created, skipped } });
    for (const offerId of created) {
      await emit(tx, ctx.tenantId, { type: "offer.changed.v1", subject: `offer/${offerId}`, data: { id: offerId, eventId, change: "created", resolution } });
    }
  }
  const all = await listOffers(tx, eventId);
  return { created: all.filter((o) => created.includes(o.id)), skipped, resolution };
}
