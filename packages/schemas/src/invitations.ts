import { Type } from "typebox";
import { Nullable } from "./nullable.js";

// Staff view of guest invitations and the guest list import (/v1, docs/registration.md,
// "Event → Guest list"). "Guest invitation" keeps them apart from staff invitations.

const Uuid = Type.String({ format: "uuid" });
const DateTime = Type.String({ format: "date-time" });
const LocaleCode = Type.String({ pattern: "^[a-z]{2,3}(-[A-Z]{2})?$" });

export const GuestInvitationStatus = Type.Union([Type.Literal("pending"), Type.Literal("sent"), Type.Literal("accepted"), Type.Literal("declined")], {
  description: "pending: not sent yet. sent: no answer yet. accepted: has a registration. declined",
});
export const DeliveryStatus = Type.Union([
  Type.Literal("queued"), Type.Literal("sent"), Type.Literal("delivered"), Type.Literal("bounced"), Type.Literal("spam_complaint"), Type.Literal("failed"),
]);
export const SendKind = Type.Union([Type.Literal("invitation"), Type.Literal("reminder")]);

export const GuestInvitation = Type.Object({
  id: Uuid,
  eventId: Uuid,
  email: Type.String(),
  name: Nullable(Type.String()),
  locale: Nullable(Type.String({ description: "Null: the account's default" })),
  guestAllowed: Nullable(Type.Boolean({ description: "Null: the event's setting" })),
  externalContactId: Nullable(Type.String({ description: "The contact's id in the client's CRM or MA tool" })),
  status: GuestInvitationStatus,
  firstSentAt: Nullable(DateTime),
  lastSentAt: Nullable(DateTime),
  respondedAt: Nullable(DateTime),
  lastSend: Nullable(Type.Object({
    kind: SendKind,
    requestedAt: DateTime,
    sentAt: Nullable(DateTime),
    deliveryStatus: DeliveryStatus,
    deliveryDetail: Nullable(Type.String({ description: "external: sent from the client's own tool. Otherwise the mail service's reason" })),
    deliveryAt: Nullable(DateTime),
    channel: Type.Union([Type.Literal("platform"), Type.Literal("hubspot")], { description: "Who sent it: the platform's mail service, or HubSpot (docs/hubspot.md)" }),
    fallbackReason: Nullable(Type.String({ description: "Why the platform sent it although the event sends through HubSpot" })),
    unresolved: Type.Boolean({ description: "HubSpot took it, but the platform could not find out whether it went (its portal is not connected). deliveryDetail says why; staff may send again" }),
  })),
  registration: Nullable(Type.Object({ id: Uuid, occurrenceId: Uuid, partySize: Type.Integer() })),
  version: Type.Integer(),
  createdAt: DateTime,
  updatedAt: DateTime,
});

export const GuestInvitationCounts = Type.Object({
  total: Type.Integer(),
  pending: Type.Integer(),
  sent: Type.Integer({ description: "Sent, no answer yet" }),
  accepted: Type.Integer(),
  declined: Type.Integer(),
  undeliverable: Type.Integer({ description: "Last email bounced or was marked as spam" }),
  places: Type.Integer({ description: "Places taken by accepted guests" }),
});

export const GuestInvitationList = Type.Object({ items: Type.Array(GuestInvitation), counts: GuestInvitationCounts });

const invitationFields = {
  name: Type.Optional(Nullable(Type.String({ maxLength: 200 }))),
  locale: Type.Optional(Nullable(LocaleCode)),
  guestAllowed: Type.Optional(Nullable(Type.Boolean())),
  externalContactId: Type.Optional(Nullable(Type.String({ maxLength: 200 }))),
};
export const GuestInvitationCreate = Type.Object({ email: Type.String({ minLength: 3, maxLength: 254 }), ...invitationFields }, { additionalProperties: false });
export const GuestInvitationPatch = Type.Object(invitationFields, { additionalProperties: false, minProperties: 1 });

export const GuestInvitationIds = Type.Object({ ids: Type.Array(Uuid, { minItems: 1, maxItems: 20000, uniqueItems: true }) }, { additionalProperties: false });

export const GuestInvitationSend = Type.Object(
  {
    kind: SendKind,
    ids: Type.Optional(Type.Array(Uuid, { minItems: 1, maxItems: 20000, uniqueItems: true, description: "Omit to send to everyone the kind applies to: invitations to guests not sent one yet, reminders to guests who have not answered" })),
  },
  { additionalProperties: false },
);

export const GuestInvitationLink = Type.Object({ url: Type.String() });

export const ImportField = Type.Union([
  Type.Literal("email"), Type.Literal("name"), Type.Literal("firstName"), Type.Literal("lastName"),
  Type.Literal("locale"), Type.Literal("guestAllowed"), Type.Literal("externalContactId"),
]);
const col = Type.Optional(Type.Integer({ minimum: 0, maximum: 99 }));
export const ImportMapping = Type.Object(
  { email: col, name: col, firstName: col, lastName: col, locale: col, guestAllowed: col, externalContactId: col },
  { additionalProperties: false, description: "Field → column index (0-based). Email is required; use name, or first and last name" },
);

export const GuestImportUpload = Type.Object(
  {
    fileName: Type.String({ minLength: 1, maxLength: 255 }),
    content: Type.String({ contentEncoding: "base64", maxLength: 14_000_000, description: "The CSV or XLSX file, base64. At most 10 MB" }),
  },
  { additionalProperties: false },
);

export const GuestImportDraft = Type.Object({
  id: Uuid,
  eventId: Uuid,
  fileName: Type.String(),
  headers: Type.Array(Type.String()),
  sample: Type.Array(Type.Array(Type.String()), { description: "The first rows" }),
  rowCount: Type.Integer(),
  mapping: ImportMapping,
  expiresAt: DateTime,
});

export const GuestImportMappingBody = Type.Object({ mapping: ImportMapping }, { additionalProperties: false });

const RowError = Type.Object({
  line: Type.Integer({ description: "Row in the file; the header is row 1" }),
  field: ImportField,
  value: Type.String(),
  code: Type.Union([
    Type.Literal("missing_email"), Type.Literal("invalid_email"), Type.Literal("duplicate_email"),
    Type.Literal("invalid_locale"), Type.Literal("invalid_guest_allowed"), Type.Literal("too_long"),
  ]),
});
const MissingGuest = Type.Object({
  id: Uuid, email: Type.String(), name: Nullable(Type.String()), status: GuestInvitationStatus,
  removable: Type.Boolean({ description: "False for guests who have accepted: cancel the registration first" }),
});

export const GuestImportPreview = Type.Object({
  rowCount: Type.Integer(),
  added: Type.Integer(),
  updated: Type.Integer(),
  unchanged: Type.Integer(),
  errors: Type.Array(RowError, { description: "Rows that will be skipped (the first 500)" }),
  missing: Type.Array(MissingGuest, { description: "Guests on the list who are not in the file; never removed by the import" }),
});

export const GuestImportResult = Type.Object({
  added: Type.Integer(),
  updated: Type.Integer(),
  unchanged: Type.Integer(),
  skipped: Type.Integer(),
  missing: Type.Array(MissingGuest),
});
