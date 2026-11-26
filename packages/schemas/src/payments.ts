import { type Static, Type } from "typebox";
import { Nullable } from "./nullable.js";

// Admin API (/v1) schemas for payments (docs/checkout.md, ADR 0018): the account's own Vipps
// MobilePay merchant and the merchant details printed on receipts.

const DateTime = Type.String({ format: "date-time" });
const Uuid = Type.String({ format: "uuid" });

export const MerchantDetails = Type.Object(
  {
    legalName: Nullable(Type.String({ description: "The legal name on receipts" })),
    orgNumber: Nullable(Type.String({ description: "Norwegian organisation number, 9 digits" })),
    address: Nullable(Type.String()),
    vatRegistered: Type.Boolean({ description: "Registered for VAT: receipts show VAT per rate and MVA after the organisation number" }),
  },
  { description: "Printed on receipts from the hosted checkout" },
);

export const MerchantDetailsPatch = Type.Object(
  {
    legalName: Type.Optional(Nullable(Type.String({ maxLength: 200 }))),
    orgNumber: Type.Optional(Nullable(Type.String({ maxLength: 20 }))),
    address: Type.Optional(Nullable(Type.String({ maxLength: 500 }))),
    vatRegistered: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const Environment = Type.Union([Type.Literal("test"), Type.Literal("production")], { description: "test: the Vipps test environment (MT); production: real money" });

export const VippsConnection = Type.Object(
  {
    id: Uuid,
    provider: Type.Literal("vipps"),
    environment: Environment,
    merchantSerialNumber: Type.String(),
    clientId: Type.String(),
    status: Type.Union([Type.Literal("active"), Type.Literal("invalid"), Type.Literal("disconnected")], {
      description: "active: the keys work. invalid: Vipps refused them when last verified; enter new ones",
    }),
    statusReason: Nullable(Type.String()),
    webhookRegistered: Type.Boolean({ description: "Vipps tells the platform at once when a payment changes; without it, payments are checked by polling" }),
    verifiedAt: Nullable(DateTime),
    connectedAt: DateTime,
    version: Type.Integer(),
    updatedAt: DateTime,
  },
);

export const HostedCheckout = Type.Object(
  {
    channelId: Uuid,
    active: Type.Boolean({ description: "Deactivate it like any sales channel, under Sales channels" }),
  },
  { description: "The hosted checkout's sales channel. Put offers on sale on it, and give each VAT class a SKU there" },
);

export const PaymentsSettings = Type.Object({
  vipps: Nullable(VippsConnection),
  checkout: Nullable(HostedCheckout),
});

export const VippsConnect = Type.Object(
  {
    environment: Environment,
    merchantSerialNumber: Type.String({ pattern: "^[0-9]{4,10}$", description: "MSN, from the Vipps portal" }),
    clientId: Type.String({ minLength: 1, maxLength: 200 }),
    clientSecret: Type.String({ minLength: 1, maxLength: 500, writeOnly: true }),
    subscriptionKey: Type.String({ minLength: 1, maxLength: 500, writeOnly: true, description: "Ocp-Apim-Subscription-Key" }),
  },
  { additionalProperties: false },
);
export type VippsConnect = Static<typeof VippsConnect>;
