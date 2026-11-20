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
    "v1.<base64url HMAC-SHA256>. The key is the SHA-256 of the calling channel key's secret (the part of sk_<id>_<secret> after the second underscore); " +
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
  buyer: Nullable(Type.Object({ name: Nullable(Type.String()), email: Nullable(Type.String()), locale: Nullable(Type.String()) })),
  lines: Type.Array(ReservationLine),
  total: Type.Object({ amount: Type.Integer({ description: "Minor units, VAT included" }), currency: Type.String() }),
  tickets: Type.Array(Ticket, { description: "Once confirmed: one per unit, in line order" }),
  confirmedAt: Nullable(DateTime),
  cancelledAt: Nullable(DateTime),
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
