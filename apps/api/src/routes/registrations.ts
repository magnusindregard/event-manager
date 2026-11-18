import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import type { Tx } from "@event-manager/db";
import { type ActorContext, registration } from "@event-manager/domain";
import {
  DoorList, Form, FormSave, Problem, Registration, RegistrationCreate, RegistrationList, RegistrationPatch, RegistrationStatus, Uuid,
} from "@event-manager/schemas";
import { inTenant } from "../plugins/context.js";
import { expectedVersion, setEtag } from "../plugins/etag.js";
import { idempotent } from "../plugins/idempotency.js";
import { csvField } from "./invitations.js";

// Staff: an occurrence's registrations, an event's form and the door list (docs/registration.md,
// "Admin interface"). Staff additions skip the registration window and the guest setting, but
// not the places. Sensitive answers are only returned with registrations.sensitive.

const accountScoped = { security: [{ bearer: [], accountId: [] }] };
const errors = { 400: Problem, 401: Problem, 403: Problem, 404: Problem };
const writeErrors = { ...errors, 409: Problem, 412: Problem, 422: Problem, 428: Problem };
const IdParams = Type.Object({ id: Uuid });

const iso = (d: Date) => d.toISOString();
const dto = (r: registration.Registration, answers: registration.Answers, hidden: boolean) => ({
  id: r.id, eventId: r.eventId, occurrenceId: r.occurrenceId,
  name: r.anonymisedAt ? "" : r.name, email: r.anonymisedAt ? "" : r.email, locale: r.locale, partySize: r.partySize,
  status: r.status, source: r.source, cancelledAt: r.cancelledAt ? iso(r.cancelledAt) : null, cancelledBy: r.cancelledBy,
  answers, hiddenSensitiveAnswers: hidden,
  sensitiveConsentAt: r.sensitiveConsentAt ? iso(r.sensitiveConsentAt) : null, anonymisedAt: r.anonymisedAt ? iso(r.anonymisedAt) : null,
  version: r.version, createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt),
});

/** Registrations with the answers the caller may see. */
async function withAnswers(tx: Tx, ctx: ActorContext, regs: registration.Registration[]) {
  const ids = regs.map((r) => r.id);
  const reader = { kind: "staff" as const, ctx };
  const [answers, sensitive] = await Promise.all([
    registration.readAnswers(tx, ctx.tenantId, ids, reader),
    registration.canReadSensitive(reader) ? Promise.resolve(new Set<string>()) : registration.hasSensitiveAnswers(tx, ids),
  ]);
  return regs.map((r) => dto(r, answers.get(r.id) ?? {}, sensitive.has(r.id)));
}
const one = async (tx: Tx, ctx: ActorContext, r: registration.Registration) => (await withAnswers(tx, ctx, [r]))[0]!;

const formDto = (f: registration.Form) => ({ eventId: f.eventId, version: f.version, fields: f.fields });

export const registrationRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.addHook("preHandler", app.requireAccount);

  // ── Form ──

  app.get(
    "/events/:id/form",
    {
      schema: {
        operationId: "getRegistrationForm", tags: ["registrations"], ...accountScoped, summary: "The event's registration form (fields after name and email)",
        params: IdParams, response: { 200: Form, ...errors },
      },
    },
    async (req) => formDto(await inTenant(app, req, (tx, ctx) => registration.getFormForStaff(tx, ctx, req.params.id))),
  );

  app.put(
    "/events/:id/form",
    {
      schema: {
        operationId: "saveRegistrationForm", tags: ["registrations"], ...accountScoped,
        summary: "Save the form as its next version. Answers given to earlier versions stay readable. 412 if it changed since `version`",
        params: IdParams, body: FormSave, response: { 200: Form, ...writeErrors },
      },
    },
    async (req) => formDto(await inTenant(app, req, (tx, ctx) => registration.saveForm(tx, ctx, req.params.id, req.body.version, req.body.fields))),
  );

  // ── Registrations ──

  app.get(
    "/occurrences/:id/registrations",
    {
      schema: {
        operationId: "listRegistrations", tags: ["registrations"], ...accountScoped, summary: "The occurrence's registrations with their answers, oldest first",
        params: IdParams, querystring: Type.Object({ status: Type.Optional(Type.Array(RegistrationStatus)) }),
        response: { 200: RegistrationList, ...errors },
      },
    },
    async (req) => inTenant(app, req, async (tx, ctx) => {
      const regs = await registration.listRegistrations(tx, ctx, req.params.id, { status: req.query.status });
      return { items: await withAnswers(tx, ctx, regs), fields: await registration.visibleAnswerFields(tx, ctx, req.params.id) };
    }),
  );

  app.post(
    "/occurrences/:id/registrations",
    {
      schema: {
        operationId: "createRegistration", tags: ["registrations"], ...accountScoped,
        summary: "Add someone by hand. Confirmed at once and emailed; 409 full when there is no place. Sensitive answers need registrations.sensitive",
        params: IdParams, headers: Type.Object({ "idempotency-key": Type.Optional(Type.String({ minLength: 1, maxLength: 255 })) }),
        body: RegistrationCreate, response: { 201: Registration, ...writeErrors },
      },
    },
    async (req, reply) => {
      const r = await inTenant(app, req, (tx, ctx) =>
        idempotent(tx, req, ctx.tenantId, 201, async () => one(tx, ctx, await registration.register(tx, ctx.tenantId, req.params.id, req.body, { kind: "staff", ctx }))));
      setEtag(reply, (r.body as { version: number }).version);
      return reply.status(r.status).send(r.body as never);
    },
  );

  app.patch(
    "/registrations/:id",
    {
      schema: {
        operationId: "updateRegistration", tags: ["registrations"], ...accountScoped,
        summary: "Change name, locale, party size or answers. Requires If-Match. Without registrations.sensitive, stored sensitive answers are kept",
        params: IdParams, body: RegistrationPatch, response: { 200: Registration, ...writeErrors },
      },
    },
    async (req, reply) => {
      const v = expectedVersion(req);
      const r = await inTenant(app, req, async (tx, ctx) =>
        one(tx, ctx, await registration.updateRegistration(tx, ctx.tenantId, req.params.id, req.body, { kind: "staff", ctx }, { expectedVersion: v })));
      setEtag(reply, r.version);
      return r;
    },
  );

  app.post(
    "/registrations/:id/cancel",
    {
      schema: {
        operationId: "cancelRegistration", tags: ["registrations"], ...accountScoped, summary: "Cancel and give the places back; the attendee is emailed. Cancelling twice is a no-op",
        params: IdParams, response: { 200: Registration, ...writeErrors },
      },
    },
    async (req, reply) => {
      const r = await inTenant(app, req, async (tx, ctx) => one(tx, ctx, await registration.cancelRegistration(tx, ctx.tenantId, req.params.id, { kind: "staff", ctx })));
      setEtag(reply, r.version);
      return r;
    },
  );

  // ── Door list ──

  const DoorQuery = Type.Object({
    answers: Type.Optional(Type.Boolean({ description: "Add the form's answers; sensitive ones only with registrations.sensitive (logged in the audit log)" })),
    locale: Type.Optional(Type.String({ pattern: "^[a-z]{2,3}(-[A-Z]{2})?$", description: "Locale of the column labels and choices" })),
  });

  app.get(
    "/occurrences/:id/door-list",
    {
      schema: {
        operationId: "getDoorList", tags: ["registrations"], ...accountScoped, summary: "Confirmed attendees in name order, for printing at the door",
        params: IdParams, querystring: DoorQuery, response: { 200: DoorList, ...errors },
      },
    },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return inTenant(app, req, (tx, ctx) => registration.doorList(tx, ctx, req.params.id, req.query));
    },
  );

  app.get(
    "/occurrences/:id/door-list.csv",
    {
      schema: {
        operationId: "exportDoorList", tags: ["registrations"], ...accountScoped,
        summary: "The door list as CSV (UTF-8). Semicolon-separated unless delimiter=comma",
        params: IdParams,
        querystring: Type.Intersect([DoorQuery, Type.Object({ delimiter: Type.Optional(Type.Union([Type.Literal("semicolon"), Type.Literal("comma")])) })]),
        produces: ["text/csv"], response: { 200: Type.String({ description: "CSV" }), ...errors },
      },
    },
    async (req, reply) => {
      const list = await inTenant(app, req, (tx, ctx) => registration.doorList(tx, ctx, req.params.id, req.query));
      const d = req.query.delimiter === "comma" ? "," : ";";
      const lines = [
        ["name", "email", "party_size", "source", ...list.columns.map((c) => c.label)].map((v) => csvField(v, d)).join(d),
        ...list.entries.map((e) => [e.name, e.email, String(e.partySize), e.source, ...list.columns.map((c) => e.answers[c.fieldId] ?? "")].map((v) => csvField(v, d)).join(d)),
      ];
      return reply
        .type("text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="door-list-${req.params.id.slice(0, 8)}.csv"`)
        .header("cache-control", "no-store")
        .send(`\uFEFF${lines.join("\r\n")}\r\n`);
    },
  );
};
