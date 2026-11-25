import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import { registration } from "@event-manager/domain";
import {
  GuestImportDraft, GuestImportMappingBody, GuestImportPreview, GuestImportResult, GuestImportUpload, GuestInvitation, GuestInvitationCreate,
  GuestInvitationIds, GuestInvitationLink, GuestInvitationList, GuestInvitationPatch, GuestInvitationSend, GuestInvitationStatus, Problem, Uuid,
} from "@event-manager/schemas";
import { inTenant } from "../plugins/context.js";
import { expectedVersion, setEtag } from "../plugins/etag.js";

// Staff: an event's guest list (docs/registration.md, "Event → Guest list"): import,
// add and edit guests, send invitations and reminders, personal links and their export.

const accountScoped = { security: [{ bearer: [], accountId: [] }] };
const errors = { 400: Problem, 401: Problem, 403: Problem, 404: Problem };
const writeErrors = { ...errors, 409: Problem, 412: Problem, 422: Problem, 428: Problem };
const IdParams = Type.Object({ id: Uuid });

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const dto = (i: registration.GuestInvitation | registration.GuestInvitationView) => ({
  id: i.id, eventId: i.eventId, email: i.email, name: i.name, locale: i.locale, guestAllowed: i.guestAllowed, externalContactId: i.externalContactId,
  status: i.status, firstSentAt: iso(i.firstSentAt), lastSentAt: iso(i.lastSentAt), respondedAt: iso(i.respondedAt),
  lastSend: "lastSend" in i && i.lastSend
    ? { kind: i.lastSend.kind, requestedAt: i.lastSend.requestedAt.toISOString(), sentAt: iso(i.lastSend.sentAt), deliveryStatus: i.lastSend.deliveryStatus, deliveryDetail: i.lastSend.deliveryDetail, deliveryAt: iso(i.lastSend.deliveryAt), channel: i.lastSend.channel, fallbackReason: i.lastSend.fallbackReason }
    : null,
  registration: "registration" in i ? i.registration : null,
  version: i.version, createdAt: i.createdAt.toISOString(), updatedAt: i.updatedAt.toISOString(),
});

/** Pure: one CSV field, quoted when needed; a leading =, +, - or @ is defused so spreadsheets don't run it as a formula. */
export const csvField = (v: string | null, delimiter: string) => {
  let s = v ?? "";
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return s.includes(delimiter) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const invitationRoutes: FastifyPluginAsyncTypebox<{ attendeeUrl: string }> = async (app, opts) => {
  app.addHook("preHandler", app.requireAccount);
  const base = opts.attendeeUrl.replace(/\/+$/, "");
  const linkFor = (token: string) => `${base}/i/${token}`;

  app.get(
    "/events/:id/invitations",
    {
      schema: {
        operationId: "listGuestInvitations", tags: ["guest list"], ...accountScoped, summary: "The event's guest list with counts",
        params: IdParams, querystring: Type.Object({ status: Type.Optional(Type.Array(GuestInvitationStatus)) }),
        response: { 200: GuestInvitationList, ...errors },
      },
    },
    async (req) => {
      const r = await inTenant(app, req, (tx, ctx) => registration.listInvitations(tx, ctx, req.params.id, { status: req.query.status }));
      return { items: r.items.map(dto), counts: r.counts };
    },
  );

  app.post(
    "/events/:id/invitations",
    {
      schema: {
        operationId: "createGuestInvitation", tags: ["guest list"], ...accountScoped, summary: "Add one guest by hand. 409 when the email is on the list",
        params: IdParams, body: GuestInvitationCreate, response: { 201: GuestInvitation, ...writeErrors },
      },
    },
    async (req, reply) => {
      const i = await inTenant(app, req, (tx, ctx) => registration.createInvitation(tx, ctx, req.params.id, req.body));
      setEtag(reply, i.version);
      return reply.status(201).send(dto(i));
    },
  );

  app.patch(
    "/invitations/:id",
    {
      schema: {
        operationId: "updateGuestInvitation", tags: ["guest list"], ...accountScoped, summary: "Change a guest's name, language, guest allowance or contact id. Requires If-Match",
        params: IdParams, body: GuestInvitationPatch, response: { 200: GuestInvitation, ...writeErrors },
      },
    },
    async (req, reply) => {
      const v = expectedVersion(req);
      const i = await inTenant(app, req, (tx, ctx) => registration.updateInvitation(tx, ctx, req.params.id, req.body, v));
      setEtag(reply, i.version);
      return dto(i);
    },
  );

  app.post(
    "/events/:id/invitations/remove",
    {
      schema: {
        operationId: "removeGuestInvitations", tags: ["guest list"], ...accountScoped,
        summary: "Remove guests. Guests who have accepted are kept and returned as blocked",
        params: IdParams, body: GuestInvitationIds,
        response: { 200: Type.Object({ removed: Type.Array(Uuid), blocked: Type.Array(Uuid) }), ...writeErrors },
      },
    },
    async (req) => inTenant(app, req, (tx, ctx) => registration.removeInvitations(tx, ctx, req.params.id, req.body.ids)),
  );

  app.post(
    "/events/:id/invitations/send",
    {
      schema: {
        operationId: "sendGuestInvitations", tags: ["guest list"], ...accountScoped,
        summary: "Queue invitation or reminder emails. Named guests get a resend; without ids, invitations go to guests not sent one yet and reminders to guests who have not answered",
        params: IdParams, body: GuestInvitationSend,
        response: { 202: Type.Object({ queued: Type.Integer(), skipped: Type.Integer() }), ...writeErrors },
      },
    },
    async (req, reply) => reply.status(202).send(await inTenant(app, req, (tx, ctx) => registration.requestSends(tx, ctx, req.params.id, req.body))),
  );

  app.post(
    "/events/:id/invitations/mark-sent",
    {
      schema: {
        operationId: "markGuestInvitationsSent", tags: ["guest list"], ...accountScoped,
        summary: "Mark unsent guests as sent, for links sent from the client's own tool",
        params: IdParams, body: GuestInvitationIds, response: { 200: Type.Object({ marked: Type.Integer() }), ...writeErrors },
      },
    },
    async (req) => inTenant(app, req, (tx, ctx) => registration.markSentExternally(tx, ctx, req.params.id, req.body.ids)),
  );

  app.get(
    "/invitations/:id/link",
    {
      schema: {
        operationId: "getGuestInvitationLink", tags: ["guest list"], ...accountScoped, summary: "The guest's personal link",
        params: IdParams, response: { 200: GuestInvitationLink, ...errors },
      },
    },
    async (req) =>
      inTenant(app, req, async (tx, ctx) => {
        const i = await registration.getInvitation(tx, req.params.id);
        return { url: linkFor(await registration.invitationToken(tx, ctx.tenantId, i)) };
      }),
  );

  app.post(
    "/invitations/:id/rotate-link",
    {
      schema: {
        operationId: "rotateGuestInvitationLink", tags: ["guest list"], ...accountScoped, summary: "Give the guest a new personal link; the old one stops working",
        params: IdParams, response: { 200: GuestInvitationLink, ...writeErrors },
      },
    },
    async (req) =>
      inTenant(app, req, async (tx, ctx) => {
        const i = await registration.rotateInvitationLink(tx, ctx, req.params.id);
        return { url: linkFor(await registration.invitationToken(tx, ctx.tenantId, i)) };
      }),
  );

  app.get(
    "/events/:id/invitations/links.csv",
    {
      schema: {
        operationId: "exportGuestInvitationLinks", tags: ["guest list"], ...accountScoped,
        summary: "Every guest's personal link as CSV (UTF-8), for sending from the client's own tool. Semicolon-separated unless delimiter=comma",
        params: IdParams, querystring: Type.Object({ delimiter: Type.Optional(Type.Union([Type.Literal("semicolon"), Type.Literal("comma")])) }),
        produces: ["text/csv"],
        response: { 200: Type.String({ description: "CSV" }), ...errors },
      },
    },
    async (req, reply) => {
      const links = await inTenant(app, req, (tx, ctx) => registration.invitationLinks(tx, ctx, req.params.id));
      const d = req.query.delimiter === "comma" ? "," : ";";
      const lines = [
        ["email", "name", "locale", "external_contact_id", "status", "link"].join(d),
        ...links.map((l) => [l.email, l.name, l.locale, l.externalContactId, l.status, linkFor(l.token)].map((v) => csvField(v, d)).join(d)),
      ];
      return reply
        .type("text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="guest-links-${req.params.id.slice(0, 8)}.csv"`)
        .header("cache-control", "no-store")
        .send(`\uFEFF${lines.join("\r\n")}\r\n`);
    },
  );

  // ── Import ──

  const draftDto = (d: registration.ImportDraft) => ({ ...d, expiresAt: d.expiresAt.toISOString() });

  app.post(
    "/events/:id/guest-imports",
    {
      bodyLimit: 15 * 1024 * 1024,
      schema: {
        operationId: "uploadGuestImport", tags: ["guest list"], ...accountScoped,
        summary: "Upload a CSV or XLSX guest list. Staged for a day; returns the headers, a sample and a suggested column mapping",
        params: IdParams, body: GuestImportUpload, response: { 201: GuestImportDraft, ...writeErrors },
      },
    },
    async (req, reply) => {
      const content = Buffer.from(req.body.content, "base64");
      const d = await inTenant(app, req, (tx, ctx) => registration.stageImport(tx, ctx, req.params.id, { fileName: req.body.fileName, content }));
      return reply.status(201).send(draftDto(d));
    },
  );

  app.get(
    "/guest-imports/:id",
    {
      schema: {
        operationId: "getGuestImport", tags: ["guest list"], ...accountScoped,
        summary: "A staged import, as the upload returned it: for one staged in the background (a HubSpot list)",
        params: IdParams, response: { 200: GuestImportDraft, ...writeErrors },
      },
    },
    async (req) => draftDto(await inTenant(app, req, (tx, ctx) => registration.getImportDraft(tx, ctx, req.params.id))),
  );

  app.post(
    "/guest-imports/:id/preview",
    {
      schema: {
        operationId: "previewGuestImport", tags: ["guest list"], ...accountScoped, summary: "What importing with this mapping would do. Saves nothing",
        params: IdParams, body: GuestImportMappingBody, response: { 200: GuestImportPreview, ...writeErrors },
      },
    },
    async (req) => inTenant(app, req, (tx, ctx) => registration.previewImport(tx, ctx, req.params.id, req.body.mapping)),
  );

  app.post(
    "/guest-imports/:id/commit",
    {
      schema: {
        operationId: "commitGuestImport", tags: ["guest list"], ...accountScoped,
        summary: "Import the valid rows: new guests are added, existing ones (same email) updated. Nobody is removed",
        params: IdParams, body: GuestImportMappingBody, response: { 200: GuestImportResult, ...writeErrors },
      },
    },
    async (req) => inTenant(app, req, (tx, ctx) => registration.commitImport(tx, ctx, req.params.id, req.body.mapping)),
  );

  app.delete(
    "/guest-imports/:id",
    {
      schema: {
        operationId: "discardGuestImport", tags: ["guest list"], ...accountScoped, summary: "Drop a staged file without importing it",
        params: IdParams, response: { 204: Type.Null(), ...errors },
      },
    },
    async (req, reply) => {
      await inTenant(app, req, (tx, ctx) => registration.discardImport(tx, ctx, req.params.id));
      return reply.status(204).send(null);
    },
  );
};
