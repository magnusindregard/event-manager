import { type Static, Type } from "typebox";

// Admin API (/v1) schemas for user groups (docs/user-groups.md): the account's groups, which
// mirror the groups the client's frontend already has.

const Uuid = Type.String({ format: "uuid" });
const DateTime = Type.String({ format: "date-time" });
const Code = Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{0,62}$", description: "Stable; the frontend and the connector use it. Cannot change" });
const Names = Type.Record(Type.String({ pattern: "^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$" }), Type.String({ minLength: 1, maxLength: 200 }), {
  minProperties: 1,
  maxProperties: 20,
  description: "Name per locale",
});
const SortOrder = Type.Integer({ minimum: -10000, maximum: 10000 });

export const UserGroup = Type.Object({
  id: Uuid,
  code: Type.String(),
  names: Type.Record(Type.String(), Type.String()),
  sortOrder: Type.Integer(),
  archived: Type.Boolean(),
  usedBy: Type.Integer({ description: "Events and offers restricted to the group; it cannot be archived while this is above 0" }),
  version: Type.Integer(),
  updatedAt: DateTime,
});
export type UserGroup = Static<typeof UserGroup>;

export const UserGroupCreate = Type.Object({ code: Code, names: Names, sortOrder: Type.Optional(SortOrder) }, { additionalProperties: false });
export const UserGroupPatch = Type.Object(
  { names: Type.Optional(Names), sortOrder: Type.Optional(SortOrder), archived: Type.Optional(Type.Boolean()) },
  { additionalProperties: false, minProperties: 1 },
);
