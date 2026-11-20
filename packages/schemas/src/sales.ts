import { Type } from "typebox";
import { Nullable } from "./nullable.js";

// Reservations API (/v1/reservations, docs/ticketing.md, milestone 3), called by a sales
// channel's connector with its channel key. Every write needs an Idempotency-Key.

const Uuid = Type.String({ format: "uuid" });
const DateTime = Type.String({ format: "date-time" });
const LocaleKey = Type.String({ pattern: "^[a-z]{2,3}(-[A-Z]{2})?$" });
const Ref = Type.String({ minLength: 1, maxLength: 200 });
const Signature = Nullable(Type.String({
  description:
    "v1.<base64url HMAC-SHA256>. The signed text's first element names its format (reservation_line.v2, reservation.v2). The key is the SHA-256 of the calling channel key's secret (the part of sk_<id>_<secret> after the second underscore); " +
    "the signed text is a JSON array of the fields in a fixed order (see the integration guide). Null when the caller is not a channel key",
}));

export const ReservationStatus = Type.Union([Type.Literal("held"), Type.Literal("confirmed"), Type.Literal("cancelled"), Type.Literal("expired")], {
  description: "held past expiresAt reads as expired. An expired reservation can still be confirmed while its places are free",
});

const Buyer = Type.Object(
  {
    name: Type.Optional(Nullable(Type.String({ maxLength: 200 }))),
    email: Type.Optional(Nullable(Type.String({ maxLength: 254 }))),
    locale: Type.Optional(Nullable(LocaleKey)),
  },
  { additionalProperties: false, description: "Optional, for the ticket page; personal data" },
);

export const ReservationLine = Type.Object({
  id: Uuid,
  lineNo: Type.Integer({ minimum: 1 }),
  occurrenceId: Uuid,
  offerId: Uuid,
  offerCode: Type.String(),
  quantity: Type.Integer({ minimum: 1 }),
  placesPerUnit: Type.Integer({ minimum: 1 }),
  unitPrice: Type.Integer({ description: "Minor units (øre), VAT included, frozen at reserve time" }),
  amount: Type.Integer({ description: "unitPrice × quantity" }),
  currency: Type.String({ description: "ISO 4217, e.g. NOK" }),
  vatClassCode: Type.String(),
  vatRatePct: Type.Number(),
  externalSku: Type.String({ description: "The channel's product for this line" }),
  name: Type.String({ description: "Line name for the receipt, e.g. \"Adult – Hamlet, Sat 13 Feb 19:30, Main stage\"" }),
  occurrenceStartUtc: DateTime,
  timezone: Type.String(),
  locationName: Nullable(Type.String()),
  group: Nullable(Type.String({ description: "The user group's code the line was sold under, frozen at reserve time" })),
  signature: Signature,
});

export const Ticket = Type.Object({
  id: Uuid,
  lineId: Uuid,
  occurrenceId: Uuid,
  offerId: Uuid,
  status: Type.Union([Type.Literal("valid"), Type.Literal("cancelled")]),
  admissionId: Uuid,
  partySize: Type.Integer({ description: "People the ticket admits: the offer's places per unit" }),
  cancelledAt: Nullable(DateTime),
  cancelledBy: Nullable(Type.Union([Type.Literal("channel"), Type.Literal("staff")], { description: "Who cancelled the ticket: the channel (a refund) or staff in the admin" })),
  externalRefundRef: Nullable(Type.String({ description: "The channel's refund reference given on cancel" })),
  url: Nullable(Type.String({ description: "The ticket page with its QR code; null once cancelled" })),
  qr: Nullable(Type.String({ description: "The QR code's payload (a signed admission token); null once cancelled" })),
});

export const Reservation = Type.Object({
  id: Uuid,
  channelId: Uuid,
  status: ReservationStatus,
  expiresAt: Type.String({ format: "date-time", description: "While held: when the places are released" }),
  extendLimitAt: Type.String({ format: "date-time", description: "The latest expiresAt that extend can reach" }),
  externalRef: Nullable(Type.String()),
  externalOrderRef: Nullable(Type.String()),
  locale: Type.String({ description: "Language of the line names" }),
  group: Nullable(Type.String({ description: "The buyer's user group (its code), as the connector gave it on reserve" })),
  buyer: Nullable(Type.Object({ name: Nullable(Type.String()), email: Nullable(Type.String()), locale: Nullable(Type.String()) })),
  lines: Type.Array(ReservationLine),
  total: Type.Object({ amount: Type.Integer({ description: "Minor units, VAT included" }), currency: Type.String() }),
  tickets: Type.Array(Ticket, { description: "Once confirmed: one per unit, in line order" }),
  confirmedAt: Nullable(DateTime),
  cancelledAt: Nullable(DateTime),
  anonymisedAt: Nullable(Type.String({ format: "date-time", description: "When retention removed the buyer, as for registrations; the lines and references stay" })),
  version: Type.Integer(),
  createdAt: DateTime,
  updatedAt: DateTime,
  signature: Signature,
});

export const ReservationCreate = Type.Object(
  {
    lines: Type.Array(
      Type.Object({ occurrenceId: Uuid, offerId: Uuid, quantity: Type.Integer({ minimum: 1, maximum: 1000 }) }, { additionalProperties: false }),
      { minItems: 1, maxItems: 50, description: "Each offer once per occurrence. Lines may span occurrences" },
    ),
    externalRef: Type.Optional(Nullable(Ref)),
    locale: Type.Optional(LocaleKey),
    confirm: Type.Optional(Type.Boolean({ description: "Confirm in the same call (a POS walk-up sale); needs externalOrderRef" })),
    externalOrderRef: Type.Optional(Ref),
    buyer: Type.Optional(Nullable(Buyer)),
    group: Type.Optional(Nullable(Type.String({
      pattern: "^[a-z0-9][a-z0-9_-]{0,62}$",
      description: "The buyer's user group, by code (docs/user-groups.md). The connector asserts it after its own sign-in; events and offers restricted to groups need it",
    }))),
  },
  { additionalProperties: false },
);

export const ReservationExtend = Type.Object(
  { minutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 60, description: "From now; default the channel's hold time. Capped at extendLimitAt" })) },
  { additionalProperties: false },
);

export const ReservationConfirm = Type.Object(
  { externalOrderRef: Ref, buyer: Type.Optional(Nullable(Buyer)) },
  { additionalProperties: false },
);

export const ReservationCancel = Type.Object(
  {
    ticketIds: Type.Optional(Type.Array(Uuid, {
      minItems: 1, maxItems: 1000, uniqueItems: true,
      description: "Confirmed reservations: the tickets to cancel. Left out: all valid tickets. Held reservations take no tickets",
    })),
    externalRefundRef: Type.Optional(Nullable(Type.String({ minLength: 1, maxLength: 200, description: "Confirmed reservations: the channel's refund, stored on each cancelled ticket" }))),
  },
  { additionalProperties: false },
);

// Staff: Occurrence → Sales (sales.read).

const Money = Type.Object({ amount: Type.Integer({ description: "Minor units, VAT included" }), currency: Type.String() });

export const OccurrenceSales = Type.Object({
  occurrenceId: Uuid,
  pool: Nullable(Type.Object({ bookableLimit: Nullable(Type.Integer()), taken: Type.Integer(), held: Type.Integer(), available: Nullable(Type.Integer()) })),
  currency: Type.String(),
  offers: Type.Array(Type.Object({
    offerId: Uuid,
    code: Type.String(),
    name: Type.String({ description: "In the account's default locale" }),
    held: Type.Integer({ description: "Units in held reservations that have not expired" }),
    sold: Type.Integer({ description: "Valid tickets" }),
    cancelled: Type.Integer(),
    places: Type.Integer({ description: "Places the valid tickets take" }),
    revenue: Type.Integer({ description: "Sum of the valid tickets' prices, minor units VAT included" }),
    byGroup: Type.Array(Type.Object({
      group: Nullable(Type.String({ description: "The user group's code; null: sold without a group" })),
      sold: Type.Integer(),
      revenue: Type.Integer(),
    }), { description: "Valid tickets and revenue per user group they were sold to; only groups that sold" }),
  }), { description: "The event's active offers, and archived ones that sold here, in display order" }),
  reservations: Type.Array(Type.Object({
    id: Uuid,
    channel: Type.Object({ id: Uuid, code: Type.String(), name: Type.String() }),
    status: ReservationStatus,
    externalRef: Nullable(Type.String()),
    externalOrderRef: Nullable(Type.String()),
    group: Nullable(Type.String({ description: "The buyer's user group (its code)" })),
    buyer: Nullable(Type.Object({ name: Nullable(Type.String()), email: Nullable(Type.String()), locale: Nullable(Type.String()) })),
    anonymisedAt: Nullable(DateTime),
    lines: Type.Array(Type.Object({
      id: Uuid, lineNo: Type.Integer(), offerId: Uuid, offerCode: Type.String(), name: Type.String(),
      quantity: Type.Integer(), unitPrice: Type.Integer(), amount: Type.Integer(),
    }), { description: "Lines at this occurrence" }),
    tickets: Type.Array(Type.Object({
      id: Uuid, lineId: Uuid, offerId: Uuid, status: Type.Union([Type.Literal("valid"), Type.Literal("cancelled")]), partySize: Type.Integer(),
      cancelledAt: Nullable(DateTime), cancelledBy: Nullable(Type.Union([Type.Literal("channel"), Type.Literal("staff")])), externalRefundRef: Nullable(Type.String()),
    }), { description: "Tickets at this occurrence" }),
    total: Money,
    otherOccurrences: Type.Boolean({ description: "The reservation also has lines at other occurrences" }),
    expiresAt: DateTime,
    confirmedAt: Nullable(DateTime),
    cancelledAt: Nullable(DateTime),
    createdAt: DateTime,
  }), { description: "Newest first, at most 2,000" }),
});
