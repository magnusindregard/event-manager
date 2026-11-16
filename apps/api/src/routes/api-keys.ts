import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import { tenancy } from "@event-manager/domain";
import { ApiKey, ApiKeyCreate, ApiKeyCreated, Problem, Uuid } from "@event-manager/schemas";
import { inTenant } from "../plugins/context.js";

const accountScoped = { security: [{ bearer: [], accountId: [] }] };
const errors = { 400: Problem, 401: Problem, 403: Problem, 404: Problem };
const dto = (k: tenancy.ApiKey) => ({ ...k, createdAt: k.createdAt.toISOString(), revokedAt: k.revokedAt?.toISOString() ?? null });

/** Public API credentials (owner only). The full secret is returned once, on creation. */
export const apiKeyRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.addHook("preHandler", app.requireAccount);

  app.get(
    "/api-keys",
    { schema: { operationId: "listApiKeys", tags: ["api-keys"], ...accountScoped, response: { 200: Type.Object({ items: Type.Array(ApiKey) }), ...errors } } },
    async (req) => ({ items: (await inTenant(app, req, (tx, ctx) => tenancy.listApiKeys(tx, ctx))).map(dto) }),
  );

  app.post(
    "/api-keys",
    { schema: { operationId: "createApiKey", tags: ["api-keys"], ...accountScoped, body: ApiKeyCreate, response: { 201: ApiKeyCreated, ...errors } } },
    async (req, reply) => {
      const k = await inTenant(app, req, (tx, ctx) => tenancy.createApiKey(tx, ctx, req.body.kind, req.body.label));
      return reply.status(201).header("cache-control", "no-store").send({ ...dto(k), secret: k.secret });
    },
  );

  app.delete(
    "/api-keys/:id",
    { schema: { operationId: "revokeApiKey", tags: ["api-keys"], ...accountScoped, params: Type.Object({ id: Uuid }), response: { 204: Type.Null(), ...errors } } },
    async (req, reply) => {
      await inTenant(app, req, (tx, ctx) => tenancy.revokeApiKey(tx, ctx, req.params.id));
      return reply.status(204).send(null);
    },
  );
};
