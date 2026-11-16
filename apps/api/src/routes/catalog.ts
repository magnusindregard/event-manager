import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { type Static, Type } from "typebox";
import { catalog } from "@event-manager/domain";
import {
  Event, EventCreate, EventPatch, EventStatus, EventSummary, Location, LocationCreate, LocationPatch, Occurrence,
  OccurrenceBulkUpdate, OccurrenceCreate, OccurrencePatch, Page, Problem, Rule, RuleChangeResult, RuleCreate, RuleEffect, RulePatch, Series, SeriesChangeResult, SeriesChanges, SeriesCreate, SeriesPatch, SeriesSplit, Tag, TagCreate, TagPatch, TagVocabulary, TagVocabularyCreate,
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
const seriesDto = (s: catalog.Series) => ({ ...s, exdates: [...s.exdates], generatedUntil: iso(s.generatedUntil), createdAt: iso(s.createdAt), updatedAt: iso(s.updatedAt) });
const slotDto = <T extends { startUtc: Date; endUtc: Date }>(x: T) => ({ ...x, startUtc: iso(x.startUtc), endUtc: iso(x.endUtc) });
const changesDto = (c: catalog.SeriesChanges) => ({
  counts: c.counts,
  created: c.created.map(slotDto),
  moved: c.moved.map((m) => ({ ...slotDto(m), fromStartUtc: iso(m.fromStartUtc), fromEndUtc: iso(m.fromEndUtc) })),
  deleted: c.deleted.map(slotDto),
  conflicts: c.conflicts.map(slotDto),
});
const changeResultDto = (r: catalog.SeriesChangeResult) => ({ series: r.series ? seriesDto(r.series) : null, changes: changesDto(r.changes) });
const ruleDto = (r: catalog.Rule) => ({
  id: r.id, eventId: r.eventId, name: r.name, priority: r.priority, active: r.active, conditions: r.conditions,
  effects: r.effects as Static<typeof RuleEffect>[], version: r.version, createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt),
});
const ruleResultDto = (r: catalog.RuleChangeResult) => ({
  rule: r.rule ? ruleDto(r.rule) : null,
  resolution: r.resolution,
  preview: {
    counts: r.preview.counts,
    changes: r.preview.changes.map((c) => ({ ...c, startUtc: iso(c.startUtc) })),
    conflicts: r.preview.conflicts.map((c) => ({ ...c, startUtc: iso(c.startUtc) })),
  },
});
const DryRun = Type.Object({ dryRun: Type.Boolean({ default: false, description: "Only report what would change (preview); nothing is saved" }) });
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
          seriesId: Type.Optional(Uuid),
          cursor: Type.Optional(Type.String()),
          limit: Type.Integer({ minimum: 1, maximum: 500, default: 100 }),
        }),
        response: { 200: Page(Occurrence), ...errors },
      },
    },
    async (req) => {
      const { cursor, limit, from, to, seriesId } = req.query;
      const c = decodeCursor(cursor, isTimeCursor);
      const rows = await inTenant(app, req, async (tx) => {
        await catalog.getEvent(tx, req.params.id); // 404 for unknown events
        return catalog.listOccurrences(tx, {
          eventId: req.params.id, seriesId, from: date(from), to: date(to), limit: limit + 1,
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
    { schema: { operationId: "updateOccurrence", tags: ["occurrences"], ...accountScoped, summary: "Move, cancel or override one occurrence (Outlook \"this occurrence\"). Changing time or overrides detaches a series occurrence. Requires If-Match.", params: IdParams, body: OccurrencePatch, response: { 200: Occurrence, ...writeErrors } } },
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
    { schema: { operationId: "deleteOccurrence", tags: ["occurrences"], ...accountScoped, summary: "Delete an occurrence. A series occurrence's slot is excluded from the series (EXDATE). Requires If-Match.", params: IdParams, response: { 204: Type.Null(), ...writeErrors } } },
    async (req, reply) => {
      const v = expectedVersion(req);
      await inTenant(app, req, (tx, ctx) => catalog.deleteOccurrence(tx, ctx, req.params.id, v));
      return reply.status(204).send(null);
    },
  );

  app.post(
    "/occurrences/:id/reattach",
    { schema: { operationId: "reattachOccurrence", tags: ["occurrences"], ...accountScoped, summary: "Put a detached series occurrence back on its slot, without overrides. Requires If-Match.", params: IdParams, response: { 200: Occurrence, ...writeErrors } } },
    async (req, reply) => {
      const v = expectedVersion(req);
      const o = await inTenant(app, req, (tx, ctx) => catalog.reattachOccurrence(tx, ctx, req.params.id, v));
      setEtag(reply, o.version);
      return occurrenceDto(o);
    },
  );

  app.post(
    "/events/:id/occurrences/bulk-update",
    {
      schema: {
        operationId: "bulkUpdateOccurrences", tags: ["occurrences"], ...accountScoped,
        summary: "Set the same overrides or status on up to 1000 occurrences of the event. All or nothing: 412 if any version is stale. Overrides detach series occurrences.",
        params: IdParams, body: OccurrenceBulkUpdate, response: { 200: Type.Object({ items: Type.Array(Occurrence) }), ...writeErrors },
      },
    },
    async (req) => {
      const items = await inTenant(app, req, (tx, ctx) => catalog.bulkUpdateOccurrences(tx, ctx, req.params.id, req.body.items, req.body.set));
      return { items: items.map(occurrenceDto) };
    },
  );

  // ── Rules ────────────────────────────────────────────────────────────────────
  app.get(
    "/events/:id/rules",
    { schema: { operationId: "listEventRules", tags: ["rules"], ...accountScoped, summary: "The event's rules in resolution order", params: IdParams, response: { 200: Type.Object({ items: Type.Array(Rule) }), ...errors } } },
    async (req) => ({
      items: (await inTenant(app, req, async (tx) => {
        await catalog.getEvent(tx, req.params.id);
        return catalog.listRules(tx, req.params.id);
      })).map(ruleDto),
    }),
  );

  app.post(
    "/events/:id/rules",
    {
      schema: {
        operationId: "createRule", tags: ["rules"], ...accountScoped,
        summary: "Add a rule; the event's occurrences are resolved again. dryRun=true previews.",
        params: IdParams, querystring: DryRun, headers: idempotencyHeader, body: RuleCreate,
        response: { 200: RuleChangeResult, 201: RuleChangeResult, ...writeErrors },
      },
    },
    async (req, reply) => {
      if (req.query.dryRun) {
        return ruleResultDto(await inTenant(app, req, (tx, ctx) => catalog.createRule(tx, ctx, req.params.id, req.body, { dryRun: true })));
      }
      const r = await inTenant(app, req, (tx, ctx) =>
        idempotent(tx, req, ctx.tenantId, 201, async () => ruleResultDto(await catalog.createRule(tx, ctx, req.params.id, req.body))),
      );
      setEtag(reply, (r.body as { rule: { version: number } }).rule.version);
      return reply.status(r.status).send(r.body as never);
    },
  );

  app.get(
    "/rules/:id",
    { schema: { operationId: "getRule", tags: ["rules"], ...accountScoped, params: IdParams, response: { 200: Rule, ...errors } } },
    async (req, reply) => {
      const r = await inTenant(app, req, (tx) => catalog.getRule(tx, req.params.id));
      setEtag(reply, r.version);
      return ruleDto(r);
    },
  );

  app.patch(
    "/rules/:id",
    {
      schema: {
        operationId: "updateRule", tags: ["rules"], ...accountScoped,
        summary: "Edit a rule; the event's occurrences are resolved again. dryRun=true previews. Requires If-Match.",
        params: IdParams, querystring: DryRun, body: RulePatch, response: { 200: RuleChangeResult, ...writeErrors },
      },
    },
    async (req, reply) => {
      const v = expectedVersion(req);
      const r = await inTenant(app, req, (tx, ctx) => catalog.updateRule(tx, ctx, req.params.id, v, req.body, { dryRun: req.query.dryRun }));
      if (r.rule && !req.query.dryRun) setEtag(reply, r.rule.version);
      return ruleResultDto(r);
    },
  );

  app.delete(
    "/rules/:id",
    {
      schema: {
        operationId: "deleteRule", tags: ["rules"], ...accountScoped,
        summary: "Delete a rule; its occurrences fall back to other rules or the event default. dryRun=true previews. Requires If-Match.",
        params: IdParams, querystring: DryRun, response: { 200: RuleChangeResult, ...writeErrors },
      },
    },
    async (req) => {
      const v = expectedVersion(req);
      return ruleResultDto(await inTenant(app, req, (tx, ctx) => catalog.deleteRule(tx, ctx, req.params.id, v, { dryRun: req.query.dryRun })));
    },
  );

  // ── Series ───────────────────────────────────────────────────────────────────
  app.get(
    "/events/:id/series",
    { schema: { operationId: "listEventSeries", tags: ["series"], ...accountScoped, params: IdParams, response: { 200: Type.Object({ items: Type.Array(Series) }), ...errors } } },
    async (req) => ({
      items: (await inTenant(app, req, async (tx) => {
        await catalog.getEvent(tx, req.params.id);
        return catalog.listSeries(tx, req.params.id);
      })).map(seriesDto),
    }),
  );

  app.post(
    "/events/:id/series",
    {
      schema: {
        operationId: "createSeries", tags: ["series"], ...accountScoped,
        summary: "Add a recurring series; its occurrences are generated up to the account horizon. dryRun=true previews.",
        params: IdParams, querystring: DryRun, headers: idempotencyHeader, body: SeriesCreate,
        response: { 200: SeriesChangeResult, 201: SeriesChangeResult, ...writeErrors },
      },
    },
    async (req, reply) => {
      if (req.query.dryRun) {
        return changeResultDto(await inTenant(app, req, (tx, ctx) => catalog.createSeries(tx, ctx, req.params.id, req.body, { dryRun: true })));
      }
      const r = await inTenant(app, req, (tx, ctx) =>
        idempotent(tx, req, ctx.tenantId, 201, async () => changeResultDto(await catalog.createSeries(tx, ctx, req.params.id, req.body))),
      );
      setEtag(reply, (r.body as { series: { version: number } }).series.version);
      return reply.status(r.status).send(r.body as never);
    },
  );

  app.get(
    "/series/:id",
    { schema: { operationId: "getSeries", tags: ["series"], ...accountScoped, params: IdParams, response: { 200: Series, ...errors } } },
    async (req, reply) => {
      const s = await inTenant(app, req, (tx) => catalog.getSeries(tx, req.params.id));
      setEtag(reply, s.version);
      return seriesDto(s);
    },
  );

  app.patch(
    "/series/:id",
    {
      schema: {
        operationId: "updateSeries", tags: ["series"], ...accountScoped,
        summary: "Edit the entire series (Outlook). Upcoming occurrences follow the rule; detached ones stay and are flagged. dryRun=true previews. Requires If-Match.",
        params: IdParams, querystring: DryRun, body: SeriesPatch, response: { 200: SeriesChangeResult, ...writeErrors },
      },
    },
    async (req, reply) => {
      const v = expectedVersion(req);
      const r = await inTenant(app, req, (tx, ctx) => catalog.updateSeries(tx, ctx, req.params.id, v, req.body, { dryRun: req.query.dryRun }));
      if (r.series && !req.query.dryRun) setEtag(reply, r.series.version);
      return changeResultDto(r);
    },
  );

  app.post(
    "/series/:id/split",
    {
      schema: {
        operationId: "splitSeries", tags: ["series"], ...accountScoped,
        summary: "Edit this and following (Outlook): the series ends before the slot `at`, and a new series with the changes starts there. Returns the new series. dryRun=true previews. Requires If-Match.",
        params: IdParams, querystring: DryRun, body: SeriesSplit, response: { 200: SeriesChangeResult, ...writeErrors },
      },
    },
    async (req, reply) => {
      const v = expectedVersion(req);
      const { at, ...patch } = req.body;
      const r = await inTenant(app, req, (tx, ctx) => catalog.splitSeries(tx, ctx, req.params.id, v, at, patch, { dryRun: req.query.dryRun }));
      if (r.series) setEtag(reply, r.series.version);
      return changeResultDto(r);
    },
  );

  app.delete(
    "/series/:id",
    {
      schema: {
        operationId: "deleteSeries", tags: ["series"], ...accountScoped,
        summary: "Delete a series. Upcoming occurrences go; past and hand-edited ones are kept as one-off occurrences. Requires If-Match.",
        params: IdParams, response: { 200: Type.Object({ changes: SeriesChanges }), ...writeErrors },
      },
    },
    async (req) => {
      const v = expectedVersion(req);
      return { changes: changesDto(await inTenant(app, req, (tx, ctx) => catalog.deleteSeries(tx, ctx, req.params.id, v))) };
    },
  );
};
