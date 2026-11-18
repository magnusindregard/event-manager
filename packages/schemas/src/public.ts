import { Type } from "typebox";
import { Nullable } from "./nullable.js";

// Public read API (/public/v1) response shapes. Additive changes only: new fields and new
// admission modes may appear; existing fields keep their meaning (ADR 0007).

const Uuid = Type.String({ format: "uuid" });
const DateTime = Type.String({ format: "date-time" });
const Geo = Type.Object({ lat: Type.Number(), lng: Type.Number() });

export const PublicTag = Type.Object({ id: Uuid, key: Type.String(), vocabulary: Type.String(), label: Type.String() });

export const PublicLocationRef = Type.Object({
  id: Uuid,
  name: Type.String(),
  kind: Type.Union([Type.Literal("venue"), Type.Literal("space")]),
  venue: Nullable(Type.Object({ id: Uuid, name: Type.String() })),
});

export const Admission = Type.Union(
  [
    Type.Object({ mode: Type.Literal("external"), url: Type.String({ description: "Ticket or booking link" }) }),
    Type.Object({ mode: Type.Literal("none") }),
    Type.Object({
      mode: Type.Literal("registration"),
      url: Nullable(Type.String({ description: "Hosted registration page. Null for invite-only occurrences: guests register through their personal invitation links" })),
    }),
  ],
  { description: "How to get in. More modes (registration, tickets) are added later without changing these." },
);

export const Availability = Type.Object(
  {
    status: Type.Union([Type.Literal("available"), Type.Literal("few_left"), Type.Literal("full"), Type.Literal("closed")], {
      description: "closed: registration has not opened, has closed, or the occurrence is cancelled. New statuses (waitlist) may be added",
    }),
    opensAt: Nullable(Type.String({ format: "date-time", description: "Null: open as soon as the event is published" })),
    closesAt: DateTime,
  },
  { description: "Places for registration occurrences, without exact numbers. Null for other admission modes" },
);

const eventSummaryFields = {
  id: Uuid,
  slug: Type.String(),
  status: Type.Union([Type.Literal("published"), Type.Literal("cancelled"), Type.Literal("draft")], { description: "draft only with a preview token" }),
  locale: Type.String({ description: "Locale of title and description (falls back to the account default)" }),
  title: Type.String(),
  shortDescription: Nullable(Type.String()),
  image: Nullable(Type.Object({ url: Type.String(), alt: Nullable(Type.String()) })),
  timezone: Type.String({ description: "IANA timezone for displaying times" }),
  externalRefs: Type.Record(Type.String(), Type.String()),
};
export const PublicEventSummary = Type.Object(eventSummaryFields);

const occurrenceFields = {
  id: Uuid,
  startUtc: DateTime,
  endUtc: DateTime,
  timezone: Type.String(),
  status: Type.Union([Type.Literal("scheduled"), Type.Literal("cancelled")]),
  location: Nullable(PublicLocationRef),
  tags: Type.Array(PublicTag),
  admission: Admission,
  availability: Nullable(Availability),
};

export const PublicOccurrence = Type.Object({ ...occurrenceFields, event: PublicEventSummary });
export const PublicEventOccurrence = Type.Object(occurrenceFields);

export const PublicOccurrencePage = Type.Object({ locale: Type.String(), items: Type.Array(PublicOccurrence), nextCursor: Nullable(Type.String()) });
export const PublicEventListItem = Type.Object({ ...eventSummaryFields, tags: Type.Array(PublicTag) });
export const PublicEventPage = Type.Object({ locale: Type.String(), items: Type.Array(PublicEventListItem), nextCursor: Nullable(Type.String()) });
export const PublicEventDetail = Type.Object({
  locale: Type.String(),
  event: Type.Object({ ...eventSummaryFields, tags: Type.Array(PublicTag), occurrences: Type.Array(PublicEventOccurrence) }),
});

const Space = Type.Object({ id: Uuid, name: Type.String(), address: Nullable(Type.String()), geo: Nullable(Geo) });
export const PublicVenue = Type.Object({ ...Space.properties, spaces: Type.Array(Space) });
export const PublicLocations = Type.Object({ items: Type.Array(PublicVenue) });
