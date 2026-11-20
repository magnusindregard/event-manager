import { type AccessPolicy, type AdmissionMode, type EventStatus, newId, sql, type Tx } from "@event-manager/db";
import { emit } from "../outbox/index.js";
import { type ActorContext, DomainError } from "../shared/index.js";
import { assertCan, diffFields, getAccount, isValidTimezone, recordAudit } from "../tenancy/index.js";
import { assertUsableGroups, writeEventAccess } from "./groups.js";
import { assertUsableLocation } from "./locations.js";
import { resolveEventSoon } from "./resolve.js";
import { assertUrl, invalid, notFound, pgCode, SLUG_RE, slugify, versionConflict } from "./shared.js";
import { assertUsableTags } from "./tags.js";

export interface Translation {
  title: string;
  shortDescription: string | null;
  imageUrl: string | null;
  imageAlt: string | null;
}

/** Registration settings (docs/registration.md); used when admissionMode is "registration". */
export interface RegistrationSettings {
  accessPolicy: AccessPolicy;
  /** Shown in public listings. Defaults to false for invite-only events. */
  listed: boolean;
  /** Default places per occurrence; rules and occurrence overrides can change it. Null: no limit. */
  capacity: number | null;
  overbookingPct: number;
  guestAllowed: boolean;
  /** Registration opens this many minutes before each occurrence starts; null: as soon as published. */
  opensMinBefore: number | null;
  /** Registration closes this many minutes before each occurrence starts. */
  closesMinBefore: number;
  waitlistEnabled: boolean;
  claimWindowMin: number;
  waitlistCutoffMin: number;
  /** Remind confirmed attendees this many minutes before each occurrence; null: no reminder. */
  reminderMinBefore: number | null;
}

export interface CatalogEvent {
  id: string;
  slug: string;
  status: EventStatus;
  timezone: string;
  defaultLocationId: string | null;
  defaultDurationMin: number;
  admissionMode: AdmissionMode;
  externalUrl: string | null;
  registration: RegistrationSettings;
  externalRefs: Record<string, string>;
  translations: Record<string, Translation>;
  tagIds: string[];
  /** User groups that may attend (docs/user-groups.md); empty: everyone. */
  accessGroupIds: string[];
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface EventSummary extends CatalogEvent {
  occurrenceCount: number;
  nextStartUtc: Date | null;
}

export interface EventInput {
  slug?: string;
  timezone?: string;
  defaultLocationId?: string | null;
  defaultDurationMin?: number;
  admissionMode?: AdmissionMode;
  externalUrl?: string | null;
  registration?: Partial<RegistrationSettings>;
  externalRefs?: Record<string, string>;
  translations: Record<string, Partial<Translation> & { title: string }>;
  tagIds?: string[];
  accessGroupIds?: string[];
}

export type EventPatch = Partial<Omit<EventInput, "translations">> & {
  /** Per locale: a translation replaces the stored one, null removes it. Locales left out are unchanged. */
  translations?: Record<string, (Partial<Translation> & { title: string }) | null>;
};

export type EventAction = "publish" | "unpublish" | "cancel" | "archive";

const eventColumns = [
  "id", "slug", "status", "timezone", "default_location_id", "default_duration_min", "admission_mode",
  "external_url", "external_refs", "version", "created_at", "updated_at",
  "access_policy", "listed", "capacity", "overbooking_pct", "guest_allowed", "registration_opens_min", "registration_closes_min",
  "waitlist_enabled", "claim_window_min", "waitlist_cutoff_min", "reminder_min_before",
] as const;
type EventRow = {
  id: string; slug: string; status: EventStatus; timezone: string; default_location_id: string | null;
  default_duration_min: number; admission_mode: AdmissionMode; external_url: string | null;
  external_refs: Record<string, string>; version: number; created_at: Date; updated_at: Date;
  access_policy: AccessPolicy; listed: boolean; capacity: number | null; overbooking_pct: number; guest_allowed: boolean;
  registration_opens_min: number | null; registration_closes_min: number; waitlist_enabled: boolean; claim_window_min: number; waitlist_cutoff_min: number;
  reminder_min_before: number | null;
};

const toSettings = (r: EventRow): RegistrationSettings => ({
  accessPolicy: r.access_policy,
  listed: r.listed,
  capacity: r.capacity,
  overbookingPct: r.overbooking_pct,
  guestAllowed: r.guest_allowed,
  opensMinBefore: r.registration_opens_min,
  closesMinBefore: r.registration_closes_min,
  waitlistEnabled: r.waitlist_enabled,
  claimWindowMin: r.claim_window_min,
  waitlistCutoffMin: r.waitlist_cutoff_min,
  reminderMinBefore: r.reminder_min_before,
});

const settingsColumns = (s: Partial<RegistrationSettings>) => ({
  access_policy: s.accessPolicy,
  listed: s.listed,
  capacity: s.capacity,
  overbooking_pct: s.overbookingPct,
  guest_allowed: s.guestAllowed,
  registration_opens_min: s.opensMinBefore,
  registration_closes_min: s.closesMinBefore,
  waitlist_enabled: s.waitlistEnabled,
  claim_window_min: s.claimWindowMin,
  waitlist_cutoff_min: s.waitlistCutoffMin,
  reminder_min_before: s.reminderMinBefore,
});

const intRange = (field: string, v: number | null | undefined, min: number, max: number, nullable = false) => {
  if (v === undefined || (v === null && nullable)) return;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw invalid(`registration.${field}`, `Must be a whole number, ${min}–${max}`);
};

/** Validates the merged settings. */
function validateSettings(s: RegistrationSettings) {
  intRange("capacity", s.capacity, 0, 1_000_000, true);
  intRange("overbookingPct", s.overbookingPct, 0, 100);
  intRange("opensMinBefore", s.opensMinBefore, 0, 525_600, true);
  intRange("closesMinBefore", s.closesMinBefore, 0, 525_600);
  intRange("claimWindowMin", s.claimWindowMin, 5, 20_160);
  intRange("waitlistCutoffMin", s.waitlistCutoffMin, 0, 20_160);
  intRange("reminderMinBefore", s.reminderMinBefore, 60, 20_160, true);
  if (s.opensMinBefore !== null && s.opensMinBefore <= s.closesMinBefore) {
    throw invalid("registration.opensMinBefore", "Registration must open before it closes");
  }
}

/** Merges a settings patch. Switching to invite-only hides the event from listings unless listed is given. */
function mergeSettings(before: RegistrationSettings, patch: Partial<RegistrationSettings>): RegistrationSettings {
  const out = { ...before, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as RegistrationSettings;
  if (patch.accessPolicy === "invite_only" && before.accessPolicy !== "invite_only" && patch.listed === undefined) out.listed = false;
  return out;
}

const DEFAULT_SETTINGS: RegistrationSettings = {
  accessPolicy: "open", listed: true, capacity: null, overbookingPct: 0, guestAllowed: false,
  opensMinBefore: null, closesMinBefore: 0, waitlistEnabled: false, claimWindowMin: 1440, waitlistCutoffMin: 120,
  reminderMinBefore: null,
};

async function hydrate(tx: Tx, rows: EventRow[]): Promise<CatalogEvent[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [translations, tags, access] = await Promise.all([
    tx.selectFrom("catalog.event_translation").selectAll().where("event_id", "in", ids).execute(),
    tx.selectFrom("catalog.event_tag").select(["event_id", "tag_id"]).where("event_id", "in", ids).execute(),
    tx.selectFrom("catalog.event_access_group").select(["event_id", "group_id"]).where("event_id", "in", ids).execute(),
  ]);
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    status: r.status,
    timezone: r.timezone,
    defaultLocationId: r.default_location_id,
    defaultDurationMin: r.default_duration_min,
    admissionMode: r.admission_mode,
    externalUrl: r.external_url,
    registration: toSettings(r),
    externalRefs: r.external_refs,
    translations: Object.fromEntries(
      translations
        .filter((t) => t.event_id === r.id)
        .map((t) => [t.locale, { title: t.title, shortDescription: t.short_description, imageUrl: t.image_url, imageAlt: t.image_alt }]),
    ),
    tagIds: tags.filter((t) => t.event_id === r.id).map((t) => t.tag_id).sort(),
    accessGroupIds: access.filter((a) => a.event_id === r.id).map((a) => a.group_id).sort(),
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export async function getEvent(tx: Tx, id: string): Promise<CatalogEvent> {
  const row = await tx.selectFrom("catalog.event").select(eventColumns).where("id", "=", id).executeTakeFirst();
  if (!row) throw notFound("Event");
  return (await hydrate(tx, [row]))[0]!;
}

export interface EventFilter {
  q?: string;
  status?: EventStatus[];
  tagId?: string;
  locationId?: string;
  from?: Date;
  to?: Date;
  /** Keyset cursor: id of the last event on the previous page (newest first). */
  before?: string;
  limit: number;
}

export async function listEvents(tx: Tx, f: EventFilter): Promise<EventSummary[]> {
  let q = tx
    .selectFrom("catalog.event as e")
    .select(eventColumns.map((c) => `e.${c}` as const))
    .select((eb) => [
      eb.selectFrom("catalog.occurrence as o").whereRef("o.event_id", "=", "e.id").select(sql<number>`count(*)::int`.as("n")).as("occurrence_count"),
      eb
        .selectFrom("catalog.occurrence as o")
        .whereRef("o.event_id", "=", "e.id")
        .where("o.start_utc", ">=", sql<Date>`now()`)
        .where("o.status", "=", "scheduled")
        .select(sql<Date>`min(o.start_utc)`.as("s"))
        .as("next_start_utc"),
    ])
    .orderBy("e.id", "desc")
    .limit(f.limit);
  if (f.status?.length) q = q.where("e.status", "in", f.status);
  if (f.before) q = q.where("e.id", "<", f.before);
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    q = q.where((eb) =>
      eb.or([
        eb("e.slug", "ilike", like),
        eb.exists(eb.selectFrom("catalog.event_translation as t").whereRef("t.event_id", "=", "e.id").where("t.title", "ilike", like).select("t.locale")),
      ]),
    );
  }
  if (f.tagId) {
    const tagId = f.tagId;
    q = q.where((eb) => eb.exists(eb.selectFrom("catalog.event_tag as et").whereRef("et.event_id", "=", "e.id").where("et.tag_id", "=", tagId).select("et.tag_id")));
  }
  if (f.locationId) {
    const loc = f.locationId;
    q = q.where((eb) =>
      eb.or([
        eb("e.default_location_id", "=", loc),
        eb.exists(eb.selectFrom("catalog.occurrence as o").whereRef("o.event_id", "=", "e.id").where("o.location_override_id", "=", loc).select("o.id")),
      ]),
    );
  }
  if (f.from || f.to) {
    const { from, to } = f;
    q = q.where((eb) => {
      let sub = eb.selectFrom("catalog.occurrence as o").whereRef("o.event_id", "=", "e.id").select("o.id");
      if (from) sub = sub.where("o.end_utc", ">", from);
      if (to) sub = sub.where("o.start_utc", "<", to);
      return eb.exists(sub);
    });
  }
  const rows = await q.execute();
  const events = await hydrate(tx, rows as unknown as EventRow[]);
  return events.map((e, i) => ({
    ...e,
    occurrenceCount: (rows[i] as unknown as { occurrence_count: number }).occurrence_count ?? 0,
    nextStartUtc: (rows[i] as unknown as { next_start_utc: Date | null }).next_start_utc ?? null,
  }));
}

function validateTranslation(locale: string, t: Partial<Translation> & { title: string }, locales: string[]) {
  if (!locales.includes(locale)) throw invalid(`translations.${locale}`, `Locale ${locale} is not enabled for the account`);
  if (!t.title?.trim()) throw invalid(`translations.${locale}.title`, "Title is required");
  assertUrl(`translations.${locale}.imageUrl`, t.imageUrl);
}

async function writeTranslations(tx: Tx, tenantId: string, eventId: string, translations: Record<string, (Partial<Translation> & { title: string }) | null>) {
  for (const [locale, t] of Object.entries(translations)) {
    if (t === null) {
      await tx.deleteFrom("catalog.event_translation").where("event_id", "=", eventId).where("locale", "=", locale).execute();
      continue;
    }
    const values = { title: t.title.trim(), short_description: t.shortDescription ?? null, image_url: t.imageUrl ?? null, image_alt: t.imageAlt ?? null };
    await tx
      .insertInto("catalog.event_translation")
      .values({ tenant_id: tenantId, event_id: eventId, locale, ...values })
      .onConflict((oc) => oc.columns(["event_id", "locale"]).doUpdateSet(values))
      .execute();
  }
}

async function writeTags(tx: Tx, tenantId: string, eventId: string, tagIds: string[]) {
  await tx.deleteFrom("catalog.event_tag").where("event_id", "=", eventId).execute();
  const unique = [...new Set(tagIds)];
  if (unique.length) await tx.insertInto("catalog.event_tag").values(unique.map((tag_id) => ({ tenant_id: tenantId, event_id: eventId, tag_id }))).execute();
}

function validateAdmission(mode: AdmissionMode, url: string | null) {
  assertUrl("externalUrl", url);
  if (mode === "external" && !url) throw invalid("externalUrl", "External admission needs a link");
}

function validateRefs(refs: Record<string, string> | undefined) {
  if (!refs) return;
  for (const [k, v] of Object.entries(refs)) {
    if (!/^[a-z0-9][a-z0-9_.-]{0,62}$/i.test(k) || typeof v !== "string" || v.length > 500) throw invalid("externalRefs", "Keys are short identifiers, values are strings");
  }
}

async function uniqueSlug(tx: Tx, base: string): Promise<string> {
  const taken = new Set(
    (await tx.selectFrom("catalog.event").select("slug").where((eb) => eb.or([eb("slug", "=", base), eb("slug", "like", `${base}-%`)])).execute()).map((r) => r.slug),
  );
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

function slugConflict(e: unknown): never {
  if (pgCode(e) === "23505") throw new DomainError("conflict", "Another event uses this slug", { field: "slug" });
  throw e;
}

export async function createEvent(tx: Tx, ctx: ActorContext, input: EventInput): Promise<CatalogEvent> {
  assertCan(ctx, "content.write");
  const account = await getAccount(tx);
  const translations = input.translations ?? {};
  for (const [locale, t] of Object.entries(translations)) validateTranslation(locale, t, account.locales);
  const defaultTitle = translations[account.defaultLocale]?.title;
  if (!defaultTitle) throw invalid(`translations.${account.defaultLocale}.title`, "A title in the account's default language is required");

  const timezone = input.timezone ?? account.defaultTimezone;
  if (!isValidTimezone(timezone)) throw invalid("timezone", "Unknown IANA timezone");
  if (input.slug !== undefined && !SLUG_RE.test(input.slug)) throw invalid("slug", "Use lowercase letters, digits and single hyphens");
  if (input.defaultLocationId) await assertUsableLocation(tx, input.defaultLocationId, "defaultLocationId");
  const admissionMode = input.admissionMode ?? (input.externalUrl ? "external" : "none");
  validateAdmission(admissionMode, input.externalUrl ?? null);
  const settings = mergeSettings({ ...DEFAULT_SETTINGS, accessPolicy: "open" }, input.registration ?? {});
  validateSettings(settings);
  validateRefs(input.externalRefs);
  if (input.tagIds) await assertUsableTags(tx, input.tagIds, "tagIds");
  const accessGroupIds = await assertUsableGroups(tx, input.accessGroupIds ?? []);

  const id = newId();
  const slug = input.slug ?? (await uniqueSlug(tx, slugify(defaultTitle)));
  await tx
    .insertInto("catalog.event")
    .values({
      id,
      tenant_id: ctx.tenantId,
      slug,
      timezone,
      default_location_id: input.defaultLocationId ?? null,
      default_duration_min: input.defaultDurationMin,
      admission_mode: admissionMode,
      external_url: input.externalUrl ?? null,
      external_refs: JSON.stringify(input.externalRefs ?? {}),
      ...settingsColumns(settings),
    })
    .execute()
    .catch(slugConflict);
  await writeTranslations(tx, ctx.tenantId, id, translations);
  if (input.tagIds) await writeTags(tx, ctx.tenantId, id, input.tagIds);
  if (accessGroupIds.length) await writeEventAccess(tx, ctx.tenantId, id, accessGroupIds);

  const event = await getEvent(tx, id);
  await recordAudit(tx, ctx, { action: "event.created", entityType: "event", entityId: id, diff: { slug, title: defaultTitle } });
  await emit(tx, ctx.tenantId, { type: "event.changed.v1", subject: `event/${id}`, data: { id, change: "created" } });
  return event;
}

const DEFAULT_FIELDS = ["defaultLocationId", "admissionMode", "externalUrl", "tagIds", "registration.capacity", "registration.overbookingPct"] as const;

export async function updateEvent(tx: Tx, ctx: ActorContext, id: string, expectedVersion: number, patch: EventPatch): Promise<CatalogEvent> {
  assertCan(ctx, "content.write");
  const before = await getEvent(tx, id);
  const account = await getAccount(tx);

  if (patch.translations) {
    for (const [locale, t] of Object.entries(patch.translations)) if (t) validateTranslation(locale, t, account.locales);
    if (patch.translations[account.defaultLocale] === null) {
      throw invalid(`translations.${account.defaultLocale}`, "The default-language translation cannot be removed");
    }
  }
  if (patch.timezone !== undefined && !isValidTimezone(patch.timezone)) throw invalid("timezone", "Unknown IANA timezone");
  if (patch.slug !== undefined && !SLUG_RE.test(patch.slug)) throw invalid("slug", "Use lowercase letters, digits and single hyphens");
  if (patch.defaultLocationId && patch.defaultLocationId !== before.defaultLocationId) {
    await assertUsableLocation(tx, patch.defaultLocationId, "defaultLocationId");
  }
  const admissionMode = patch.admissionMode ?? before.admissionMode;
  const externalUrl = patch.externalUrl !== undefined ? patch.externalUrl : before.externalUrl;
  validateAdmission(admissionMode, externalUrl);
  const settings = patch.registration ? mergeSettings(before.registration, patch.registration) : undefined;
  if (settings) validateSettings(settings);
  validateRefs(patch.externalRefs);
  if (patch.tagIds) {
    const added = patch.tagIds.filter((t) => !before.tagIds.includes(t));
    await assertUsableTags(tx, added, "tagIds");
  }
  // Groups already on the list may stay there after they are archived.
  const accessGroupIds = patch.accessGroupIds ? await assertUsableGroups(tx, patch.accessGroupIds, before.accessGroupIds) : undefined;

  const res = await tx
    .updateTable("catalog.event")
    .set({
      slug: patch.slug,
      timezone: patch.timezone,
      default_location_id: patch.defaultLocationId,
      default_duration_min: patch.defaultDurationMin,
      admission_mode: patch.admissionMode,
      external_url: patch.externalUrl,
      ...(patch.externalRefs ? { external_refs: JSON.stringify(patch.externalRefs) } : {}),
      ...(settings ? settingsColumns(settings) : {}),
      version: sql<number>`version + 1`,
    })
    .where("id", "=", id)
    .where("version", "=", expectedVersion)
    .executeTakeFirst()
    .catch(slugConflict);
  if (!res.numUpdatedRows) throw versionConflict("Event", before.version);
  if (patch.translations) await writeTranslations(tx, ctx.tenantId, id, patch.translations);
  if (patch.tagIds) await writeTags(tx, ctx.tenantId, id, patch.tagIds);
  if (accessGroupIds) await writeEventAccess(tx, ctx.tenantId, id, accessGroupIds);

  const after = await getEvent(tx, id);
  const { registration: _r, accessGroupIds: _a, ...rest } = patch;
  const diff = diffFields(before as unknown as Record<string, unknown>, rest as Record<string, unknown>);
  if (settings) {
    for (const [k, v] of Object.entries(diffFields(before.registration as unknown as Record<string, unknown>, settings as unknown as Record<string, unknown>))) {
      diff[`registration.${k}`] = v;
    }
  }
  if (accessGroupIds && JSON.stringify(accessGroupIds) !== JSON.stringify(before.accessGroupIds)) {
    diff.accessGroupIds = { from: before.accessGroupIds, to: accessGroupIds };
  }
  // Rules match on local time, so a timezone change can change which rules apply.
  const resolution = DEFAULT_FIELDS.some((f) => f in diff) || "timezone" in diff ? await resolveEventSoon(tx, id) : undefined;
  await recordAudit(tx, ctx, { action: "event.updated", entityType: "event", entityId: id, diff });
  await emit(tx, ctx.tenantId, {
    type: "event.changed.v1", subject: `event/${id}`,
    data: { id, eventId: id, change: "updated", changed: Object.keys(diff), ...(resolution ? { resolution } : {}) },
  });
  return after;
}

const transitions: Record<EventAction, { from: EventStatus[]; to: EventStatus; type: string }> = {
  publish: { from: ["draft", "cancelled"], to: "published", type: "event.published.v1" },
  unpublish: { from: ["published"], to: "draft", type: "event.changed.v1" },
  cancel: { from: ["draft", "published"], to: "cancelled", type: "event.cancelled.v1" },
  archive: { from: ["draft", "published", "cancelled"], to: "archived", type: "event.changed.v1" },
};

/** Status changes: publish, unpublish, cancel, archive. Only published and cancelled events are public. */
export async function transitionEvent(tx: Tx, ctx: ActorContext, id: string, expectedVersion: number, action: EventAction): Promise<CatalogEvent> {
  assertCan(ctx, "content.write");
  const before = await getEvent(tx, id);
  const t = transitions[action];
  if (!t.from.includes(before.status)) {
    throw new DomainError("conflict", `Cannot ${action} an event that is ${before.status}`, { status: before.status });
  }
  const res = await tx
    .updateTable("catalog.event")
    .set({ status: t.to, version: sql<number>`version + 1` })
    .where("id", "=", id)
    .where("version", "=", expectedVersion)
    .executeTakeFirst();
  if (!res.numUpdatedRows) throw versionConflict("Event", before.version);
  await recordAudit(tx, ctx, { action: `event.${action === "publish" ? "published" : action === "unpublish" ? "unpublished" : action === "cancel" ? "cancelled" : "archived"}`, entityType: "event", entityId: id, diff: { status: { from: before.status, to: t.to } } });
  await emit(tx, ctx.tenantId, { type: t.type, subject: `event/${id}`, data: { id, status: t.to, previousStatus: before.status } });
  return getEvent(tx, id);
}
