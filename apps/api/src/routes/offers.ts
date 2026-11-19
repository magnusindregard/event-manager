import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import { catalog, offers } from "@event-manager/domain";
import {
  Offer, OfferChangeResult, OfferCopy, OfferCopyResult, OfferCreate, OfferOverrideInput, OfferPatch, PriceCell, PriceGrid, Problem, Uuid, VatClass,
  VatClassCreate, VatClassPatch,
} from "@event-manager/schemas";
import { inTenant } from "../plugins/context.js";
import { decodeCursor, isTimeCursor, page } from "../plugins/cursor.js";
import { expectedVersion, setEtag } from "../plugins/etag.js";
import { idempotent } from "../plugins/idempotency.js";

// Ticketing milestones 1 and 2 (docs/ticketing.md): VAT classes, offers with their channels and
// sales windows, prices per occurrence. Channels and SKUs are in channels.ts.

const accountScoped = { security: [{ bearer: [], accountId: [] }] };
const errors = { 400: Problem, 401: Problem, 403: Problem, 404: Problem };
const writeErrors = { ...errors, 409: Problem, 412: Problem, 422: Problem, 428: Problem };
const idempotencyHeader = Type.Object({
  "idempotency-key": Type.Optional(Type.String({ minLength: 1, maxLength: 255, description: "Makes the POST safe to retry for 24 hours" })),
});
const IdParams = Type.Object({ id: Uuid });

const iso = (d: Date) => d.toISOString();
const vatDto = (v: offers.VatClass) => ({ ...v, updatedAt: iso(v.updatedAt) });
const offerDto = (o: offers.Offer) => ({
  ...o, onSaleAt: o.onSaleAt ? iso(o.onSaleAt) : null, offSaleAt: o.offSaleAt ? iso(o.offSaleAt) : null, createdAt: iso(o.createdAt), updatedAt: iso(o.updatedAt),
});
const resultDto = (r: offers.OfferChangeResult) => ({ offer: r.offer ? offerDto(r.offer) : null, resolution: r.resolution });

export const offerRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.addHook("preHandler", app.requireAccount);

  // ── VAT classes ──────────────────────────────────────────────────────────────
  app.get(
    "/vat-classes",
    { schema: { operationId: "listVatClasses", tags: ["offers"], ...accountScoped, summary: "The account's VAT classes, lowest rate first", response: { 200: Type.Object({ items: Type.Array(VatClass) }), ...errors } } },
    async (req) => ({ items: (await inTenant(app, req, (tx) => offers.listVatClasses(tx))).map(vatDto) }),
  );

  app.post(
    "/vat-classes",
    { schema: { operationId: "createVatClass", tags: ["offers"], ...accountScoped, summary: "Owner only", headers: idempotencyHeader, body: VatClassCreate, response: { 201: VatClass, ...writeErrors } } },
    async (req, reply) => {
      const r = await inTenant(app, req, (tx, ctx) => idempotent(tx, req, ctx.tenantId, 201, async () => vatDto(await offers.createVatClass(tx, ctx, req.body))));
      setEtag(reply, (r.body as { version: number }).version);
      return reply.status(r.status).send(r.body as never);
    },
  );

  app.patch(
    "/vat-classes/:id",
    {
      schema: {
        operationId: "updateVatClass", tags: ["offers"], ...accountScoped,
        summary: "Rename, archive or restore a VAT class (owner). The rate can only change while no offer uses the class. Requires If-Match.",
        params: IdParams, body: VatClassPatch, response: { 200: VatClass, ...writeErrors },
      },
    },
    async (req, reply) => {
      const v = expectedVersion(req);
      const vat = await inTenant(app, req, (tx, ctx) => offers.updateVatClass(tx, ctx, req.params.id, v, req.body));
      setEtag(reply, vat.version);
      return vatDto(vat);
    },
  );

  // ── Offers ───────────────────────────────────────────────────────────────────
  app.get(
    "/events/:id/offers",
    { schema: { operationId: "listEventOffers", tags: ["offers"], ...accountScoped, summary: "The event's offers in display order", params: IdParams, response: { 200: Type.Object({ items: Type.Array(Offer) }), ...errors } } },
    async (req) => ({
      items: (await inTenant(app, req, async (tx) => {
        await catalog.getEvent(tx, req.params.id);
        return offers.listOffers(tx, req.params.id);
      })).map(offerDto),
    }),
  );

  app.post(
    "/events/:id/offers",
    {
      schema: {
        operationId: "createOffer", tags: ["offers"], ...accountScoped,
        summary: "Add an offer to a ticketed event; its prices are resolved for every occurrence",
        params: IdParams, headers: idempotencyHeader, body: OfferCreate, response: { 201: OfferChangeResult, ...writeErrors },
      },
    },
    async (req, reply) => {
      const r = await inTenant(app, req, (tx, ctx) => idempotent(tx, req, ctx.tenantId, 201, async () => resultDto(await offers.createOffer(tx, ctx, req.params.id, req.body))));
      setEtag(reply, (r.body as { offer: { version: number } }).offer.version);
      return reply.status(r.status).send(r.body as never);
    },
  );

  app.post(
    "/events/:id/offers/copy",
    {
      schema: {
        operationId: "copyOffers", tags: ["offers"], ...accountScoped,
        summary: "Copy the active offers of another event (names, VAT class, limits, default prices). Codes the event already has are skipped",
        params: IdParams, headers: idempotencyHeader, body: OfferCopy, response: { 200: OfferCopyResult, ...writeErrors },
      },
    },
    async (req, reply) => {
      const r = await inTenant(app, req, (tx, ctx) =>
        idempotent(tx, req, ctx.tenantId, 200, async () => {
          const c = await offers.copyOffers(tx, ctx, req.params.id, req.body.fromEventId);
          return { created: c.created.map(offerDto), skipped: c.skipped, resolution: c.resolution };
        }),
      );
      return reply.status(r.status).send(r.body as never);
    },
  );

  app.get(
    "/offers/:id",
    { schema: { operationId: "getOffer", tags: ["offers"], ...accountScoped, params: IdParams, response: { 200: Offer, ...errors } } },
    async (req, reply) => {
      const o = await inTenant(app, req, (tx) => offers.getOffer(tx, req.params.id));
      setEtag(reply, o.version);
      return offerDto(o);
    },
  );

  app.patch(
    "/offers/:id",
    {
      schema: {
        operationId: "updateOffer", tags: ["offers"], ...accountScoped,
        summary: "Edit, archive or restore an offer. A new default price is resolved for every occurrence. Requires If-Match.",
        params: IdParams, body: OfferPatch, response: { 200: OfferChangeResult, ...writeErrors },
      },
    },
    async (req, reply) => {
      const v = expectedVersion(req);
      const r = await inTenant(app, req, (tx, ctx) => offers.updateOffer(tx, ctx, req.params.id, v, req.body));
      if (r.offer) setEtag(reply, r.offer.version);
      return resultDto(r);
    },
  );

  app.delete(
    "/offers/:id",
    {
      schema: {
        operationId: "deleteOffer", tags: ["offers"], ...accountScoped,
        summary: "Delete an offer no rule refers to; its overrides and prices go with it. Requires If-Match.",
        params: IdParams, response: { 204: Type.Null(), ...writeErrors },
      },
    },
    async (req, reply) => {
      const v = expectedVersion(req);
      await inTenant(app, req, (tx, ctx) => offers.deleteOffer(tx, ctx, req.params.id, v));
      return reply.status(204).send(null);
    },
  );

  // ── Prices ───────────────────────────────────────────────────────────────────
  app.get(
    "/events/:id/prices",
    {
      schema: {
        operationId: "getPriceGrid", tags: ["offers"], ...accountScoped,
        summary: "The price grid: offers × occurrences in start order, each cell with its effective price and availability and their source",
        params: IdParams,
        querystring: Type.Object({
          from: Type.Optional(Type.String({ format: "date-time" })),
          to: Type.Optional(Type.String({ format: "date-time" })),
          cursor: Type.Optional(Type.String()),
          limit: Type.Integer({ minimum: 1, maximum: 500, default: 100 }),
        }),
        response: { 200: PriceGrid, ...errors },
      },
    },
    async (req) => {
      const { cursor, limit, from, to } = req.query;
      const c = decodeCursor(cursor, isTimeCursor);
      const grid = await inTenant(app, req, (tx) => offers.priceGrid(tx, req.params.id, {
        from: from ? new Date(from) : undefined, to: to ? new Date(to) : undefined, limit: limit + 1,
        after: c ? { startUtc: new Date(c.s), id: c.id } : undefined,
      }));
      const p = page(grid.rows, limit, (r) => ({ s: r.startUtc.toISOString(), id: r.occurrenceId }));
      return {
        offers: grid.offers.map(offerDto),
        items: p.items.map((r) => ({ ...r, startUtc: iso(r.startUtc), endUtc: iso(r.endUtc) })),
        nextCursor: p.nextCursor,
      };
    },
  );

  app.put(
    "/offers/:id/occurrences/:occurrenceId/override",
    {
      schema: {
        operationId: "setOfferOverride", tags: ["offers"], ...accountScoped,
        summary: "Override the offer's price or availability at one occurrence. null inherits again; fields left out are kept",
        params: Type.Object({ id: Uuid, occurrenceId: Uuid }), body: OfferOverrideInput, response: { 200: PriceCell, ...writeErrors },
      },
    },
    async (req) => inTenant(app, req, (tx, ctx) => offers.setOverride(tx, ctx, req.params.id, req.params.occurrenceId, req.body)),
  );

  app.delete(
    "/offers/:id/occurrences/:occurrenceId/override",
    {
      schema: {
        operationId: "clearOfferOverride", tags: ["offers"], ...accountScoped,
        summary: "Remove the offer's overrides at one occurrence; price and availability inherit from rules and the default again",
        params: Type.Object({ id: Uuid, occurrenceId: Uuid }), response: { 200: PriceCell, ...writeErrors },
      },
    },
    async (req) => inTenant(app, req, (tx, ctx) => offers.setOverride(tx, ctx, req.params.id, req.params.occurrenceId, { amount: null, available: null })),
  );
};
