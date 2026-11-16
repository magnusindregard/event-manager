import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import { catalog } from "@event-manager/domain";
import {
  Event, EventCreate, EventPatch, EventStatus, EventSummary, Location, LocationCreate, LocationPatch, Occurrence,
  OccurrenceCreate, OccurrencePatch, Page, Problem, Tag, TagCreate, TagPatch, TagVocabulary, TagVocabularyCreate,
  TagVocabularyPatch, Uuid,
} from "@event-manager/schemas";
import { inTenant } from "../plugins/context.js";
import { decodeCursor, isString, isTimeCursor, page } from "../plugins/cursor.js";
import { expectedVersion, setEtag } from "../plugins/etag.js";
import { idempotent } from "../plugins/idempotency.js";

const accountScoped = { security: [{ bearer: [], accountId: [] }] };
const errors = { 400: Problem, 401: Problem, 403: Problem, 404: Problem };
const writeErrors = { ...errors, 409: Problem, 412: Problem, 422: Problem, 428: Problem };
const idempotencyHeader = Type.Object({
  "idempotency-key": Type.Optional(Type.String({ minLength: 1, maxLength: 255, description: "Makes the POST safe to retry for 24 hours" })),
});
const IdParams = Type.Object({ id: Uuid });

const iso = (d: Date) => d.toISOString();
const locationDto = (l: catalog.Location) => ({ ...l, updatedAt: iso(l.updatedAt) });
const eventDto = (e: catalog.CatalogEvent) => ({ ...e, createdAt: iso(e.createdAt), updatedAt: iso(e.updatedAt) });
const summaryDto = (e: catalog.EventSummary) => ({ ...eventDto(e), occurrenceCount: e.occurrenceCount, nextStartUtc: e.nextStartUtc ? iso(e.nextStartUtc) : null });
const occurrenceDto = (o: catalog.Occurrence) => ({ ...o, startUtc: iso(o.startUtc), endUtc: iso(o.endUtc), updatedAt: iso(o.updatedAt) });
const date = (s: string | undefined) => (s === undefined ? undefined : new Date(s));

export const catalogRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.addHook("preHandler", app.requireAccount);

  // ── Locations ────────────────────────────────────────────────────────────────
  app.get(
    "/locations",
    {
      schema: {
        operationId: "listLocations", tags: ["locations"], ...accountScoped,
        summary: "All venues and spaces, flat; build the tree from parentId",
        querystring: Type.Object({ includeArchived: Type.Boolean({ default: false }) }),
        response: { 200: Type.Object({ items: Type.Array(Location) }), ...errors },
      },
    },
    async (req) => ({ items: (await inTenant(app, req, (tx) => catalog.listLocations(tx, req.query))).map(locationDto) }),
  );

  app.post(
    "/locations",
    { schema: { operationId: "createLocation", tags: ["locations"], ...accountScoped, headers: idempotencyHeader, body: LocationCreate, response: { 201: Location, ...writeErrors } } },
    async (req, reply) => {
      const r = await inTenant(app, req, (tx, ctx) => idempotent(tx, req, ctx.tenantId, 201, async () => locationDto(await catalog.createLocation(tx, ctx, req.body))));
      setEtag(reply, (r.body as { version: number }).version);
      return reply.status(r.status).send(r.body as never);
    },
  );

  app.get(
    "/locations/:id",
    { schema: { operationId: "getLocation", tags: ["locations"], ...accountScoped, params: IdParams, response: { 200: Location, ...errors } } },
    async (req, reply) => {
      const l = await inTenant(app, req, (tx) => catalog.getLocation(tx, req.params.id));
      setEtag(reply, l.version);
      return locationDto(l);
    },
  );

  app.patch(
    "/locations/:id",
    { schema: { operationId: "updateLocation", tags: ["locations"], ...accountScoped, summary: "Edit, archive or restore a location. Requires If-Match.", params: IdParams, body: LocationPatch, response: { 200: Location, ...writeErrors } } },
    async (req, reply) => {
      const v = expectedVersion(req);
      const l = await inTenant(app, req, (tx, ctx) => catalog.updateLocation(tx, ctx, req.params.id, v, req.body));
      setEtag(reply, l.version);
      return locationDto(l);
    },
  );

  // ── Tag vocabularies ─────────────────────────────────────────────────────────
  app.get(
    "/tag-vocabularies",
    { schema: { operationId: "listTagVocabularies", tags: ["tags"], ...accountScoped, response: { 200: Type.Object({ items: Type.Array(TagVocabulary) }), ...errors } } },
    async (req) => ({ items: await inTenant(app, req, (tx) => catalog.listVocabularies(tx)) }),
  );

  app.post(
    "/tag-vocabularies",
    { schema: { operationId: "createTagVocabulary", tags: ["tags"], ...accountScoped, summary: "Owner only", body: TagVocabularyCreate, response: { 201: TagVocabulary, ...writeErrors } } },
    async (req, reply) => reply.status(201).send(await inTenant(app, req, (tx, ctx) => catalog.createVocabulary(tx, ctx, req.body))),
  );

  app.patch(
    "/tag-vocabularies/:id",
    { schema: { operationId: "updateTagVocabulary", tags: ["tags"], ...accountScoped, summary: "Owner only. Requires If-Match.", params: IdParams, body: TagVocabularyPatch, response: { 200: TagVocabulary, ...writeErrors } } },
    async (req, reply) => {
      const v = expectedVersion(req);
      const vocab = await inTenant(app, req, async (tx, ctx) => {
        await catalog.updateVocabulary(tx, ctx, req.params.id, v, req.body);
        return (await catalog.listVocabularies(tx)).find((x) => x.id === req.params.id)!;
      });
      setEtag(reply, vocab.version);
      return vocab;
    },
  );

  app.post(
    "/tag-vocabularies/:id/tags",
    { schema: { operationId: "createTag", tags: ["tags"], ...accountScoped, summary: "Owner only", params: IdParams, body: TagCreate, response: { 201: Tag, ...writeErrors } } },
    async (req, reply) => reply.status(201).send(await inTenant(app, req, (tx, ctx) => catalog.createTag(tx, ctx, req.params.id, req.body))),
  );

  app.patch(
    "/tags/:id",
    { schema: { operationId: "updateTag", tags: ["tags"], ...accountScoped, summary: "Rename or archive a tag (owner). Requires If-Match.", params: IdParams, body: TagPatch, response: { 200: Tag, ...writeErrors } } },
    async (req, reply) => {
      const v = expectedVersion(req);
      const tag = await inTenant(app, req, (tx, ctx) => catalog.updateTag(tx, ctx, req.params.id, v, req.body));
      setEtag(reply, tag.version);
      return tag;
    },
  );

  // ── Events ───────────────────────────────────────────────────────────────────
  app.get(
    "/events",
    {
      schema: {
        operationId: "listEvents", tags: ["events"], ...accountScoped, summary: "Events, newest first",
        querystring: Type.Object({
          q: Type.Optional(Type.String({ maxLength: 200, description: "Matches slug or any title" })),
          status: Type.Optional(Type.Array(EventStatus)),
          tagId: Type.Optional(Uuid),
          locationId: Type.Optional(Uuid),
          from: Type.Optional(Type.String({ format: "date-time", description: "Only events with an occurrence ending after this" })),
          to: Type.Optional(Type.String({ format: "date-time", description: "Only events with an occurrence starting before this" })),
          cursor: Type.Optional(Type.String()),
          limit: Type.Integer({ minimum: 1, maximum: 200, default: 50 }),
        }),
        response: { 200: Page(EventSummary), ...errors },
      },
    },
    async (req) => {
      const { cursor, limit, from, to, ...rest } = req.query;
      const before = decodeCursor(cursor, isString);
      const rows = await inTenant(app, req, (tx) => catalog.listEvents(tx, { ...rest, from: date(from), to: date(to), before, limit: limit + 1 }));
      const p = page(rows, limit, (e) => e.id);
      return { items: p.items.map(summaryDto), nextCursor: p.nextCursor };
    },
  );

  app.post(
    "/events",
    { schema: { operationId: "createEvent", tags: ["events"], ...accountScoped, summary: "Create a draft event", headers: idempotencyHeader, body: EventCreate, response: { 201: Event, ...writeErrors } } },
    async (req, reply) => {
      const r = await inTenant(app, req, (tx, ctx) => idempotent(tx, req, ctx.tenantId, 201, async () => eventDto(await catalog.createEvent(tx, ctx, req.body))));
      setEtag(reply, (r.body as { version: number }).version);
      return reply.status(r.status).send(r.body as never);
    },
  );

  app.get(
    "/events/:id",
    { schema: { operationId: "getEvent", tags: ["events"], ...accountScoped, params: IdParams, response: { 200: Event, ...errors } } },
    async (req, reply) => {
      const e = await inTenant(app, req, (tx) => catalog.getEvent(tx, req.params.id));
      setEtag(reply, e.version);
      return eventDto(e);
    },
  );

  app.patch(
    "/events/:id",
    { schema: { operationId: "updateEvent", tags: ["events"], ...accountScoped, summary: "Requires If-Match", params: IdParams, body: EventPatch, response: { 200: Event, ...writeErrors } } },
    async (req, reply) => {
      const v = expectedVersion(req);
      const e = await inTenant(app, req, (tx, ctx) => catalog.updateEvent(tx, ctx, req.params.id, v, req.body));
      setEtag(reply, e.version);
      return eventDto(e);
    },
  );

  const actions: { action: catalog.EventAction; operationId: string; summary: string }[] = [
    { action: "publish", operationId: "publishEvent", summary: "Make the event public (from draft or cancelled)" },
    { action: "unpublish", operationId: "unpublishEvent", summary: "Back to draft; hidden from the public API" },
    { action: "cancel", operationId: "cancelEvent", summary: "Cancelled events stay public so frontends can show them" },
    { action: "archive", operationId: "archiveEvent", summary: "Hide the event everywhere; no further edits to its schedule" },
  ];
  for (const a of actions) {
    app.post(
      `/events/:id/${a.action}`,
      { schema: { operationId: a.operationId, tags: ["events"], ...accountScoped, summary: `${a.summary}. Requires If-Match.`, params: IdParams, response: { 200: Event, ...writeErrors } } },
      async (req, reply) => {
        const v = expectedVersion(req);
        const e = await inTenant(app, req, (tx, ctx) => catalog.transitionEvent(tx, ctx, req.params.id, v, a.action));
        setEtag(reply, e.version);
        return eventDto(e);
      },
    );
  }

  // ── Occurrences ──────────────────────────────────────────────────────────────
  app.get(
    "/events/:id/occurrences",
    {
      schema: {
        operationId: "listEventOccurrences", tags: ["occurrences"], ...accountScoped, summary: "Occurrences in start order",
        params: IdParams,
        querystring: Type.Object({
          from: Type.Optional(Type.String({ format: "date-time" })),
          to: Type.Optional(Type.String({ format: "date-time" })),
          cursor: Type.Optional(Type.String()),
          limit: Type.Integer({ minimum: 1, maximum: 500, default: 100 }),
        }),
        response: { 200: Page(Occurrence), ...errors },
      },
    },
    async (req) => {
      const { cursor, limit, from, to } = req.query;
      const c = decodeCursor(cursor, isTimeCursor);
      const rows = await inTenant(app, req, async (tx) => {
        await catalog.getEvent(tx, req.params.id); // 404 for unknown events
        return catalog.listOccurrences(tx, {
          eventId: req.params.id, from: date(from), to: date(to), limit: limit + 1,
          after: c ? { startUtc: new Date(c.s), id: c.id } : undefined,
        });
      });
      const p = page(rows, limit, (o) => ({ s: o.startUtc.toISOString(), id: o.id }));
      return { items: p.items.map(occurrenceDto), nextCursor: p.nextCursor };
    },
  );

  app.post(
    "/events/:id/occurrences",
    { schema: { operationId: "createOccurrence", tags: ["occurrences"], ...accountScoped, summary: "Add a one-off occurrence", params: IdParams, headers: idempotencyHeader, body: OccurrenceCreate, response: { 201: Occurrence, ...writeErrors } } },
    async (req, reply) => {
      const { startUtc, endUtc, ...overrides } = req.body;
      const r = await inTenant(app, req, (tx, ctx) =>
        idempotent(tx, req, ctx.tenantId, 201, async () =>
          occurrenceDto(await catalog.createOccurrence(tx, ctx, req.params.id, { ...overrides, startUtc: new Date(startUtc), endUtc: date(endUtc) })),
        ),
      );
      setEtag(reply, (r.body as { version: number }).version);
      return reply.status(r.status).send(r.body as never);
    },
  );

  app.get(
    "/occurrences/:id",
    { schema: { operationId: "getOccurrence", tags: ["occurrences"], ...accountScoped, params: IdParams, response: { 200: Occurrence, ...errors } } },
    async (req, reply) => {
      const o = await inTenant(app, req, (tx) => catalog.getOccurrence(tx, req.params.id));
      setEtag(reply, o.version);
      return occurrenceDto(o);
    },
  );

  app.patch(
    "/occurrences/:id",
    { schema: { operationId: "updateOccurrence", tags: ["occurrences"], ...accountScoped, summary: "Move, cancel or override one occurrence. Requires If-Match.", params: IdParams, body: OccurrencePatch, response: { 200: Occurrence, ...writeErrors } } },
    async (req, reply) => {
      const v = expectedVersion(req);
      const { startUtc, endUtc, ...rest } = req.body;
      const o = await inTenant(app, req, (tx, ctx) => catalog.updateOccurrence(tx, ctx, req.params.id, v, { ...rest, startUtc: date(startUtc), endUtc: date(endUtc) }));
      setEtag(reply, o.version);
      return occurrenceDto(o);
    },
  );

  app.delete(
    "/occurrences/:id",
    { schema: { operationId: "deleteOccurrence", tags: ["occurrences"], ...accountScoped, summary: "Delete a one-off occurrence. Requires If-Match.", params: IdParams, response: { 204: Type.Null(), ...writeErrors } } },
    async (req, reply) => {
      const v = expectedVersion(req);
      await inTenant(app, req, (tx, ctx) => catalog.deleteOccurrence(tx, ctx, req.params.id, v));
      return reply.status(204).send(null);
    },
  );
};
