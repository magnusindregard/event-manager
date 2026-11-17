import { Type } from "typebox";

// Staff view of registrations (/v1, docs/registration.md "Admin interface").

const Uuid = Type.String({ format: "uuid" });
const DateTime = Type.String({ format: "date-time" });
const Nullable = <T extends Parameters<typeof Type.Union>[0][number]>(t: T) => Type.Union([t, Type.Null()]);

export const RegistrationStatus = Type.Union([Type.Literal("confirmed"), Type.Literal("waitlisted"), Type.Literal("offered"), Type.Literal("cancelled")]);

export const Registration = Type.Object({
  id: Uuid,
  eventId: Uuid,
  occurrenceId: Uuid,
  name: Type.String(),
  email: Type.String(),
  locale: Type.String(),
  partySize: Type.Integer({ minimum: 1, maximum: 2 }),
  status: RegistrationStatus,
  source: Type.Union([Type.Literal("invitation"), Type.Literal("open"), Type.Literal("staff")]),
  cancelledAt: Nullable(DateTime),
  cancelledBy: Nullable(Type.Union([Type.Literal("attendee"), Type.Literal("staff")])),
  version: Type.Integer(),
  createdAt: DateTime,
  updatedAt: DateTime,
});

export const RegistrationCreate = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 200 }),
    email: Type.String({ minLength: 3, maxLength: 254 }),
    locale: Type.Optional(Type.String({ pattern: "^[a-z]{2,3}(-[A-Z]{2})?$", description: "Defaults to the account's default locale" })),
    partySize: Type.Optional(Type.Integer({ minimum: 1, maximum: 2, description: "Staff may add a guest even where the event does not offer one" })),
  },
  { additionalProperties: false },
);

export const RegistrationPatch = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    locale: Type.Optional(Type.String({ pattern: "^[a-z]{2,3}(-[A-Z]{2})?$" })),
    partySize: Type.Optional(Type.Integer({ minimum: 1, maximum: 2 })),
  },
  { additionalProperties: false, minProperties: 1 },
);
