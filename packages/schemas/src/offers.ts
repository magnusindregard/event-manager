import { type Static, Type } from "typebox";
import { Nullable } from "./nullable.js";

// Admin API (/v1) schemas for ticketing milestone 1 (docs/ticketing.md): VAT classes, offers,
// overrides per (offer, occurrence) and the price grid.

const Uuid = Type.String({ format: "uuid" });
const DateTime = Type.String({ format: "date-time" });
const Code = Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{0,62}$" });
const LocaleKey = Type.String({ pattern: "^[a-z]{2,3}(-[A-Z]{2})?$" });
const Amount = Type.Integer({ minimum: 0, maximum: 100000000, description: "Minor units (øre), VAT included" });
const ValueSource = Type.Union([Type.Literal("default"), Type.Literal("rule"), Type.Literal("override")]);

export const VatClass = Type.Object({
  id: Uuid,
  code: Type.String(),
  label: Type.String(),
  ratePct: Type.Number({ description: "VAT rate in percent, up to two decimals" }),
  archived: Type.Boolean(),
  inUse: Type.Boolean({ description: "Offers use the class, so its rate cannot change" }),
  version: Type.Integer(),
  updatedAt: DateTime,
});
export type VatClass = Static<typeof VatClass>;

const Rate = Type.Number({ minimum: 0, maximum: 100, description: "Percent, at most two decimals" });
export const VatClassCreate = Type.Object({ code: Code, label: Type.String({ minLength: 1, maxLength: 200 }), ratePct: Rate }, { additionalProperties: false });
export const VatClassPatch = Type.Object(
  { label: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), ratePct: Type.Optional(Rate), archived: Type.Optional(Type.Boolean()) },
  { additionalProperties: false, minProperties: 1 },
);

export const OfferStatus = Type.Union([Type.Literal("active"), Type.Literal("archived")]);
const OfferTranslation = Type.Object({ name: Type.String({ minLength: 1, maxLength: 200 }), description: Type.Optional(Nullable(Type.String({ maxLength: 2000 }))) });
const OfferTranslationOut = Type.Object({ name: Type.String(), description: Nullable(Type.String()) });

export const Offer = Type.Object({
  id: Uuid,
  eventId: Uuid,
  code: Type.String({ description: "Stable within the event, for connectors" }),
  vatClassId: Uuid,
  sortOrder: Type.Integer(),
  status: OfferStatus,
  placesPerUnit: Type.Integer({ description: "Places one unit takes; a family ticket takes 4 and admits a party of 4" }),
  minPerReservation: Type.Integer(),
  maxPerReservation: Type.Integer(),
  defaultPrice: Amount,
  translations: Type.Record(Type.String(), OfferTranslationOut),
  version: Type.Integer(),
  createdAt: DateTime,
  updatedAt: DateTime,
});
export type Offer = Static<typeof Offer>;

const offerFields = {
  code: Type.Optional(Code),
  vatClassId: Uuid,
  sortOrder: Type.Optional(Type.Integer({ minimum: -10000, maximum: 10000 })),
  placesPerUnit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 1 })),
  minPerReservation: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, default: 1 })),
  maxPerReservation: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, default: 20 })),
  defaultPrice: Amount,
};
export const OfferCreate = Type.Object(
  { ...offerFields, translations: Type.Record(LocaleKey, OfferTranslation, { minProperties: 1 }) },
  { additionalProperties: false },
);
export const OfferPatch = Type.Object(
  {
    code: offerFields.code,
    vatClassId: Type.Optional(Uuid),
    sortOrder: offerFields.sortOrder,
    status: Type.Optional(OfferStatus),
    placesPerUnit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    minPerReservation: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    maxPerReservation: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    defaultPrice: Type.Optional(Amount),
    translations: Type.Optional(Type.Record(LocaleKey, Nullable(OfferTranslation), { description: "Per locale: replaces the translation, or null removes it" })),
  },
  { additionalProperties: false, minProperties: 1 },
);

const Resolution = Type.Union([Type.Literal("done"), Type.Literal("queued"), Type.Literal("none")], {
  description: "done: effective prices are updated. queued: the worker updates them within seconds. none: no prices change.",
});
export const OfferChangeResult = Type.Object({ offer: Nullable(Offer), resolution: Resolution }, { description: "offer is null after a delete" });
export const OfferCopy = Type.Object({ fromEventId: Uuid }, { additionalProperties: false });
export const OfferCopyResult = Type.Object({
  created: Type.Array(Offer),
  skipped: Type.Array(Type.String(), { description: "Codes the event already had" }),
  resolution: Resolution,
});

export const OfferOverride = Type.Object({
  amount: Nullable(Type.Integer({ description: "Minor units, VAT included; null inherits" })),
  available: Nullable(Type.Boolean({ description: "false: off sale here; null inherits" })),
});
export const OfferOverrideInput = Type.Object(
  {
    amount: Type.Optional(Nullable(Type.Integer({ minimum: 0, maximum: 100000000, description: "Minor units, VAT included. null inherits; left out keeps the stored value" }))),
    available: Type.Optional(Nullable(Type.Boolean({ description: "false takes the offer off sale here. null inherits; left out keeps the stored value" }))),
  },
  { additionalProperties: false, minProperties: 1 },
);

export const PriceCell = Type.Object({
  offerId: Uuid,
  price: Type.Object({ value: Type.Integer(), source: ValueSource, ruleId: Nullable(Type.String({ format: "uuid" })) }),
  available: Type.Object({ value: Type.Boolean(), source: ValueSource, ruleId: Nullable(Type.String({ format: "uuid" })) }),
  override: Nullable(OfferOverride),
}, { description: "One offer at one occurrence: effective price and availability with their source" });

export const PriceRow = Type.Object({
  occurrenceId: Uuid,
  startUtc: DateTime,
  endUtc: DateTime,
  status: Type.Union([Type.Literal("scheduled"), Type.Literal("cancelled")]),
  cells: Type.Array(PriceCell, { description: "Per offer; an offer whose prices are not resolved yet is missing" }),
});

export const PriceGrid = Type.Object({
  offers: Type.Array(Offer),
  items: Type.Array(PriceRow),
  nextCursor: Nullable(Type.String()),
});
