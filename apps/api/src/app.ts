import Fastify, { type FastifyServerOptions } from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { type Db, sql } from "@event-manager/db";
import type { TokenVerifier } from "./auth.js";
import { contextPlugin } from "./plugins/context.js";
import { problemPlugin } from "./plugins/problem.js";
import { accountRoutes } from "./routes/account.js";
import { apiKeyRoutes } from "./routes/api-keys.js";
import { catalogRoutes } from "./routes/catalog.js";
import { channelRoutes } from "./routes/channels.js";
import { meRoutes } from "./routes/me.js";
import { offerRoutes } from "./routes/offers.js";
import { invitationRoutes } from "./routes/invitations.js";
import { postmarkWebhookRoutes } from "./routes/postmark-webhook.js";
import { registrationRoutes } from "./routes/registrations.js";
import { reservationRoutes } from "./routes/reservations.js";
import { salesRoutes } from "./routes/sales.js";

export interface AppDeps {
  db: Db;
  verifier: TokenVerifier;
  corsOrigins?: string[];
  logger?: FastifyServerOptions["logger"];
  /** Base URL of the hosted attendee pages, for guests' personal links. */
  attendeeUrl?: string;
  /** Basic-auth credentials Postmark sends with delivery webhooks; null leaves the webhook off. */
  postmarkWebhook?: { user: string; password: string } | null;
}

/** Operations whose request body may be left out. */
const OPTIONAL_BODY = new Set(["cancelReservation", "extendReservation", "cancelTicketsAsStaff"]);

export async function buildApp(deps: AppDeps) {
  const app = Fastify({
    logger: deps.logger ?? false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: "array", useDefaults: true } },
  }).withTypeProvider<TypeBoxTypeProvider>();

  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: { title: "Event manager core API", version: "1.0.0", description: "Core API (/v1) for admin and integrations. ADR 0007." },
      components: {
        securitySchemes: {
          bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
          accountId: { type: "apiKey", in: "header", name: "Account-Id", description: "UUID of the account the request acts on. Not a secret; membership is checked server-side." },
          channelKey: { type: "http", scheme: "bearer", description: "Sales channel key (sk_…), for the reservations API. Server-side only." },
        },
      },
    },
    // @fastify/swagger marks every body as required. These operations read a missing body as {}
    // (emptyBody in routes/reservations.ts), so the spec says so too.
    transformObject: (doc) => {
      if (!("openapiObject" in doc)) return doc.swaggerObject;
      const openapiObject = doc.openapiObject;
      for (const item of Object.values(openapiObject.paths ?? {})) {
        for (const op of Object.values(item ?? {}) as { operationId?: string; requestBody?: { required?: boolean } }[]) {
          if (op?.operationId && OPTIONAL_BODY.has(op.operationId) && op.requestBody) op.requestBody.required = false;
        }
      }
      return openapiObject;
    },
  });
  if (deps.corsOrigins?.length) {
    await app.register(cors, {
      origin: deps.corsOrigins,
      allowedHeaders: ["authorization", "content-type", "account-id", "if-match", "idempotency-key"],
      exposedHeaders: ["etag"],
      methods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
    });
  }
  await app.register(problemPlugin);
  await app.register(contextPlugin, { db: deps.db, verifier: deps.verifier });

  app.get("/healthz", { schema: { hide: true } }, async () => ({ ok: true }));
  app.get("/readyz", { schema: { hide: true } }, async () => {
    await sql`select 1`.execute(deps.db);
    return { ok: true };
  });

  if (deps.postmarkWebhook) await app.register(postmarkWebhookRoutes, { credentials: deps.postmarkWebhook });

  await app.register(
    async (v1) => {
      await v1.register(meRoutes);
      await v1.register(accountRoutes);
      await v1.register(catalogRoutes);
      await v1.register(offerRoutes);
      await v1.register(channelRoutes);
      await v1.register(apiKeyRoutes);
      await v1.register(registrationRoutes);
      await v1.register(invitationRoutes, { attendeeUrl: deps.attendeeUrl ?? "http://localhost:3020" });
      await v1.register(reservationRoutes, { attendeeUrl: deps.attendeeUrl ?? "http://localhost:3020" });
      await v1.register(salesRoutes, { attendeeUrl: deps.attendeeUrl ?? "http://localhost:3020" });
      v1.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());
    },
    { prefix: "/v1" },
  );

  return app;
}
