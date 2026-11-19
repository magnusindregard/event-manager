import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import { offers, type tenancy } from "@event-manager/domain";
import { ChannelKey, ChannelKeyCreate, ChannelKeyCreated, Problem, SalesChannel, SalesChannelCreate, SalesChannelPatch, SkuMapping, SkuMappingInput, Uuid } from "@event-manager/schemas";
import { inTenant } from "../plugins/context.js";
import { expectedVersion, setEtag } from "../plugins/etag.js";
import { idempotent } from "../plugins/idempotency.js";

// Ticketing milestone 2 (docs/ticketing.md): sales channels, their keys and the SKU mapping.
// Reading channels and SKUs is open to members; changing them takes account.write.

const accountScoped = { security: [{ bearer: [], accountId: [] }] };
const errors = { 400: Problem, 401: Problem, 403: Problem, 404: Problem };
const writeErrors = { ...errors, 409: Problem, 412: Problem, 422: Problem, 428: Problem };
const idempotencyHeader = Type.Object({
  "idempotency-key": Type.Optional(Type.String({ minLength: 1, maxLength: 255, description: "Makes the POST safe to retry for 24 hours" })),
});
const IdParams = Type.Object({ id: Uuid });
const SkuParams = Type.Object({ vatClassId: Uuid, channelId: Uuid });

const iso = (d: Date) => d.toISOString();
const channelDto = (c: offers.SalesChannel) => ({ ...c, createdAt: iso(c.createdAt), updatedAt: iso(c.updatedAt) });
const keyDto = (k: tenancy.ApiKey) => ({ id: k.id, channelId: k.channelId!, prefix: k.prefix, label: k.label, createdAt: iso(k.createdAt), revokedAt: k.revokedAt ? iso(k.revokedAt) : null });
const skuDto = (m: offers.SkuMapping) => ({ ...m, updatedAt: iso(m.updatedAt) });

export const channelRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.addHook("preHandler", app.requireAccount);

  app.get(
    "/sales-channels",
    { schema: { operationId: "listSalesChannels", tags: ["channels"], ...accountScoped, summary: "The account's sales channels, active first", response: { 200: Type.Object({ items: Type.Array(SalesChannel) }), ...errors } } },
    async (req) => ({ items: (await inTenant(app, req, (tx) => offers.listChannels(tx))).map(channelDto) }),
  );

  app.post(
    "/sales-channels",
    { schema: { operationId: "createSalesChannel", tags: ["channels"], ...accountScoped, summary: "Owner only", headers: idempotencyHeader, body: SalesChannelCreate, response: { 201: SalesChannel, ...writeErrors } } },
    async (req, reply) => {
      const r = await inTenant(app, req, (tx, ctx) => idempotent(tx, req, ctx.tenantId, 201, async () => channelDto(await offers.createChannel(tx, ctx, req.body))));
      setEtag(reply, (r.body as { version: number }).version);
      return reply.status(r.status).send(r.body as never);
    },
  );

  app.get(
    "/sales-channels/:id",
    { schema: { operationId: "getSalesChannel", tags: ["channels"], ...accountScoped, params: IdParams, response: { 200: SalesChannel, ...errors } } },
    async (req, reply) => {
      const c = await inTenant(app, req, (tx) => offers.getChannel(tx, req.params.id));
      setEtag(reply, c.version);
      return channelDto(c);
    },
  );

  app.patch(
    "/sales-channels/:id",
    {
      schema: {
        operationId: "updateSalesChannel", tags: ["channels"], ...accountScoped,
        summary: "Rename, change hold time or ticket emails, or deactivate a channel (owner). Inactive channels' keys stop working. Requires If-Match.",
        params: IdParams, body: SalesChannelPatch, response: { 200: SalesChannel, ...writeErrors },
      },
    },
    async (req, reply) => {
      const v = expectedVersion(req);
      const c = await inTenant(app, req, (tx, ctx) => offers.updateChannel(tx, ctx, req.params.id, v, req.body));
      setEtag(reply, c.version);
      return channelDto(c);
    },
  );

  // ── Channel keys ─────────────────────────────────────────────────────────────
  app.get(
    "/sales-channels/:id/keys",
    { schema: { operationId: "listChannelKeys", tags: ["channels"], ...accountScoped, summary: "The channel's keys, newest first (owner)", params: IdParams, response: { 200: Type.Object({ items: Type.Array(ChannelKey) }), ...errors } } },
    async (req) => ({ items: (await inTenant(app, req, (tx, ctx) => offers.listChannelKeys(tx, ctx, req.params.id))).map(keyDto) }),
  );

  app.post(
    "/sales-channels/:id/keys",
    {
      schema: {
        operationId: "createChannelKey", tags: ["channels"], ...accountScoped,
        summary: "A key for the channel's connector (owner). Server-side only. The full secret is returned once",
        params: IdParams, body: ChannelKeyCreate, response: { 201: ChannelKeyCreated, ...writeErrors },
      },
    },
    async (req, reply) => {
      const k = await inTenant(app, req, (tx, ctx) => offers.createChannelKey(tx, ctx, req.params.id, req.body.label));
      return reply.status(201).header("cache-control", "no-store").send({ ...keyDto(k), secret: k.secret });
    },
  );

  app.delete(
    "/sales-channels/:id/keys/:keyId",
    { schema: { operationId: "revokeChannelKey", tags: ["channels"], ...accountScoped, params: Type.Object({ id: Uuid, keyId: Uuid }), response: { 204: Type.Null(), ...errors } } },
    async (req, reply) => {
      await inTenant(app, req, (tx, ctx) => offers.revokeChannelKey(tx, ctx, req.params.id, req.params.keyId));
      return reply.status(204).send(null);
    },
  );

  // ── SKU mapping ──────────────────────────────────────────────────────────────
  app.get(
    "/sku-mappings",
    { schema: { operationId: "listSkuMappings", tags: ["channels"], ...accountScoped, summary: "The shop's product per (VAT class, channel)", response: { 200: Type.Object({ items: Type.Array(SkuMapping) }), ...errors } } },
    async (req) => ({ items: (await inTenant(app, req, (tx) => offers.listSkuMappings(tx))).map(skuDto) }),
  );

  app.put(
    "/sku-mappings/:vatClassId/:channelId",
    {
      schema: {
        operationId: "setSkuMapping", tags: ["channels"], ...accountScoped,
        summary: "Set the SKU for a VAT class in a channel (owner)", params: SkuParams, body: SkuMappingInput, response: { 200: SkuMapping, ...writeErrors },
      },
    },
    async (req) => skuDto((await inTenant(app, req, (tx, ctx) => offers.setSkuMapping(tx, ctx, req.params.vatClassId, req.params.channelId, req.body.externalSku)))!),
  );

  app.delete(
    "/sku-mappings/:vatClassId/:channelId",
    {
      schema: {
        operationId: "clearSkuMapping", tags: ["channels"], ...accountScoped,
        summary: "Remove the SKU; offers of the VAT class are then not on sale in the channel (owner)", params: SkuParams, response: { 204: Type.Null(), ...writeErrors },
      },
    },
    async (req, reply) => {
      await inTenant(app, req, (tx, ctx) => offers.setSkuMapping(tx, ctx, req.params.vatClassId, req.params.channelId, null));
      return reply.status(204).send(null);
    },
  );
};
