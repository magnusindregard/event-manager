import { type Static, Type } from "typebox";
import { Nullable } from "./nullable.js";

// Admin API (/v1) schemas for ticketing (docs/ticketing.md): VAT classes, offers, overrides per
// (offer, occurrence) and the price grid (milestone 1); sales channels, channel keys, the SKU
// mapping and sales windows (milestone 2).

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
  onSaleMinBefore: Nullable(Type.Integer({ description: "On sale this many minutes before each occurrence's start" })),
  onSaleAt: Nullable(Type.String({ format: "date-time", description: "On sale from this time. Neither this nor onSaleMinBefore: on sale once the event is published" })),
  offSaleMinBefore: Nullable(Type.Integer({ description: "Off sale this many minutes before each occurrence's start" })),
  offSaleAt: Nullable(Type.String({ format: "date-time", description: "Off sale from this time. Neither this nor offSaleMinBefore: until the start. Sales never run past the start" })),
  channelIds: Type.Array(Uuid, { description: "Sales channels that may sell the offer" }),
  channelsWithoutSku: Type.Array(Uuid, { description: "Of channelIds: where the offer's VAT class has no SKU, so it cannot be sold there yet" }),
  accessGroupIds: Type.Array(Uuid, { description: "User groups that may buy the offer; empty: everyone the event admits" }),
  groupPrices: Type.Array(Type.Object({ groupId: Uuid, amount: Amount }), { description: "The offer's own prices per user group; groups not listed pay the general price" }),
  translations: Type.Record(Type.String(), OfferTranslationOut),
  version: Type.Integer(),
  createdAt: DateTime,
  updatedAt: DateTime,
});
export type Offer = Static<typeof Offer>;

const Minutes = Type.Integer({ minimum: 0, maximum: 525600 });
const windowFields = {
  onSaleMinBefore: Type.Optional(Nullable(Minutes)),
  onSaleAt: Type.Optional(Nullable(DateTime)),
  offSaleMinBefore: Type.Optional(Nullable(Minutes)),
  offSaleAt: Type.Optional(Nullable(DateTime)),
};
const ChannelIds = Type.Array(Uuid, { uniqueItems: true, maxItems: 50 });
const GroupPrices = Type.Array(Type.Object({ groupId: Uuid, amount: Amount }, { additionalProperties: false }), {
  maxItems: 50, description: "The offer's own price per user group; groups not listed pay the general price. Replaces the list",
});
const AccessGroupIds = Type.Array(Uuid, { uniqueItems: true, maxItems: 50, description: "Only these user groups may buy the offer; empty: everyone the event admits. Replaces the list" });

const offerFields = {
  code: Type.Optional(Code),
  vatClassId: Uuid,
  sortOrder: Type.Optional(Type.Integer({ minimum: -10000, maximum: 10000 })),
  placesPerUnit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 1 })),
  minPerReservation: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, default: 1 })),
  maxPerReservation: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, default: 20 })),
  defaultPrice: Amount,
  ...windowFields,
  accessGroupIds: Type.Optional(AccessGroupIds),
  groupPrices: Type.Optional(GroupPrices),
};
export const OfferCreate = Type.Object(
  { ...offerFields, channelIds: Type.Optional(Type.Array(Uuid, { ...ChannelIds, description: "Left out: every active channel" })), translations: Type.Record(LocaleKey, OfferTranslation, { minProperties: 1 }) },
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
    ...windowFields,
    channelIds: Type.Optional(Type.Array(Uuid, { ...ChannelIds, description: "Replaces the offer's channels" })),
    accessGroupIds: Type.Optional(AccessGroupIds),
    groupPrices: Type.Optional(GroupPrices),
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

export const GroupCell = Type.Object({
  groupId: Uuid,
  price: Type.Object({ value: Type.Integer(), source: ValueSource, ruleId: Nullable(Type.String({ format: "uuid" })) }, {
    description: "What the group pays here. Sources: override (a group override), rule (a rule's group effect), default (the offer's group price); when inherited, the general price and its source",
  }),
  inherited: Type.Boolean({ description: "No group setting applies here, so the group pays the general price" }),
  override: Nullable(Type.Integer({ description: "The group override here, if any" })),
}, { description: "With groupId: what that user group pays (docs/user-groups.md)" });
export const GroupOverrideInput = Type.Object(
  { amount: Type.Integer({ minimum: 0, maximum: 100000000, description: "Minor units, VAT included" }) },
  { additionalProperties: false },
);

export const PriceCell = Type.Object({
  offerId: Uuid,
  price: Type.Object({ value: Type.Integer(), source: ValueSource, ruleId: Nullable(Type.String({ format: "uuid" })) }),
  available: Type.Object({ value: Type.Boolean(), source: ValueSource, ruleId: Nullable(Type.String({ format: "uuid" })) }),
  override: Nullable(OfferOverride),
  group: Type.Optional(GroupCell),
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

// ── Sales channels, keys and SKUs (milestone 2) ────────────────────────────────
const ChannelKind = Type.Union([Type.Literal("ecom"), Type.Literal("pos")]);
export const SalesChannel = Type.Object({
  id: Uuid,
  code: Type.String({ description: "Stable, e.g. web or pos" }),
  name: Type.String(),
  kind: ChannelKind,
  holdMinutes: Type.Integer({ description: "How long a reservation holds its places; extend brings it to at most 60 minutes in total" }),
  sendTickets: Type.Boolean({ description: "The platform emails the tickets on confirm when a buyer email is given" }),
  active: Type.Boolean({ description: "Inactive channels' keys stop working and their offers are off sale there" }),
  version: Type.Integer(),
  createdAt: DateTime,
  updatedAt: DateTime,
});
const HoldMinutes = Type.Integer({ minimum: 1, maximum: 60 });
const ChannelName = Type.String({ minLength: 1, maxLength: 200 });
export const SalesChannelCreate = Type.Object(
  { code: Code, name: ChannelName, kind: ChannelKind, holdMinutes: Type.Optional(HoldMinutes), sendTickets: Type.Optional(Type.Boolean()) },
  { additionalProperties: false },
);
export const SalesChannelPatch = Type.Object(
  { name: Type.Optional(ChannelName), holdMinutes: Type.Optional(HoldMinutes), sendTickets: Type.Optional(Type.Boolean()), active: Type.Optional(Type.Boolean()) },
  { additionalProperties: false, minProperties: 1 },
);

export const ChannelKey = Type.Object({ id: Uuid, channelId: Uuid, prefix: Type.String(), label: Type.String(), createdAt: DateTime, revokedAt: Nullable(DateTime) });
export const ChannelKeyCreate = Type.Object({ label: Type.String({ minLength: 1, maxLength: 100 }) }, { additionalProperties: false });
export const ChannelKeyCreated = Type.Object({
  ...ChannelKey.properties,
  secret: Type.String({ description: "The full key (sk_…), for the channel's connector. Server-side only. Shown once; only a hash is stored." }),
});

export const SkuMapping = Type.Object({ vatClassId: Uuid, channelId: Uuid, externalSku: Type.String({ description: "The shop's product for a ticket line" }), updatedAt: DateTime });
export const SkuMappingInput = Type.Object({ externalSku: Type.String({ minLength: 1, maxLength: 100 }) }, { additionalProperties: false });
