import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import { DomainError, payments, sales } from "@event-manager/domain";
import { OccurrenceSales, Problem, Reservation, ReservationCancel, Uuid } from "@event-manager/schemas";
import { inTenant } from "../plugins/context.js";
import { idempotent } from "../plugins/idempotency.js";
import { emptyBody, reservationDto } from "./reservations.js";

// Staff: Occurrence → Sales (docs/ticketing.md, "Admin interface", milestone 4). Held and sold
// per offer, the reservations with order references and buyers (sales.read), and cancelling
// confirmed tickets from the admin (sales.write). Channels use /v1/reservations instead.

const accountScoped = { security: [{ bearer: [], accountId: [] }] };
const errors = { 400: Problem, 401: Problem, 403: Problem, 404: Problem };
const writeErrors = { ...errors, 409: Problem, 422: Problem };
const IdParams = Type.Object({ id: Uuid });

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d ? iso(d) : null);

export const salesRoutes: FastifyPluginAsyncTypebox<{ attendeeUrl: string }> = async (app, opts) => {
  app.addHook("preHandler", app.requireAccount);
  const dto = reservationDto(opts.attendeeUrl.replace(/\/+$/, ""));

  app.get(
    "/occurrences/:id/sales",
    {
      schema: {
        operationId: "getOccurrenceSales", tags: ["sales"], ...accountScoped,
        summary: "Held and sold per offer, and the reservations with lines at the occurrence, newest first. Needs sales.read (buyers are personal data)",
        params: IdParams, response: { 200: OccurrenceSales, ...errors },
      },
    },
    async (req, reply) => {
      const { s, paid } = await inTenant(app, req, async (tx, ctx) => {
        const s = await sales.occurrenceSales(tx, ctx, req.params.id);
        return { s, paid: await payments.paymentSummaries(tx, s.reservations.map((r) => r.id)) };
      });
      reply.header("cache-control", "no-store");
      return {
        ...s,
        reservations: s.reservations.map((r) => ({
          ...r,
          payment: (() => {
            const p = paid.get(r.id);
            return p ? { ...p, state: p.state as never, refunds: p.refunds.map((x) => ({ ...x, createdAt: iso(x.createdAt) })) } : null;
          })(),
          anonymisedAt: isoOrNull(r.anonymisedAt), expiresAt: iso(r.expiresAt), confirmedAt: isoOrNull(r.confirmedAt), cancelledAt: isoOrNull(r.cancelledAt), createdAt: iso(r.createdAt),
          tickets: r.tickets.map((t) => ({ ...t, cancelledAt: isoOrNull(t.cancelledAt) })),
        })),
      };
    },
  );

  app.get(
    "/sales/reservations/:id",
    {
      schema: {
        operationId: "getReservationAsStaff", tags: ["sales"], ...accountScoped,
        summary: "A reservation of any channel, with its tickets and their links. Needs sales.read", params: IdParams, response: { 200: Reservation, ...errors },
      },
    },
    async (req, reply) => {
      const r = await inTenant(app, req, (tx, ctx) => sales.getReservationAsStaff(tx, ctx, req.params.id));
      reply.header("cache-control", "no-store");
      return dto(r) as never;
    },
  );

  app.post(
    "/sales/reservations/:id/cancel",
    {
      schema: {
        operationId: "cancelTicketsAsStaff", tags: ["sales"], ...accountScoped,
        summary: "Cancel a confirmed reservation's tickets, all or those listed: their admissions are voided and the places go back on sale. Needs sales.write",
        description: "The channel is not told yet (webhooks arrive with epic #9); refunds stay in the channel. Reasons: already_cancelled, occurrence_started, conflict (not confirmed)",
        params: IdParams, body: ReservationCancel, response: { 200: Reservation, ...writeErrors },
      },
      preValidation: emptyBody,
    },
    async (req, reply) => {
      const r = await inTenant(app, req, async (tx, ctx) => {
        // Paid in the hosted checkout: cancelling must give the money back too (refundTicketsAsStaff).
        if ((await payments.paymentForReservation(tx, req.params.id))?.state === "captured") {
          throw new DomainError("conflict", "The reservation was paid in the hosted checkout; cancel its tickets with a refund");
        }
        return idempotent(tx, req, ctx.tenantId, 200, async () => dto(await sales.cancelTicketsAsStaff(tx, ctx, req.params.id, req.body ?? {})), {
          // The response carries the buyer; keep only the id and rebuild it on a retry.
          store: (body) => ({ reservationId: (body as { id: string }).id }),
          replay: async (stored) => dto(await sales.getReservationAsStaff(tx, ctx, (stored as { reservationId: string }).reservationId)),
        });
      });
      return reply.status(r.status).header("cache-control", "no-store").send(r.body as never);
    },
  );
};
