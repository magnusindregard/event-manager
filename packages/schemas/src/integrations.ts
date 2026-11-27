import { type Static, Type } from "typebox";

// Admin API (/v1) schemas for the account's integrations (docs/hubspot.md, ADR 0017).

const DateTime = Type.String({ format: "date-time" });
const Nullable = <T extends Parameters<typeof Type.Union>[0][number]>(t: T) => Type.Union([t, Type.Null()]);

export const IntegrationSettings = Type.Object({
  syncInvitedGuests: Type.Boolean({ description: "Upsert invited guests as HubSpot contacts" }),
  syncOpenAttendees: Type.Boolean({ description: "Upsert attendees of open registration as HubSpot contacts" }),
  eventSubscriptionTypeId: Nullable(Type.String({ description: "The subscription type the platform's HubSpot emails use; temporary contacts are unsubscribed from every other" })),
  cleanupGraceDays: Type.Integer({ minimum: 0, maximum: 90, description: "Days after a contact's last occurrence before the cleanup takes back what the platform did" }),
  deleteMirroredContacts: Type.Boolean({ description: "Delete contacts the platform created only for mirroring, once no event needs them" }),
  invitationTemplateId: Nullable(Type.String({ description: "The default single-send template email for invitations" })),
  reminderTemplateId: Nullable(Type.String({ description: "The default single-send template email for reminders to guests who have not answered" })),
  welcomeTemplateId: Nullable(Type.String({ description: "The default single-send template email for the welcome before the event" })),
});

export const SingleSendTemplate = Type.Object({
  id: Type.String(),
  name: Type.String(),
  subscriptionId: Nullable(Type.String({ description: "The template's subscription type; it should be the type for event emails" })),
  hasInvitationLink: Type.Boolean({ description: "The content has [[em:invitation_link]]" }),
  hasManageLink: Type.Boolean({ description: "The content has [[em:manage_link]] (for the welcome)" }),
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
    sending: Type.Boolean({ description: "Events can send their invitations, reminders and welcome through HubSpot" }),
  }),
  sending: Type.Object(
    {
      blocker: Nullable(Type.String({ description: "Why events cannot send through HubSpot yet; null when they can" })),
      templates: Type.Array(SingleSendTemplate, { description: "The portal's emails saved for the single-send API, as the setup last read them" }),
      eventTypeUsedBy: Type.Array(Type.Object({ id: Type.String(), name: Type.String() }), { description: "The client's own emails that use the subscription type for event emails, which only the platform's should" }),
      testPortal: Type.Boolean({ description: "The portal is a HubSpot sandbox or developer test account, which sends marketing email only to the portal's own users; HubSpot refuses other guests (VALIDATION_FAILED) and the platform sends to them" }),
    },
    { description: "HubSpot sending (docs/hubspot.md)" },
  ),
  settings: IntegrationSettings,
  cleanup: Type.Object(
    {
      missingScopes: Type.Array(Type.String(), { description: "Cleanup scopes a portal admin has not allowed; HubSpot sending needs all of them" }),
      subscriptionTypes: Type.Array(Type.Object({ id: Type.String(), name: Type.String(), active: Type.Boolean() }), { description: "The portal's subscription types, as the setup last read them" }),
      workflowEnabled: Nullable(Type.Boolean({ description: "Whether the workflow EM · Set to non-marketing was there and on when last checked; null: not set up" })),
      nonMarketingWaiting: Nullable(Type.Integer({ description: "Contacts left in EM · Set to non-marketing from an earlier night: the workflow is not taking them" })),
      disconnectRequestedAt: Nullable(Type.String({ format: "date-time", description: "Clean up and disconnect is running" })),
    },
    { description: "Cleanup after HubSpot sending (docs/hubspot.md)" },
  ),
  setup: Type.Object(
    {
      status: Type.Union([Type.Literal("pending"), Type.Literal("done"), Type.Literal("failed")]),
      error: Nullable(Type.String()),
      at: Nullable(DateTime),
    },
    { description: "The setup job in the portal: a check that our token reaches the connected portal, and the cleanup segments and workflow" },
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
  {
    syncInvitedGuests: Type.Optional(Type.Boolean()),
    syncOpenAttendees: Type.Optional(Type.Boolean()),
    eventSubscriptionTypeId: Type.Optional(Nullable(Type.String({ minLength: 1, maxLength: 40 }))),
    cleanupGraceDays: Type.Optional(Type.Integer({ minimum: 0, maximum: 90 })),
    deleteMirroredContacts: Type.Optional(Type.Boolean()),
    invitationTemplateId: Type.Optional(Nullable(Type.String({ minLength: 1, maxLength: 40 }))),
    reminderTemplateId: Type.Optional(Nullable(Type.String({ minLength: 1, maxLength: 40 }))),
    welcomeTemplateId: Type.Optional(Nullable(Type.String({ minLength: 1, maxLength: 40 }))),
  },
  { additionalProperties: false, minProperties: 1 },
);

const EmailKind = Type.Union([Type.Literal("invitation"), Type.Literal("reminder"), Type.Literal("welcome")]);
const EmailTexts = Type.Object({ subject: Type.String(), previewText: Type.String() });
const PerKind = <T extends Parameters<typeof Type.Optional>[0]>(t: T) => Type.Object({ invitation: t, reminder: t, welcome: t });

export const EventSending = Type.Object({
  eventId: Type.String({ format: "uuid" }),
  channel: Type.Union([Type.Literal("platform"), Type.Literal("hubspot")], { description: "Who sends the invitations, reminders and welcome. Everything else always comes from the platform" }),
  templates: Type.Object({ invitation: Type.Optional(Type.String()), reminder: Type.Optional(Type.String()), welcome: Type.Optional(Type.String()) }, { description: "The event's own choice of template per kind" }),
  effectiveTemplates: PerKind(Nullable(Type.String())),
  texts: PerKind(EmailTexts),
  customTexts: Type.Array(EmailKind, { description: "Kinds whose subject and preview text were set by staff; the others are made from the event" }),
  marketingCheck: Nullable(
    Type.Object(
      {
        checkedAt: DateTime,
        guests: Type.Integer({ description: "Guests HubSpot would send to: not declined, no plus address" }),
        marketing: Type.Integer({ description: "Already marketing contacts" }),
        wouldBecome: Type.Integer({ description: "Not marketing contacts yet: a HubSpot send makes them ones, billed for at least this period" }),
        plusAddresses: Type.Integer({ description: "Addresses with a +, which HubSpot refuses: the platform sends to them" }),
        error: Type.Optional(Type.String()),
      },
      { description: "What the last check of the event's guests in HubSpot found" },
    ),
  ),
  locked: Type.Boolean({ description: "An invitation has been sent: the channel can no longer change" }),
  emails: Type.Array(
    Type.Object({
      kind: EmailKind,
      templateId: Type.String(),
      remoteId: Nullable(Type.String({ description: "The email's id in HubSpot" })),
      url: Nullable(Type.String({ description: "The email in HubSpot, for design changes" })),
      name: Nullable(Type.String()),
      subject: Nullable(Type.String()),
      previewText: Nullable(Type.String()),
      status: Type.Union([Type.Literal("pending"), Type.Literal("ready"), Type.Literal("failed")]),
      error: Nullable(Type.String()),
      warnings: Type.Array(Type.String()),
      firstSentAt: Nullable(DateTime),
    }),
    { description: "The event's own emails in HubSpot" },
  ),
  hubspotBlocker: Nullable(Type.String({ description: "Why HubSpot cannot be chosen; null when it can" })),
  version: Type.Integer({ description: "0 until first saved" }),
});
export type EventSending = Static<typeof EventSending>;

const TextsPatch = Nullable(Type.Object({ subject: Type.String({ minLength: 1, maxLength: 200 }), previewText: Type.Optional(Type.String({ maxLength: 300 })) }, { additionalProperties: false }));
const TemplatePatch = Nullable(Type.String({ minLength: 1, maxLength: 40 }));
export const EventSendingPatch = Type.Object(
  {
    channel: Type.Optional(Type.Union([Type.Literal("platform"), Type.Literal("hubspot")])),
    templates: Type.Optional(Type.Object({ invitation: Type.Optional(TemplatePatch), reminder: Type.Optional(TemplatePatch), welcome: Type.Optional(TemplatePatch) }, { additionalProperties: false })),
    texts: Type.Optional(Type.Object({ invitation: Type.Optional(TextsPatch), reminder: Type.Optional(TextsPatch), welcome: Type.Optional(TextsPatch) }, { additionalProperties: false })),
  },
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
  cleanup: Type.Object(
    {
      pending: Type.Integer({ description: "Contacts the cleanup will take back once no event needs them" }),
      kept: Type.Integer({ description: "Contacts the platform created that the client has taken into use, left as theirs" }),
      failed: Type.Integer({ description: "Contacts HubSpot refused part of the cleanup for; tried again nightly" }),
      last: Nullable(
        Type.Object({
          at: DateTime,
          deleted: Type.Integer(),
          restored: Type.Integer({ description: "Set back to non-marketing, subscriptions put back" }),
          kept: Type.Integer(),
          failed: Type.Integer(),
          waiting: Type.Integer({ description: "Still needed by an event" }),
          newTypesCovered: Type.Integer({ description: "Temporary contacts unsubscribed from subscription types made since" }),
          error: Type.Optional(Type.String()),
        }),
      ),
    },
    { description: "Cleanup after HubSpot sending" },
  ),
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

export const HubSpotListList = Type.Object({
  items: Type.Array(Type.Object({
    listId: Type.String(),
    name: Type.String(),
    processingType: Type.String({ description: "MANUAL: a static list; DYNAMIC: an active one, whose members are read as they are when fetched" }),
    size: Nullable(Type.Integer()),
  })),
});

export const GuestListSource = Type.Object({
  provider: Type.Literal("hubspot"),
  listId: Type.String(),
  listName: Type.String(),
  status: Type.Union([Type.Literal("fetching"), Type.Literal("ready"), Type.Literal("failed")], { description: "ready: importId is staged for mapping, preview and commit" }),
  importId: Nullable(Type.String({ format: "uuid", description: "The staged import from the last fetch; null once committed, discarded or expired" })),
  error: Nullable(Type.String()),
  memberCount: Nullable(Type.Integer()),
  requestedAt: DateTime,
  fetchedAt: Nullable(DateTime),
}, { description: "The HubSpot list the event's guest list comes from (docs/hubspot.md, milestone 6)" });

export const GuestListSourceBody = Type.Object({ source: Nullable(GuestListSource) });

export const GuestListRequest = Type.Object(
  { listId: Type.String({ pattern: "^[0-9]{1,20}$" }), listName: Type.String({ minLength: 1, maxLength: 300 }) },
  { additionalProperties: false },
);
