import { createHash } from "node:crypto";
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import { type Db, sql, type Tx, withTenant } from "@event-manager/db";
import { catalog, tenancy } from "@event-manager/domain";
import { Problem, PublicEventDetail, PublicEventPage, PublicLocations, PublicOccurrencePage } from "@event-manager/schemas";
import { RateLimiter } from "./rate-limit.js";

// /public/v1 – read-only, cached at the edge (ADR 0007, docs/implementation-plan.md).
//
// Caching rule: Azure Front Door does not vary its cache on request headers, so the
// publishable key travels in the query string (?key=pk_…) and the cache key includes the
// full query string. Two tenants' keys therefore never share a cached response. Preview
// tokens (Authorization: Bearer prv_…) read drafts and are never cached.

export interface PublicAppDeps {
  db: Db;
  logger?: FastifyServerOptions["logger"];
  rateLimit?: { capacity: number; refillPerSecond: number };
  corsOrigins?: string[] | "*";
}

declare module "fastify" {
  interface FastifyRequest {
    publicAccess?: { tenantId: string; preview: boolean; keyId: string };
  }
}

const TYPE_BASE = "https://docs.event-manager.dev/problems/";
const CACHE_PUBLIC = "public, max-age=0, s-maxage=30, stale-while-revalidate=300";
const KEY_TTL_MS = 60_000;

class PublicProblem extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly headers: Record<string, string> = {}) {
    super(message);
  }
}

function problem(reply: FastifyReply, status: number, code: string, title: string, extra: Record<string, unknown> = {}) {
  return reply
    .status(status)
    .header("cache-control", "no-store")
    .type("application/problem+json")
    .send({ type: `${TYPE_BASE}${code}`, title, status, code, instance: reply.request.url.split("?")[0], ...extra });
}

// Cursors carry the last row's sort key.
const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
function decode<T>(c: string | undefined, valid: (v: unknown) => v is T): T | undefined {
  if (!c) return undefined;
  try {
    const v: unknown = JSON.parse(Buffer.from(c, "base64url").toString());
    if (valid(v)) return v;
  } catch {
    /* fall through */
  }
  throw new PublicProblem(400, "invalid_cursor", "cursor is not a value from a previous response");
}
const isTimeCursor = (v: unknown): v is { s: string; id: string } =>
  typeof v === "object" && v !== null && typeof (v as { s?: unknown }).s === "string" && typeof (v as { id?: unknown }).id === "string" && !Number.isNaN(Date.parse((v as { s: string }).s));
const isString = (v: unknown): v is string => typeof v === "string";

const Common = {
  key: Type.Optional(Type.String({ description: "Publishable key (pk_…). Required unless a preview token is sent." })),
  locale: Type.Optional(Type.String({ pattern: "^[a-z]{2,3}(-[A-Z]{2})?$", description: "Falls back to the account's default locale" })),
};
const DateTime = Type.String({ format: "date-time" });
const Uuid = Type.String({ format: "uuid" });
const errors = { 400: Problem, 401: Problem, 429: Problem };
const security: Record<string, string[]>[] = [{ publishableKey: [] }, { previewToken: [] }];

export async function buildPublicApp(deps: PublicAppDeps) {
  const app = Fastify({
    logger: deps.logger ?? false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: "array", useDefaults: true } },
  }).withTypeProvider<TypeBoxTypeProvider>();

  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Event manager public API",
        version: "1.0.0",
        description:
          "Read-only catalog for client websites and CMSes. Responses are cached at the edge for 30 s. Times are UTC; format them in the event's timezone.",
      },
      components: {
        securitySchemes: {
          publishableKey: { type: "apiKey", in: "query", name: "key", description: "Publishable key. Safe to use in browsers." },
          previewToken: { type: "http", scheme: "bearer", description: "Preview token (prv_…). Server-side only; also returns draft events; never cached." },
        },
      },
    },
  });
  await app.register(cors, { origin: deps.corsOrigins ?? "*", methods: ["GET", "HEAD"], allowedHeaders: ["authorization", "if-none-match"], exposedHeaders: ["etag"] });

  app.setNotFoundHandler((req, reply) => problem(reply, 404, "route_not_found", `No route ${req.method} ${req.url.split("?")[0]}`));
  app.setErrorHandler((err: FastifyError | PublicProblem, req, reply) => {
    if (err instanceof PublicProblem) {
      for (const [k, v] of Object.entries(err.headers)) reply.header(k, v);
      return problem(reply, err.status, err.code, err.message);
    }
    if (err.validation) {
      return problem(reply, 400, "invalid_request", "Request validation failed", {
        errors: err.validation.map((v) => ({ path: `${err.validationContext ?? ""}${v.instancePath}`, message: v.message ?? "invalid" })),
      });
    }
    if (err.statusCode && err.statusCode < 500) return problem(reply, err.statusCode, err.code?.toLowerCase() ?? "bad_request", err.message);
    req.log.error({ err }, "unhandled error");
    return problem(reply, 500, "internal_error", "Internal server error");
  });

  app.get("/healthz", { schema: { hide: true } }, async () => ({ ok: true }));
  app.get("/readyz", { schema: { hide: true } }, async () => {
    await sql`select 1`.execute(deps.db);
    return { ok: true };
  });

  // Key lookups are cached per replica; a revoked key stops working within KEY_TTL_MS.
  const keys = new Map<string, { access: tenancy.VerifiedApiKey | null; until: number }>();
  const resolveKey = async (token: string, kind: "publishable" | "preview") => {
    const cacheKey = `${kind}:${token}`;
    const hit = keys.get(cacheKey);
    if (hit && hit.until > Date.now()) return hit.access;
    const access = await tenancy.verifyApiKey(deps.db, token, kind);
    if (keys.size > 10_000) keys.clear();
    keys.set(cacheKey, { access, until: Date.now() + KEY_TTL_MS });
    return access;
  };
  const limiter = new RateLimiter(deps.rateLimit ?? { capacity: 300, refillPerSecond: 20 });

  const authorize = async (req: FastifyRequest) => {
    const auth = req.headers.authorization;
    const key = (req.query as { key?: string }).key;
    let access: tenancy.VerifiedApiKey | null;
    let id: string;
    if (auth?.startsWith("Bearer ")) {
      id = auth.slice(7).trim();
      access = await resolveKey(id, "preview");
      if (!access) throw new PublicProblem(401, "invalid_preview_token", "Unknown or revoked preview token");
    } else if (key) {
      id = key;
      access = await resolveKey(key, "publishable");
      if (!access) throw new PublicProblem(401, "invalid_key", "Unknown or revoked publishable key");
    } else {
      throw new PublicProblem(401, "key_required", "Pass a publishable key as ?key=pk_…");
    }
    const wait = limiter.take(id);
    if (wait > 0) throw new PublicProblem(429, "rate_limited", "Too many requests for this key", { "retry-after": String(Math.ceil(wait)) });
    req.publicAccess = { tenantId: access.tenantId, preview: access.kind === "preview", keyId: id.slice(0, 16) };
  };

  // Cache headers and conditional GET for every successful public response.
  app.addHook("onSend", async (req, reply, payload) => {
    if (!req.publicAccess || reply.statusCode !== 200 || typeof payload !== "string") return payload;
    if (req.publicAccess.preview) {
      reply.header("cache-control", "private, no-store");
      return payload;
    }
    const etag = `W/"${createHash("sha256").update(payload).digest("base64url").slice(0, 27)}"`;
    reply.header("etag", etag).header("cache-control", CACHE_PUBLIC);
    if (req.headers["if-none-match"] === etag) {
      reply.code(304);
      return "";
    }
    return payload;
  });

  const read = <T>(req: FastifyRequest, fn: (tx: Tx, opts: { preview: boolean }) => Promise<T>) =>
    withTenant(deps.db, { tenantId: req.publicAccess!.tenantId }, (tx) => fn(tx, { preview: req.publicAccess!.preview }));

  await app.register(
    async (plain) => {
      const v1 = plain.withTypeProvider<TypeBoxTypeProvider>();
      v1.addHook("preHandler", authorize);

      v1.get(
        "/occurrences",
        {
          schema: {
            operationId: "listOccurrences",
            tags: ["occurrences"],
            summary: "Occurrences in start order, each with its event, effective location, tags and admission link",
            security,
            querystring: Type.Object({
              ...Common,
              from: Type.Optional(Type.String({ format: "date-time", description: "Default: now. Occurrences still running at this time are included." })),
              to: Type.Optional(DateTime),
              event: Type.Optional(Type.String({ description: "Event id or slug" })),
              location: Type.Optional(Type.String({ format: "uuid", description: "Venue (includes its spaces) or space" })),
              tag: Type.Optional(Uuid),
              status: Type.Optional(Type.Union([Type.Literal("scheduled"), Type.Literal("cancelled")])),
              cursor: Type.Optional(Type.String()),
              limit: Type.Integer({ minimum: 1, maximum: 200, default: 50 }),
            }),
            response: { 200: PublicOccurrencePage, ...errors },
          },
        },
        async (req) => {
          const q = req.query;
          const after = decode(q.cursor, isTimeCursor);
          const res = await read(req, (tx, o) =>
            catalog.listPublicOccurrences(tx, { ...o, locale: q.locale }, {
              from: q.from ? new Date(q.from) : new Date(),
              to: q.to ? new Date(q.to) : undefined,
              event: q.event,
              locationId: q.location,
              tagId: q.tag,
              status: q.status,
              after: after ? { startUtc: new Date(after.s), id: after.id } : undefined,
              limit: q.limit + 1,
            }),
          );
          const items = res.items.slice(0, q.limit);
          const last = items[items.length - 1];
          return { locale: res.locale, items, nextCursor: res.items.length > q.limit && last ? encode({ s: last.startUtc, id: last.id }) : null };
        },
      );

      v1.get(
        "/events",
        {
          schema: {
            operationId: "listEvents",
            tags: ["events"],
            summary: "Published and cancelled events; filter by an occurrence window, location or tag",
            security,
            querystring: Type.Object({
              ...Common,
              from: Type.Optional(DateTime),
              to: Type.Optional(DateTime),
              location: Type.Optional(Uuid),
              tag: Type.Optional(Uuid),
              cursor: Type.Optional(Type.String()),
              limit: Type.Integer({ minimum: 1, maximum: 200, default: 50 }),
            }),
            response: { 200: PublicEventPage, ...errors },
          },
        },
        async (req) => {
          const q = req.query;
          const res = await read(req, (tx, o) =>
            catalog.listPublicEvents(tx, { ...o, locale: q.locale }, {
              from: q.from ? new Date(q.from) : undefined,
              to: q.to ? new Date(q.to) : undefined,
              locationId: q.location,
              tagId: q.tag,
              after: decode(q.cursor, isString),
              limit: q.limit + 1,
            }),
          );
          const items = res.items.slice(0, q.limit);
          return { locale: res.locale, items, nextCursor: res.items.length > q.limit ? encode(items[items.length - 1]!.id) : null };
        },
      );

      v1.get(
        "/events/:idOrSlug",
        {
          schema: {
            operationId: "getEvent",
            tags: ["events"],
            summary: "One event with its occurrences in a window (default: from now, up to 200)",
            security,
            params: Type.Object({ idOrSlug: Type.String({ maxLength: 120 }) }),
            querystring: Type.Object({
              ...Common,
              occurrencesFrom: Type.Optional(DateTime),
              occurrencesTo: Type.Optional(DateTime),
            }),
            response: { 200: PublicEventDetail, 404: Problem, ...errors },
          },
        },
        async (req) => {
          const q = req.query;
          const res = await read(req, (tx, o) =>
            catalog.getPublicEvent(tx, { ...o, locale: q.locale }, req.params.idOrSlug, {
              from: q.occurrencesFrom ? new Date(q.occurrencesFrom) : new Date(),
              to: q.occurrencesTo ? new Date(q.occurrencesTo) : undefined,
              limit: 200,
            }),
          );
          if (!res) throw new PublicProblem(404, "not_found", "Event not found");
          return res;
        },
      );

      v1.get(
        "/locations",
        { schema: { operationId: "listLocations", tags: ["locations"], summary: "Venues with their spaces", security, querystring: Type.Object(Common), response: { 200: PublicLocations, ...errors } } },
        async (req) => ({ items: await read(req, (tx) => catalog.publicLocations(tx)) }),
      );

      v1.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());
    },
    { prefix: "/public/v1" },
  );

  return app;
}
