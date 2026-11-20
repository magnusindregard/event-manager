import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import { type Tx, withTenant } from "@event-manager/db";
import { sales, tenancy } from "@event-manager/domain";
import { Problem, Reservation, ReservationConfirm, ReservationCreate, ReservationExtend, Uuid } from "@event-manager/schemas";
import { AuthError } from "../auth.js";
import { idempotent } from "../plugins/idempotency.js";

// Reservations API (docs/ticketing.md, milestone 3), called by a sales channel's connector with
// its channel key (Authorization: Bearer sk_…). Every write needs an Idempotency-Key; keys are
// kept per channel. Responses carry buyer details, so the idempotency store keeps only the
// reservation id and a retry returns the reservation as it is now (the same tickets).

declare module "fastify" {
  interface FastifyRequest {
    channel?: sales.ChannelCaller;
  }
}

const channelScoped = { security: [{ channelKey: [] }] };
const errors = { 400: Problem, 401: Problem, 403: Problem, 404: Problem };
const writeErrors = { ...errors, 409: Problem, 422: Problem, 428: Problem };
const idempotencyHeader = Type.Object({
  // Optional in the schema so a missing key gets its own problem (428 idempotency_key_required).
  "idempotency-key": Type.Optional(Type.String({ minLength: 1, maxLength: 255, description: "Required. Makes the request safe to retry for 24 hours" })),
});
const IdParams = Type.Object({ id: Uuid });
const TOKEN_RE = /^sk_[A-Za-z0-9]{12}_([A-Za-z0-9_-]{43})$/;
const KEY_TTL_MS = 60_000;

const iso = (d: Date) => d.toISOString();

export const reservationRoutes: FastifyPluginAsyncTypebox<{ attendeeUrl: string }> = async (app, opts) => {
  const attendeeUrl = opts.attendeeUrl.replace(/\/+$/, "");
  // Key lookups are cached per replica; a revoked key stops working within KEY_TTL_MS. Whether
  // the channel is active is checked inside every request's transaction.
  const keys = new Map<string, { access: tenancy.VerifiedApiKey | null; until: number }>();

  app.addHook("preHandler", async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const m = TOKEN_RE.exec(token);
    if (!m) throw new AuthError("Send a sales channel key (sk_…) as a bearer token");
    let hit = keys.get(token);
    if (!hit || hit.until < Date.now()) {
      hit = { access: await tenancy.verifyApiKey(app.db, token, "channel"), until: Date.now() + KEY_TTL_MS };
      if (keys.size > 10_000) keys.clear();
      keys.set(token, hit);
    }
    if (!hit.access?.channelId) throw new AuthError("Unknown or revoked channel key");
    req.channel = { tenantId: hit.access.tenantId, channelId: hit.access.channelId, signingKey: createHash("sha256").update(m[1]!).digest() };
  });

  const inChannel = <T>(req: FastifyRequest, fn: (tx: Tx, caller: sales.ChannelCaller) => Promise<T>) =>
    withTenant(app.db, { tenantId: req.channel!.tenantId }, (tx) => fn(tx, req.channel!));

  const dto = (r: sales.Reservation) => ({
    id: r.id, channelId: r.channelId, status: r.status, expiresAt: iso(r.expiresAt), extendLimitAt: iso(r.extendLimitAt),
    externalRef: r.externalRef, externalOrderRef: r.externalOrderRef, locale: r.locale, buyer: r.buyer,
    lines: r.lines.map((l) => ({ ...l, occurrenceStartUtc: iso(l.occurrenceStartUtc) })),
    total: r.total,
    tickets: r.tickets.map((t) => ({
      id: t.id, lineId: t.lineId, occurrenceId: t.occurrenceId, offerId: t.offerId, status: t.status, admissionId: t.admissionId, partySize: t.partySize,
      url: t.ticketToken ? `${attendeeUrl}/t/${t.ticketToken}` : null, qr: t.admissionToken,
    })),
    confirmedAt: r.confirmedAt ? iso(r.confirmedAt) : null, cancelledAt: r.cancelledAt ? iso(r.cancelledAt) : null,
    version: r.version, createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt), signature: r.signature,
  });

  /** Runs a write once per Idempotency-Key; a retry returns the reservation as it is now. */
  const write = (req: FastifyRequest, status: number, fn: (tx: Tx, caller: sales.ChannelCaller) => Promise<sales.Reservation>) =>
    inChannel(req, (tx, caller) =>
      idempotent(tx, req, caller.tenantId, status, async () => dto(await fn(tx, caller)), {
        required: true,
        scope: `channel:${caller.channelId}`,
        store: (body) => ({ reservationId: (body as { id: string }).id }),
        replay: async (stored) => dto(await sales.getReservation(tx, caller, (stored as { reservationId: string }).reservationId)),
      }));

  app.post(
    "/reservations",
    {
      schema: {
        operationId: "createReservation", tags: ["reservations"], ...channelScoped,
        summary: "Hold places for all lines or none, priced and frozen in snapshots. With confirm: true and externalOrderRef, also confirm (POS walk-up)",
        description: "Reasons: sold_out (with occurrenceId and placesLeft), not_on_sale, offer_unavailable, channel_not_allowed, no_sku, quantity_out_of_range",
        headers: idempotencyHeader, body: ReservationCreate, response: { 201: Reservation, ...writeErrors },
      },
    },
    async (req, reply) => {
      const r = await write(req, 201, (tx, caller) => sales.reserve(tx, caller, req.body));
      return reply.status(r.status).header("cache-control", "no-store").send(r.body as never);
    },
  );

  app.get(
    "/reservations/:id",
    {
      schema: {
        operationId: "getReservation", tags: ["reservations"], ...channelScoped,
        summary: "The reservation as it is now: the connector's source of truth before charging", params: IdParams, response: { 200: Reservation, ...errors },
      },
    },
    async (req, reply) => {
      const r = await inChannel(req, (tx, caller) => sales.getReservation(tx, caller, req.params.id));
      return reply.header("cache-control", "no-store").send(dto(r) as never);
    },
  );

  app.post(
    "/reservations/:id/extend",
    {
      schema: {
        operationId: "extendReservation", tags: ["reservations"], ...channelScoped,
        summary: "Hold the places longer, at most 60 minutes after the reservation was made. Revalidates the lines",
        description: "Reasons: expired, extend_limit, and the reserve reasons for a line no longer on sale",
        params: IdParams, headers: idempotencyHeader, body: ReservationExtend, response: { 200: Reservation, ...writeErrors },
      },
    },
    async (req, reply) => {
      const r = await write(req, 200, (tx, caller) => sales.extendReservation(tx, caller, req.params.id, req.body ?? {}));
      return reply.status(r.status).header("cache-control", "no-store").send(r.body as never);
    },
  );

  app.post(
    "/reservations/:id/confirm",
    {
      schema: {
        operationId: "confirmReservation", tags: ["reservations"], ...channelScoped,
        summary: "Take the places and issue the tickets, with QR payloads and ticket page URLs. Charges what the snapshot says",
        description: "After expiry the places are taken again if still free. Reasons: expired_sold_out (refund the buyer), schedule_changed (the occurrence moved while held; refund and reserve again), already_cancelled, already_confirmed (another order)",
        params: IdParams, headers: idempotencyHeader, body: ReservationConfirm, response: { 200: Reservation, ...writeErrors },
      },
    },
    async (req, reply) => {
      const r = await write(req, 200, (tx, caller) => sales.confirm(tx, caller, req.params.id, req.body));
      return reply.status(r.status).header("cache-control", "no-store").send(r.body as never);
    },
  );

  app.post(
    "/reservations/:id/cancel",
    {
      schema: {
        operationId: "cancelReservation", tags: ["reservations"], ...channelScoped,
        summary: "Release a held reservation's places. Cancelling confirmed tickets is not supported yet",
        description: "Reasons: already_cancelled; conflict for a confirmed reservation",
        params: IdParams, headers: idempotencyHeader, response: { 200: Reservation, ...writeErrors },
      },
    },
    async (req, reply) => {
      const r = await write(req, 200, (tx, caller) => sales.cancelReservation(tx, caller, req.params.id));
      return reply.status(r.status).header("cache-control", "no-store").send(r.body as never);
    },
  );
};
