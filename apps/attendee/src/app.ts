import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from "fastify";
import formbody from "@fastify/formbody";
import swagger from "@fastify/swagger";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import { type Db, sql } from "@event-manager/db";
import { DomainError, type registration } from "@event-manager/domain";
import {
  AttendeeOccurrence, AttendeeRegistration, AttendeeRegistrationCreate, AttendeeRegistrationCreated, AttendeeRegistrationPatch, AttendeeRegistrationView, Problem,
} from "@event-manager/schemas";
import { registerPages } from "./pages.js";
import { RateLimiter } from "./rate-limit.js";
import { AttendeeService, type Details, preferredLocale } from "./service.js";

// The attendee deployment unit (docs/registration.md, "Attendee pages"): the hosted pages
// and the attendee API they share their logic with. No accounts and no cookies; open
// registration takes an occurrence id, everything else a signed manage token.

export interface AttendeeAppDeps {
  db: Db;
  logger?: FastifyServerOptions["logger"];
  /** Per-IP limit on posts (registering, changing, cancelling). */
  rateLimit?: { capacity: number; refillPerSecond: number };
  clock?: () => Date;
}

const TYPE_BASE = "https://docs.event-manager.dev/problems/";
// Links carry the manage token in the path: keep it out of logs and referrers.
const redactUrl = (url: string) => url.replace(/\/m\/[A-Za-z0-9_-]+/, "/m/[token]");

class ApiProblem extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

const iso = (d: Date) => d.toISOString();
const registrationDto = (r: registration.Registration) => ({
  id: r.id, name: r.name, email: r.email, locale: r.locale, partySize: r.partySize, status: r.status, createdAt: iso(r.createdAt),
});
const detailsDto = (d: Details) => ({
  locale: d.locale,
  account: d.account,
  occurrence: {
    id: d.target.occurrence.id, startUtc: iso(d.target.occurrence.startUtc), endUtc: iso(d.target.occurrence.endUtc),
    timezone: d.target.event.timezone, status: d.target.event.status === "cancelled" ? ("cancelled" as const) : d.target.occurrence.status,
  },
  event: { id: d.target.event.id, title: d.title, shortDescription: d.shortDescription, image: d.image, accessPolicy: d.target.event.accessPolicy, guestAllowed: d.target.event.guestAllowed },
  location: d.target.location,
  availability: { status: d.availability.status, opensAt: d.availability.opensAt ? iso(d.availability.opensAt) : null, closesAt: iso(d.availability.closesAt) },
});

export async function buildAttendeeApp(deps: AttendeeAppDeps) {
  const app = Fastify({
    logger: deps.logger ?? false,
    trustProxy: true,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: "array", useDefaults: true } },
  }).withTypeProvider<TypeBoxTypeProvider>();
  const svc = new AttendeeService(deps.db, deps.clock);
  const limiter = new RateLimiter(deps.rateLimit ?? { capacity: 10, refillPerSecond: 0.2 });

  await app.register(formbody, { bodyLimit: 16_384 });
  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Event manager attendee API",
        version: "1.0.0",
        description: "Registration for attendees, behind the hosted pages. No accounts: open registration takes an occurrence id, the rest a signed manage token.",
      },
      components: { securitySchemes: { manageToken: { type: "http", scheme: "bearer", description: "The token from the registration's manage link" } } },
    },
  });

  app.addHook("onRequest", async (req) => {
    req.log = req.log.child({ url: redactUrl(req.url) });
  });
  app.addHook("onSend", async (_req, reply, payload) => {
    reply
      .header("cache-control", "no-store")
      .header("referrer-policy", "no-referrer")
      .header("x-content-type-options", "nosniff")
      .header("x-robots-tag", "noindex")
      .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    return payload;
  });

  const problem = (reply: FastifyReply, status: number, code: string, title: string, extra: Record<string, unknown> = {}) =>
    reply.status(status).type("application/problem+json").send({ type: `${TYPE_BASE}${code}`, title, status, code, instance: redactUrl(reply.request.url.split("?")[0]!), ...extra });

  app.setNotFoundHandler((req, reply) => problem(reply, 404, "route_not_found", `No route ${req.method} ${redactUrl(req.url.split("?")[0]!)}`));
  app.setErrorHandler((err: FastifyError | DomainError | ApiProblem, req, reply) => {
    if (err instanceof DomainError) return problem(reply, err.status, err.code, err.message, err.details ? { details: err.details } : {});
    if (err instanceof ApiProblem) return problem(reply, err.status, err.code, err.message);
    if ("validation" in err && err.validation) {
      return problem(reply, 400, "invalid_request", "Request validation failed", {
        errors: err.validation.map((v) => ({ path: `${err.validationContext ?? ""}${v.instancePath}`, message: v.message ?? "invalid" })),
      });
    }
    if ("statusCode" in err && err.statusCode && err.statusCode < 500) return problem(reply, err.statusCode, err.code?.toLowerCase() ?? "bad_request", err.message);
    req.log.error({ err }, "unhandled error");
    return problem(reply, 500, "internal_error", "Internal server error");
  });

  app.get("/healthz", { schema: { hide: true } }, async () => ({ ok: true }));
  app.get("/favicon.ico", { schema: { hide: true } }, async (_req, reply) => reply.code(204).send());
  app.get("/readyz", { schema: { hide: true } }, async () => {
    await sql`select 1`.execute(deps.db);
    return { ok: true };
  });

  registerPages(app, svc, limiter);

  const bearer = (req: FastifyRequest) => {
    const h = req.headers.authorization;
    if (!h?.startsWith("Bearer ")) throw new ApiProblem(401, "token_required", "Send the manage token as a bearer token");
    return h.slice(7).trim();
  };
  const invalidToken = () => new ApiProblem(401, "invalid_token", "Unknown, replaced or malformed token");
  const rateLimited = (req: FastifyRequest) => {
    if (limiter.take(`ip:${req.ip}`) > 0) throw new ApiProblem(429, "rate_limited", "Too many requests");
  };
  const errors = { 400: Problem, 401: Problem, 404: Problem, 429: Problem };
  const writeErrors = { ...errors, 403: Problem, 409: Problem, 422: Problem };
  const LocaleQuery = Type.Object({ locale: Type.Optional(Type.String({ pattern: "^[a-z]{2,3}(-[A-Z]{2})?$" })) });
  const security = [{ manageToken: [] }];

  await app.register(
    async (plain) => {
      const v1 = plain.withTypeProvider<TypeBoxTypeProvider>();

      v1.get(
        "/occurrences/:id",
        {
          schema: {
            operationId: "getOccurrence", tags: ["registration"], summary: "An occurrence open for registration, with its availability",
            params: Type.Object({ id: Type.String({ format: "uuid" }) }), querystring: LocaleQuery,
            response: { 200: AttendeeOccurrence, ...errors },
          },
        },
        async (req) => {
          const d = await svc.occurrence(req.params.id, req.query.locale ?? preferredLocale(req.headers["accept-language"]));
          if (!d) throw new ApiProblem(404, "not_found", "Occurrence not found");
          return detailsDto(d);
        },
      );

      v1.post(
        "/occurrences/:id/registrations",
        {
          schema: {
            operationId: "register", tags: ["registration"], summary: "Register; confirmed at once. Returns the manage token",
            params: Type.Object({ id: Type.String({ format: "uuid" }) }), body: AttendeeRegistrationCreate,
            response: { 201: AttendeeRegistrationCreated, ...writeErrors },
          },
        },
        async (req, reply) => {
          rateLimited(req);
          const res = await svc.register(req.params.id, req.body);
          if (!res) throw new ApiProblem(404, "not_found", "Occurrence not found");
          return reply.status(201).send({ registration: registrationDto(res.registration), manageToken: res.manageToken });
        },
      );

      v1.get(
        "/registration",
        {
          schema: {
            operationId: "getRegistration", tags: ["registration"], summary: "The registration behind the manage token", security, querystring: LocaleQuery,
            response: { 200: AttendeeRegistrationView, ...errors },
          },
        },
        async (req) => {
          const v = await svc.view(bearer(req), req.query.locale);
          if (!v) throw invalidToken();
          return { registration: registrationDto(v.registration), details: detailsDto(v.details), rights: v.rights, admissionToken: v.admissionToken };
        },
      );

      v1.patch(
        "/registration",
        {
          schema: {
            operationId: "updateRegistration", tags: ["registration"], summary: "Change the name, locale or guest until registration closes", security,
            body: AttendeeRegistrationPatch, response: { 200: Type.Object({ registration: AttendeeRegistration }), ...writeErrors },
          },
        },
        async (req) => {
          rateLimited(req);
          const r = await svc.update(bearer(req), req.body);
          if (!r) throw invalidToken();
          return { registration: registrationDto(r) };
        },
      );

      v1.post(
        "/registration/cancel",
        {
          schema: {
            operationId: "cancelRegistration", tags: ["registration"], summary: "Cancel until the occurrence starts; the place goes back", security,
            response: { 200: Type.Object({ registration: AttendeeRegistration }), ...writeErrors },
          },
        },
        async (req) => {
          rateLimited(req);
          const r = await svc.cancel(bearer(req));
          if (!r) throw invalidToken();
          return { registration: registrationDto(r) };
        },
      );

      v1.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());
    },
    { prefix: "/attendee/v1" },
  );

  return app;
}
