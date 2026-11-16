import { type Static, Type } from "typebox";

// Admin API (/v1) schemas for the catalog: locations, tags, events, occurrences, API keys.

const Uuid = Type.String({ format: "uuid" });
const DateTime = Type.String({ format: "date-time" });
const Nullable = <T extends Parameters<typeof Type.Union>[0][number]>(t: T) => Type.Union([t, Type.Null()]);
const HttpUrl = Type.String({ pattern: "^https?://\\S+$", maxLength: 2000 });
const Labels = Type.Record(Type.String({ pattern: "^[a-z]{2,3}(-[A-Z]{2})?$" }), Type.String({ maxLength: 200 }), {
  description: "Display labels per locale",
});
const Key = Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{0,62}$" });

export const Geo = Type.Object({ lat: Type.Number({ minimum: -90, maximum: 90 }), lng: Type.Number({ minimum: -180, maximum: 180 }) });

export const LocationKind = Type.Union([Type.Literal("venue"), Type.Literal("space")]);

export const Location = Type.Object({
  id: Uuid,
  kind: LocationKind,
  parentId: Nullable(Uuid),
  name: Type.String(),
  address: Nullable(Type.String()),
  geo: Nullable(Geo),
  archived: Type.Boolean(),
  version: Type.Integer(),
  updatedAt: DateTime,
});
export type Location = Static<typeof Location>;

export const LocationCreate = Type.Object(
  {
    kind: LocationKind,
    parentId: Type.Optional(Nullable(Uuid)),
    name: Type.String({ minLength: 1, maxLength: 200 }),
    address: Type.Optional(Nullable(Type.String({ maxLength: 500 }))),
    geo: Type.Optional(Nullable(Geo)),
  },
  { additionalProperties: false },
);

export const LocationPatch = Type.Object(
  {
    parentId: Type.Optional(Nullable(Uuid)),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    address: Type.Optional(Nullable(Type.String({ maxLength: 500 }))),
    geo: Type.Optional(Nullable(Geo)),
    archived: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false, minProperties: 1 },
);

export const Tag = Type.Object({ id: Uuid, vocabularyId: Uuid, key: Type.String(), labels: Labels, archived: Type.Boolean(), version: Type.Integer() });
export const TagVocabulary = Type.Object({ id: Uuid, key: Type.String(), labels: Labels, version: Type.Integer(), tags: Type.Array(Tag) });
export const TagVocabularyCreate = Type.Object({ key: Key, labels: Labels }, { additionalProperties: false });
export const TagVocabularyPatch = Type.Object({ labels: Labels }, { additionalProperties: false });
export const TagCreate = Type.Object({ key: Key, labels: Labels }, { additionalProperties: false });
export const TagPatch = Type.Object(
  { labels: Type.Optional(Labels), archived: Type.Optional(Type.Boolean()) },
  { additionalProperties: false, minProperties: 1 },
);

export const EventStatus = Type.Union([Type.Literal("draft"), Type.Literal("published"), Type.Literal("cancelled"), Type.Literal("archived")]);
export const AdmissionMode = Type.Union([Type.Literal("none"), Type.Literal("external")]);

export const Translation = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 300 }),
  shortDescription: Type.Optional(Nullable(Type.String({ maxLength: 2000 }))),
  imageUrl: Type.Optional(Nullable(HttpUrl)),
  imageAlt: Type.Optional(Nullable(Type.String({ maxLength: 500 }))),
});
const TranslationOut = Type.Object({ title: Type.String(), shortDescription: Nullable(Type.String()), imageUrl: Nullable(Type.String()), imageAlt: Nullable(Type.String()) });
const LocaleKey = Type.String({ pattern: "^[a-z]{2,3}(-[A-Z]{2})?$" });
const ExternalRefs = Type.Record(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$" }), Type.String({ maxLength: 500 }), {
  description: "Links to documents in other systems, e.g. { \"sanity\": \"event-123\" }",
});
const Slug = Type.String({ pattern: "^[a-z0-9]+(-[a-z0-9]+)*$", maxLength: 120 });

export const Event = Type.Object({
  id: Uuid,
  slug: Type.String(),
  status: EventStatus,
  timezone: Type.String(),
  defaultLocationId: Nullable(Uuid),
  defaultDurationMin: Type.Integer(),
  admissionMode: AdmissionMode,
  externalUrl: Nullable(Type.String()),
  externalRefs: Type.Record(Type.String(), Type.String()),
  translations: Type.Record(Type.String(), TranslationOut),
  tagIds: Type.Array(Uuid),
  version: Type.Integer(),
  createdAt: DateTime,
  updatedAt: DateTime,
});
export type Event = Static<typeof Event>;

export const EventSummary = Type.Object({ ...Event.properties, occurrenceCount: Type.Integer(), nextStartUtc: Nullable(DateTime) });

const eventFields = {
  slug: Type.Optional(Slug),
  timezone: Type.Optional(Type.String({ minLength: 1, description: "IANA timezone; defaults to the account's" })),
  defaultLocationId: Type.Optional(Nullable(Uuid)),
  defaultDurationMin: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000 })),
  admissionMode: Type.Optional(AdmissionMode),
  externalUrl: Type.Optional(Nullable(HttpUrl)),
  externalRefs: Type.Optional(ExternalRefs),
  tagIds: Type.Optional(Type.Array(Uuid, { uniqueItems: true, maxItems: 100 })),
};

export const EventCreate = Type.Object(
  { ...eventFields, translations: Type.Record(LocaleKey, Translation, { minProperties: 1 }) },
  { additionalProperties: false },
);

export const EventPatch = Type.Object(
  {
    ...eventFields,
    translations: Type.Optional(
      Type.Record(LocaleKey, Nullable(Translation), { description: "Per locale: replaces the translation, or null removes it" }),
    ),
  },
  { additionalProperties: false, minProperties: 1 },
);

export const EventAction = Type.Union([Type.Literal("publish"), Type.Literal("unpublish"), Type.Literal("cancel"), Type.Literal("archive")]);

export const ValueSource = Type.Union([Type.Literal("default"), Type.Literal("rule"), Type.Literal("override")]);
const resolved = <T extends Parameters<typeof Type.Union>[0][number]>(value: T) =>
  Type.Object({ value, source: ValueSource, ruleId: Nullable(Uuid) });

export const OccurrenceStatus = Type.Union([Type.Literal("scheduled"), Type.Literal("cancelled")]);

export const Occurrence = Type.Object({
  id: Uuid,
  eventId: Uuid,
  seriesId: Nullable(Uuid),
  recurrenceIdLocal: Nullable(Type.String({ description: "The occurrence's slot in its series, as local time (iCalendar RECURRENCE-ID)" })),
  startUtc: DateTime,
  endUtc: DateTime,
  status: OccurrenceStatus,
  detached: Type.Boolean({ description: "Edited by hand; the series no longer moves it" }),
  conflict: Type.Boolean({ description: "Detached, and a series change has since moved or removed its slot" }),
  overrides: Type.Object({ locationId: Nullable(Uuid), externalUrl: Nullable(Type.String()), tagIds: Nullable(Type.Array(Uuid)) }),
  effective: Type.Object({
    location: Type.Optional(resolved(Nullable(Uuid))),
    tags: Type.Optional(resolved(Type.Array(Uuid))),
    externalUrl: Type.Optional(resolved(Nullable(Type.String()))),
  }, { description: "Resolved values with their source (default, rule or override)" }),
  version: Type.Integer(),
  updatedAt: DateTime,
});
export type Occurrence = Static<typeof Occurrence>;

const overrideFields = {
  locationOverrideId: Type.Optional(Nullable(Uuid)),
  externalUrlOverride: Type.Optional(Nullable(HttpUrl)),
  tagsOverride: Type.Optional(Nullable(Type.Array(Uuid, { uniqueItems: true, maxItems: 100 }))),
};

export const OccurrenceCreate = Type.Object(
  { startUtc: DateTime, endUtc: Type.Optional(DateTime), ...overrideFields },
  { additionalProperties: false },
);

export const OccurrencePatch = Type.Object(
  {
    startUtc: Type.Optional(DateTime), endUtc: Type.Optional(DateTime), status: Type.Optional(OccurrenceStatus), ...overrideFields,
    conflict: Type.Optional(Type.Literal(false, { description: "Dismiss a series conflict and keep the occurrence as it is" })),
  },
  { additionalProperties: false, minProperties: 1 },
);

// ── Series (milestone 3) ─────────────────────────────────────────────────────
export const LocalDateTime = Type.String({
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2})?$",
  description: "Local wall time in the series' timezone, no offset",
  examples: ["2027-01-04T14:00"],
});
const Rrule = Type.String({
  minLength: 6, maxLength: 1000,
  description: "RFC 5545 RRULE without DTSTART, e.g. FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=24. UNTIL is local time.",
  examples: ["FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=24"],
});

export const Series = Type.Object({
  id: Uuid,
  eventId: Uuid,
  rrule: Type.String(),
  dtstartLocal: Type.String(),
  durationMin: Type.Integer(),
  timezone: Type.String(),
  exdates: Type.Array(Type.String(), { description: "Slots removed from the series, as local starts" }),
  generatedUntil: Type.String({ format: "date-time", description: "Occurrences exist up to here; open-ended series are extended nightly" }),
  complete: Type.Boolean({ description: "Every occurrence of the rule is generated" }),
  version: Type.Integer(),
  createdAt: DateTime,
  updatedAt: DateTime,
});
export type Series = Static<typeof Series>;

const seriesFields = {
  rrule: Rrule,
  dtstartLocal: LocalDateTime,
  durationMin: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000, description: "Defaults to the event's default duration" })),
  timezone: Type.Optional(Type.String({ minLength: 1, description: "IANA timezone; defaults to the event's" })),
};
export const SeriesCreate = Type.Object(seriesFields, { additionalProperties: false });
export const SeriesPatch = Type.Object(
  { rrule: Type.Optional(Rrule), dtstartLocal: Type.Optional(LocalDateTime), durationMin: seriesFields.durationMin, timezone: seriesFields.timezone },
  { additionalProperties: false, minProperties: 1 },
);
export const SeriesSplit = Type.Object(
  { at: Type.String({ ...LocalDateTime, description: "The slot (recurrenceIdLocal) the new series starts at" }), ...SeriesPatch.properties },
  { additionalProperties: false },
);

const SlotSummary = Type.Object({
  occurrenceId: Nullable(Uuid),
  recurrenceIdLocal: Nullable(Type.String()),
  startUtc: DateTime,
  endUtc: DateTime,
});
export const SeriesChanges = Type.Object(
  {
    counts: Type.Object({ created: Type.Integer(), moved: Type.Integer(), deleted: Type.Integer(), conflicts: Type.Integer(), unchanged: Type.Integer() }),
    created: Type.Array(SlotSummary),
    moved: Type.Array(Type.Object({ ...SlotSummary.properties, fromStartUtc: DateTime, fromEndUtc: DateTime })),
    deleted: Type.Array(SlotSummary),
    conflicts: Type.Array(Type.Object({ ...SlotSummary.properties, reason: Type.Union([Type.Literal("moved"), Type.Literal("removed")]) })),
  },
  { description: "What the change does to occurrences. Lists hold at most 200 items; counts are exact." },
);
export const SeriesChangeResult = Type.Object({
  series: Nullable(Series),
  changes: SeriesChanges,
}, { description: "series is null in the preview of a series that does not exist yet" });

export const ApiKeyKind = Type.Union([Type.Literal("publishable"), Type.Literal("preview")]);
export const ApiKey = Type.Object({ id: Uuid, kind: ApiKeyKind, prefix: Type.String(), label: Type.String(), createdAt: DateTime, revokedAt: Nullable(DateTime) });
export const ApiKeyCreate = Type.Object({ kind: ApiKeyKind, label: Type.String({ minLength: 1, maxLength: 100 }) }, { additionalProperties: false });
export const ApiKeyCreated = Type.Object({ ...ApiKey.properties, secret: Type.String({ description: "The full key. Shown once; only a hash is stored." }) });
