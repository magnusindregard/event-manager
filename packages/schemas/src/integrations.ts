import { type Static, Type } from "typebox";

// Admin API (/v1) schemas for the account's integrations (docs/hubspot.md, ADR 0017).

const DateTime = Type.String({ format: "date-time" });
const Nullable = <T extends Parameters<typeof Type.Union>[0][number]>(t: T) => Type.Union([t, Type.Null()]);

export const IntegrationSettings = Type.Object({
  syncInvitedGuests: Type.Boolean({ description: "Upsert invited guests as HubSpot contacts" }),
  syncOpenAttendees: Type.Boolean({ description: "Upsert attendees of open registration as HubSpot contacts" }),
});

export const Integration = Type.Object({
  id: Type.String({ format: "uuid" }),
  provider: Type.Literal("hubspot"),
  status: Type.Union([Type.Literal("active"), Type.Literal("needs_reconnect"), Type.Literal("disconnected")], {
    description: "needs_reconnect: HubSpot refused our access (app uninstalled, access revoked); sync is paused until an owner connects again",
  }),
  statusReason: Nullable(Type.String()),
  portalId: Type.String({ description: "The HubSpot portal (hub) id" }),
  scopes: Type.Array(Type.String(), { description: "Scopes granted on install" }),
  features: Type.Object({
    customEvents: Type.Boolean({ description: "Custom behavioural events can be sent (Marketing Hub Enterprise)" }),
  }),
  settings: IntegrationSettings,
  setup: Type.Object(
    {
      status: Type.Union([Type.Literal("pending"), Type.Literal("done"), Type.Literal("failed")]),
      error: Nullable(Type.String()),
      at: Nullable(DateTime),
    },
    { description: "The property group and guest key property in the portal" },
  ),
  connectedAt: DateTime,
  disconnectedAt: Nullable(DateTime),
  version: Type.Integer(),
  updatedAt: DateTime,
});
export type Integration = Static<typeof Integration>;

export const IntegrationList = Type.Object({
  items: Type.Array(Integration),
  available: Type.Object({ hubspot: Type.Boolean({ description: "The platform has a HubSpot app configured" }) }),
});

export const HubSpotAuthorize = Type.Object({ url: Type.String({ description: "HubSpot's install page; send the browser there" }) });

export const HubSpotCallback = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 2000 }),
    state: Type.String({ minLength: 1, maxLength: 2000 }),
  },
  { additionalProperties: false },
);

export const IntegrationSettingsPatch = Type.Object(
  { syncInvitedGuests: Type.Optional(Type.Boolean()), syncOpenAttendees: Type.Optional(Type.Boolean()) },
  { additionalProperties: false, minProperties: 1 },
);
