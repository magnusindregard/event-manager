import { type Static, Type } from "typebox";

// Shared request/response schemas (ADR 0007). Fastify validates with them and
// @fastify/swagger turns them into the OpenAPI document the SDK is generated from.

export const Uuid = Type.String({ format: "uuid" });
export const DateTime = Type.String({ format: "date-time" });
export const Locale = Type.String({ pattern: "^[a-z]{2,3}(-[A-Z]{2})?$", examples: ["nb", "en"] });

export const Role = Type.Union([
  Type.Literal("owner"), Type.Literal("editor"), Type.Literal("event_manager"),
  Type.Literal("box_office"), Type.Literal("door_staff"), Type.Literal("finance"),
]);
export const EnabledRole = Type.Union([Type.Literal("owner"), Type.Literal("editor")]);

/** RFC 9457 problem details with a stable reason code. */
export const Problem = Type.Object(
  {
    type: Type.String(),
    title: Type.String(),
    status: Type.Integer(),
    code: Type.String({ description: "Stable reason code, e.g. version_conflict" }),
    detail: Type.Optional(Type.String()),
    instance: Type.Optional(Type.String()),
    errors: Type.Optional(Type.Array(Type.Object({ path: Type.String(), message: Type.String() }))),
  },
  { additionalProperties: true },
);
export type Problem = Static<typeof Problem>;

export const Page = <T extends ReturnType<typeof Type.Object>>(item: T) =>
  Type.Object({ items: Type.Array(item), nextCursor: Type.Union([Type.String(), Type.Null()]) });

export const Account = Type.Object(
  {
    id: Uuid,
    slug: Type.String(),
    name: Type.String(),
    defaultTimezone: Type.String({ description: "IANA timezone, e.g. Europe/Oslo" }),
    defaultLocale: Locale,
    locales: Type.Array(Locale, { minItems: 1 }),
    horizonMonths: Type.Integer({ minimum: 1, maximum: 60 }),
    version: Type.Integer(),
    updatedAt: DateTime,
  },
);
export type Account = Static<typeof Account>;

export const AccountPatch = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    defaultTimezone: Type.Optional(Type.String({ minLength: 1 })),
    defaultLocale: Type.Optional(Locale),
    locales: Type.Optional(Type.Array(Locale, { minItems: 1, uniqueItems: true })),
    horizonMonths: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
  },
  { additionalProperties: false, minProperties: 1 },
);
export type AccountPatch = Static<typeof AccountPatch>;

export const AccountSummary = Type.Object(
  { accountId: Uuid, slug: Type.String(), name: Type.String(), roles: Type.Array(Role) },
);

export const Me = Type.Object(
  {
    userId: Uuid,
    email: Type.String(),
    name: Type.Union([Type.String(), Type.Null()]),
    accounts: Type.Array(AccountSummary),
  },
);
export type Me = Static<typeof Me>;

export const Member = Type.Object(
  { userId: Uuid, email: Type.String(), name: Type.Union([Type.String(), Type.Null()]), roles: Type.Array(Role) },
);

export const Invitation = Type.Object(
  { id: Uuid, email: Type.String(), role: Role, createdAt: DateTime },
);

export const InvitationCreate = Type.Object(
  { email: Type.String({ format: "email" }), role: EnabledRole },
  { additionalProperties: false },
);
export type InvitationCreate = Static<typeof InvitationCreate>;

export const AuditEntry = Type.Object(
  {
    id: Uuid,
    at: DateTime,
    action: Type.String(),
    entityType: Type.String(),
    entityId: Uuid,
    diff: Type.Unknown(),
    actor: Type.Object({
      userId: Type.Union([Uuid, Type.Null()]),
      email: Type.Union([Type.String(), Type.Null()]),
      name: Type.Union([Type.String(), Type.Null()]),
      clientId: Type.Union([Type.String(), Type.Null()]),
    }),
  },
);

