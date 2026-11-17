import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import { registration } from "@event-manager/domain";
import { Problem, Registration, RegistrationCreate, RegistrationPatch, RegistrationStatus, Uuid } from "@event-manager/schemas";
import { inTenant } from "../plugins/context.js";
import { expectedVersion, setEtag } from "../plugins/etag.js";
import { idempotent } from "../plugins/idempotency.js";

// Staff: an occurrence's registrations (docs/registration.md, "Occurrence → Registrations").
// Staff additions skip the registration window and the guest setting, but not the places.

const accountScoped = { security: [{ bearer: [], accountId: [] }] };
const errors = { 400: Problem, 401: Problem, 403: Problem, 404: Problem };
const writeErrors = { ...errors, 409: Problem, 412: Problem, 422: Problem, 428: Problem };
const IdParams = Type.Object({ id: Uuid });

const iso = (d: Date) => d.toISOString();
const dto = (r: registration.Registration) => ({
  id: r.id, eventId: r.eventId, occurrenceId: r.occurrenceId, name: r.name, email: r.email, locale: r.locale, partySize: r.partySize,
  status: r.status, source: r.source, cancelledAt: r.cancelledAt ? iso(r.cancelledAt) : null, cancelledBy: r.cancelledBy,
  version: r.version, createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt),
});

export const registrationRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.addHook("preHandler", app.requireAccount);

  app.get(
    "/occurrences/:id/registrations",
    {
      schema: {
        operationId: "listRegistrations", tags: ["registrations"], ...accountScoped, summary: "The occurrence's registrations, oldest first",
        params: IdParams, querystring: Type.Object({ status: Type.Optional(Type.Array(RegistrationStatus)) }),
        response: { 200: Type.Object({ items: Type.Array(Registration) }), ...errors },
      },
    },
    async (req) => ({ items: (await inTenant(app, req, (tx, ctx) => registration.listRegistrations(tx, ctx, req.params.id, { status: req.query.status }))).map(dto) }),
  );

  app.post(
    "/occurrences/:id/registrations",
    {
      schema: {
        operationId: "createRegistration", tags: ["registrations"], ...accountScoped,
        summary: "Add someone by hand. Confirmed at once and emailed; 409 full when there is no place",
        params: IdParams, headers: Type.Object({ "idempotency-key": Type.Optional(Type.String({ minLength: 1, maxLength: 255 })) }),
        body: RegistrationCreate, response: { 201: Registration, ...writeErrors },
      },
    },
    async (req, reply) => {
      const r = await inTenant(app, req, (tx, ctx) =>
        idempotent(tx, req, ctx.tenantId, 201, async () => dto(await registration.register(tx, ctx.tenantId, req.params.id, req.body, { kind: "staff", ctx }))));
      setEtag(reply, (r.body as { version: number }).version);
      return reply.status(r.status).send(r.body as never);
    },
  );

  app.patch(
    "/registrations/:id",
    {
      schema: {
        operationId: "updateRegistration", tags: ["registrations"], ...accountScoped, summary: "Change name, locale or party size. Requires If-Match.",
        params: IdParams, body: RegistrationPatch, response: { 200: Registration, ...writeErrors },
      },
    },
    async (req, reply) => {
      const v = expectedVersion(req);
      const r = await inTenant(app, req, (tx, ctx) => registration.updateRegistration(tx, ctx.tenantId, req.params.id, req.body, { kind: "staff", ctx }, { expectedVersion: v }));
      setEtag(reply, r.version);
      return dto(r);
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
      const r = await inTenant(app, req, (tx, ctx) => registration.cancelRegistration(tx, ctx.tenantId, req.params.id, { kind: "staff", ctx }));
      setEtag(reply, r.version);
      return dto(r);
    },
  );
};
