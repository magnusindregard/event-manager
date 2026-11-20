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
    Type.Object({ mode: Type.Literal("tickets") }, { description: "Tickets are sold through the account's own web shop and box office; offers lists what is for sale" }),
  ],
  { description: "How to get in. More modes (registration, tickets) are added later without changing these." },
);

export const Availability = Type.Object(
  {
    status: Type.Union([Type.Literal("available"), Type.Literal("few_left"), Type.Literal("full"), Type.Literal("waitlist"), Type.Literal("closed")], {
      description: "waitlist: full, but registering joins the waitlist. closed: registration has not opened, has closed, or the occurrence is cancelled. New statuses may be added",
    }),
    opensAt: Nullable(Type.String({ format: "date-time", description: "Null: open as soon as the event is published" })),
    closesAt: DateTime,
  },
  { description: "Places for registration occurrences, without exact numbers. Null for other admission modes" },
);

// The public API's availability: the registration shape, plus ticket statuses and exact places
// left for channel keys. One object rather than a union, so the response stays additive (ADR 0007);
// the attendee API keeps Availability.
export const PublicAvailability = Type.Object(
  {
    status: Type.Union(
      [
        Type.Literal("available"), Type.Literal("few_left"), Type.Literal("full"), Type.Literal("waitlist"), Type.Literal("closed"),
        Type.Literal("sold_out"), Type.Literal("not_on_sale"),
      ],
      {
        description:
          "Registration: waitlist: full, but registering joins the waitlist. closed: registration has not opened, has closed, or the occurrence is cancelled. " +
          "Tickets: sold_out: no on-sale offer's smallest purchase fits in the places left (held places count as gone). not_on_sale: no offer is on sale now. New statuses may be added",
      },
    ),
    opensAt: Nullable(Type.String({ format: "date-time", description: "Null: open as soon as the event is published. Tickets: the earliest sales window opening of the offers" })),
    closesAt: Type.String({ format: "date-time", description: "Tickets: the latest sales window closing of the offers" }),
    placesLeft: Type.Optional(Nullable(Type.Integer({ description: "Ticketed occurrences with a channel key only: places left; null without a limit" }))),
  },
  {
    description:
      "Registration and ticketed occurrences: places without exact numbers; channel keys also get exact places left for ticketed occurrences (docs/ticketing.md). Null otherwise",
  },
);

export const PublicOffer = Type.Object(
  {
    id: Uuid,
    code: Type.String({ description: "Stable offer code, e.g. adult" }),
    name: Type.String(),
    description: Nullable(Type.String()),
    price: Type.Object({
      amount: Type.Integer({ description: "Minor units (øre), VAT included" }),
      currency: Type.String({ description: "ISO 4217, e.g. NOK" }),
      vatIncluded: Type.Literal(true),
    }),
    onSale: Type.Boolean({ description: "False when the occurrence is cancelled or outside the sales window. Channel keys: also when the channel has no SKU for the offer" }),
    opensAt: Nullable(Type.String({ format: "date-time", description: "Sales window here. Null: on sale as soon as the event is published" })),
    closesAt: Type.String({ format: "date-time", description: "End of the sales window, at the start at the latest" }),
    sku: Type.Optional(Nullable(Type.String({ description: "Channel keys only: the channel's product for this offer; null: none mapped, so not on sale" }))),
    placesPerUnit: Type.Optional(Type.Integer({ description: "Channel keys only" })),
    minPerReservation: Type.Optional(Type.Integer({ description: "Channel keys only" })),
    maxPerReservation: Type.Optional(Type.Integer({ description: "Channel keys only" })),
  },
  { description: "A ticket type at this occurrence, in display order. Offers taken off sale here are left out" },
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
  availability: Nullable(PublicAvailability),
  offers: Type.Array(PublicOffer, { description: "Ticketed occurrences only; empty otherwise" }),
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
