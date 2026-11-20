import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import { catalog } from "@event-manager/domain";
import { Problem, Uuid, UserGroup, UserGroupCreate, UserGroupPatch } from "@event-manager/schemas";
import { inTenant } from "../plugins/context.js";
import { expectedVersion, setEtag } from "../plugins/etag.js";
import { idempotent } from "../plugins/idempotency.js";

// User groups (docs/user-groups.md): the account's groups, mirroring the groups the client's
// frontend already has. Events and offers name them in their access lists.

const accountScoped = { security: [{ bearer: [], accountId: [] }] };
const errors = { 400: Problem, 401: Problem, 403: Problem, 404: Problem };
const writeErrors = { ...errors, 409: Problem, 412: Problem, 422: Problem, 428: Problem };
const idempotencyHeader = Type.Object({
  "idempotency-key": Type.Optional(Type.String({ minLength: 1, maxLength: 255, description: "Makes the POST safe to retry for 24 hours" })),
});

const groupDto = (g: catalog.UserGroup) => ({ ...g, updatedAt: g.updatedAt.toISOString() });

export const userGroupRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.addHook("preHandler", app.requireAccount);

  app.get(
    "/user-groups",
    { schema: { operationId: "listUserGroups", tags: ["groups"], ...accountScoped, summary: "The account's user groups, in display order", response: { 200: Type.Object({ items: Type.Array(UserGroup) }), ...errors } } },
    async (req) => ({ items: (await inTenant(app, req, (tx) => catalog.listUserGroups(tx))).map(groupDto) }),
  );

  app.post(
    "/user-groups",
    { schema: { operationId: "createUserGroup", tags: ["groups"], ...accountScoped, summary: "Owner only. At most 50 per account", headers: idempotencyHeader, body: UserGroupCreate, response: { 201: UserGroup, ...writeErrors } } },
    async (req, reply) => {
      const r = await inTenant(app, req, (tx, ctx) => idempotent(tx, req, ctx.tenantId, 201, async () => groupDto(await catalog.createUserGroup(tx, ctx, req.body))));
      setEtag(reply, (r.body as { version: number }).version);
      return reply.status(r.status).send(r.body as never);
    },
  );

  app.patch(
    "/user-groups/:id",
    {
      schema: {
        operationId: "updateUserGroup", tags: ["groups"], ...accountScoped,
        summary: "Rename, reorder, archive or restore a user group (owner). A group events or offers are restricted to cannot be archived. Requires If-Match.",
        params: Type.Object({ id: Uuid }), body: UserGroupPatch, response: { 200: UserGroup, ...writeErrors },
      },
    },
    async (req, reply) => {
      const v = expectedVersion(req);
      const g = await inTenant(app, req, (tx, ctx) => catalog.updateUserGroup(tx, ctx, req.params.id, v, req.body));
      setEtag(reply, g.version);
      return groupDto(g);
    },
  );
};
