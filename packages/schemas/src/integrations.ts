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
    { description: "The setup job in the portal: for now, a check that our token reaches the connected portal" },
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

const SyncKind = Type.Union([Type.Literal("contact"), Type.Literal("marketing_event"), Type.Literal("attendance"), Type.Literal("segment"), Type.Literal("segment_member")]);
const SyncCounts = Type.Object({
  synced: Type.Integer({ description: "In HubSpot and up to date" }),
  pending: Type.Integer({ description: "Waiting to be pushed, including items being retried after a refusal" }),
  failed: Type.Integer({ description: "Refused five times; waits for a retry or a change" }),
});

export const IntegrationSync = Type.Object({
  counts: Type.Object({ contact: SyncCounts, marketing_event: SyncCounts, attendance: SyncCounts, segment: SyncCounts, segment_member: SyncCounts }),
  lastSyncedAt: Nullable(DateTime),
  lastReconcile: Nullable(
    Type.Object(
      {
        at: DateTime,
        segments: Type.Integer({ description: "Segments checked" }),
        added: Type.Integer({ description: "Members HubSpot was missing, added back" }),
        removed: Type.Integer({ description: "Contacts that should not be in a segment, removed (failed updates, hand edits)" }),
        recreated: Type.Integer({ description: "Segments deleted in HubSpot, made again" }),
        failed: Type.Integer({ description: "Segments HubSpot refused to read or change" }),
      },
      { description: "The last nightly check of the segments against HubSpot" },
    ),
  ),
  issues: Type.Array(
    Type.Object({
      kind: SyncKind,
      label: Type.String({ description: "The contact's email, the event, or both" }),
      email: Nullable(Type.String()),
      eventTitle: Nullable(Type.String()),
      startUtc: Nullable(DateTime),
      attempts: Type.Integer(),
      givenUp: Type.Boolean({ description: "No longer retried by itself" }),
      lastError: Type.String({ description: "What HubSpot answered" }),
      updatedAt: DateTime,
    }),
    { description: "Items HubSpot refused, latest first (at most 50)" },
  ),
});
export type IntegrationSync = Static<typeof IntegrationSync>;

export const IntegrationSyncRetry = Type.Object({ retried: Type.Integer({ description: "Items queued to be tried again" }) });
