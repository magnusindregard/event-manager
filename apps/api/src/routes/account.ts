import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import { tenancy } from "@event-manager/domain";
import { Account, AccountPatch, AuditEntry, Invitation, InvitationCreate, Member, Page, Problem, Uuid } from "@event-manager/schemas";
import { inTenant } from "../plugins/context.js";
import { expectedVersion, setEtag } from "../plugins/etag.js";

const toDto = (a: tenancy.Account) => ({ ...a, updatedAt: a.updatedAt.toISOString() });
// Account-Id is validated by requireAccount and documented as a security requirement,
// so typed clients set it once in middleware instead of on every call.
const accountScoped = { security: [{ bearer: [], accountId: [] }] };
const errors = { 400: Problem, 401: Problem, 403: Problem, 404: Problem };

export const accountRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.addHook("preHandler", app.requireAccount);

  app.get(
    "/account",
    { schema: { operationId: "getAccount", tags: ["account"], ...accountScoped, response: { 200: Account, ...errors } } },
    async (req, reply) => {
      const account = await inTenant(app, req, (tx) => tenancy.getAccount(tx));
      setEtag(reply, account.version);
      return toDto(account);
    },
  );

  app.patch(
    "/account",
    {
      schema: {
        operationId: "updateAccount",
        tags: ["account"],
        summary: "Update account settings (owner). Requires If-Match.",
        ...accountScoped,
        body: AccountPatch,
        response: { 200: Account, ...errors, 412: Problem, 422: Problem, 428: Problem },
      },
    },
    async (req, reply) => {
      const version = expectedVersion(req);
      const account = await inTenant(app, req, (tx, ctx) => tenancy.updateAccountSettings(tx, ctx, version, req.body));
      setEtag(reply, account.version);
      return toDto(account);
    },
  );

  app.get(
    "/account/members",
    { schema: { operationId: "listMembers", tags: ["account"], ...accountScoped, response: { 200: Type.Object({ members: Type.Array(Member), invitations: Type.Array(Invitation) }), ...errors } } },
    async (req) =>
      inTenant(app, req, async (tx) => ({
        members: await tenancy.listMembers(tx),
        invitations: (await tenancy.listInvitations(tx)).map((i) => ({ ...i, createdAt: i.createdAt.toISOString() })),
      })),
  );

  app.post(
    "/account/invitations",
    { schema: { operationId: "inviteMember", tags: ["account"], ...accountScoped, body: InvitationCreate, response: { 201: Invitation, ...errors, 409: Problem, 422: Problem } } },
    async (req, reply) => {
      const inv = await inTenant(app, req, (tx, ctx) => tenancy.inviteMember(tx, ctx, req.body.email, req.body.role));
      return reply.status(201).send({ ...inv, createdAt: inv.createdAt.toISOString() });
    },
  );

  app.delete(
    "/account/members/:userId",
    { schema: { operationId: "removeMember", tags: ["account"], ...accountScoped, params: Type.Object({ userId: Uuid }), response: { 204: Type.Null(), ...errors, 409: Problem } } },
    async (req, reply) => {
      await inTenant(app, req, (tx, ctx) => tenancy.removeMember(tx, ctx, req.params.userId));
      return reply.status(204).send(null);
    },
  );

  app.get(
    "/audit",
    {
      schema: {
        operationId: "listAudit",
        tags: ["audit"],
        ...accountScoped,
        querystring: Type.Object({
          entityType: Type.Optional(Type.String()),
          entityId: Type.Optional(Uuid),
          cursor: Type.Optional(Type.String()),
          limit: Type.Integer({ minimum: 1, maximum: 200, default: 50 }),
        }),
        response: { 200: Page(AuditEntry), ...errors },
      },
    },
    async (req) => {
      const { entityType, entityId, cursor, limit } = req.query;
      const before = cursor ? Buffer.from(cursor, "base64url").toString() : undefined;
      const rows = await inTenant(app, req, async (tx, ctx) => {
        tenancy.assertCan(ctx, "audit.read");
        return tenancy.listAudit(tx, { entityType, entityId, before, limit: limit + 1 });
      });
      const items = rows.slice(0, limit).map((r) => ({ ...r, at: r.at.toISOString() }));
      const nextCursor = rows.length > limit ? Buffer.from(items[items.length - 1]!.id).toString("base64url") : null;
      return { items, nextCursor };
    },
  );
};
