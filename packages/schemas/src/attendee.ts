import { Type } from "typebox";
import { Nullable } from "./nullable.js";
import { Availability } from "./public.js";

// Attendee API (/attendee/v1, docs/registration.md "Attendee pages"). Behind the hosted
// pages today; versioned so client frontends can use it later. No accounts: the open
// endpoints take an occurrence id, the rest a signed manage token as bearer.

const Uuid = Type.String({ format: "uuid" });
const DateTime = Type.String({ format: "date-time" });

export const AttendeeOccurrence = Type.Object({
  locale: Type.String({ description: "Locale of the texts: the requested one, or the account default" }),
  account: Type.Object({ name: Type.String() }),
  occurrence: Type.Object({
    id: Uuid,
    startUtc: DateTime,
    endUtc: DateTime,
    timezone: Type.String({ description: "IANA timezone for displaying times" }),
    status: Type.Union([Type.Literal("scheduled"), Type.Literal("cancelled")]),
  }),
  event: Type.Object({
    id: Uuid,
    title: Type.String(),
    shortDescription: Nullable(Type.String()),
    image: Nullable(Type.Object({ url: Type.String(), alt: Nullable(Type.String()) })),
    accessPolicy: Type.Union([Type.Literal("open"), Type.Literal("invite_only")]),
    guestAllowed: Type.Boolean({ description: "Whether \"I will bring a guest\" is offered" }),
  }),
  location: Nullable(Type.Object({ name: Type.String(), address: Nullable(Type.String()), venue: Nullable(Type.String()) })),
  availability: Availability,
});

export const AttendeeRegistration = Type.Object({
  id: Uuid,
  name: Type.String(),
  email: Type.String(),
  locale: Type.String(),
  partySize: Type.Integer({ minimum: 1, maximum: 2 }),
  status: Type.Union([Type.Literal("confirmed"), Type.Literal("waitlisted"), Type.Literal("offered"), Type.Literal("cancelled")]),
  createdAt: DateTime,
});

export const AttendeeRegistrationCreate = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 200 }),
    email: Type.String({ minLength: 3, maxLength: 254 }),
    locale: Type.Optional(Type.String({ pattern: "^[a-z]{2,3}(-[A-Z]{2})?$" })),
    partySize: Type.Optional(Type.Integer({ minimum: 1, maximum: 2, description: "2 brings a guest, where the event allows it" })),
  },
  { additionalProperties: false },
);

export const AttendeeRegistrationPatch = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    locale: Type.Optional(Type.String({ pattern: "^[a-z]{2,3}(-[A-Z]{2})?$" })),
    partySize: Type.Optional(Type.Integer({ minimum: 1, maximum: 2 })),
  },
  { additionalProperties: false, minProperties: 1 },
);

export const AttendeeRegistrationCreated = Type.Object({
  registration: AttendeeRegistration,
  manageToken: Type.String({ description: "Bearer token for /registration. Also in the confirmation email's link; keep it private" }),
});

export const AttendeeRegistrationView = Type.Object({
  registration: AttendeeRegistration,
  details: AttendeeOccurrence,
  rights: Type.Object({
    change: Type.Boolean({ description: "Name and guest can be changed until registration closes" }),
    cancel: Type.Boolean({ description: "Can be cancelled until the occurrence starts" }),
  }),
  admissionToken: Nullable(Type.String({ description: "The QR code's content; null when cancelled" })),
});

// Invitations: the bearer is the invitation token from the guest's personal link.

export const AttendeeInvitationView = Type.Object({
  locale: Type.String(),
  account: Type.Object({ name: Type.String() }),
  invitation: Type.Object({
    name: Nullable(Type.String()),
    email: Type.String(),
    status: Type.Union([Type.Literal("pending"), Type.Literal("sent"), Type.Literal("accepted"), Type.Literal("declined")]),
    guestAllowed: Type.Boolean({ description: "Whether the guest may bring someone" }),
  }),
  event: Type.Object({
    id: Uuid,
    title: Type.String(),
    shortDescription: Nullable(Type.String()),
    image: Nullable(Type.Object({ url: Type.String(), alt: Nullable(Type.String()) })),
  }),
  occurrences: Type.Array(Type.Object({
    id: Uuid,
    startUtc: DateTime,
    endUtc: DateTime,
    timezone: Type.String(),
    location: Nullable(Type.Object({ name: Type.String(), address: Nullable(Type.String()), venue: Nullable(Type.String()) })),
    availability: Availability,
  }), { description: "Times still to come; accept with one whose availability is available or few_left" }),
  manageToken: Nullable(Type.String({ description: "Set when the guest has accepted: the bearer token for /registration" })),
});

export const AttendeeInvitationAccept = Type.Object(
  {
    occurrenceId: Uuid,
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Required when the guest list has no name" })),
    locale: Type.Optional(Type.String({ pattern: "^[a-z]{2,3}(-[A-Z]{2})?$" })),
    partySize: Type.Optional(Type.Integer({ minimum: 1, maximum: 2 })),
  },
  { additionalProperties: false },
);
