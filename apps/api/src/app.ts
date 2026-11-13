import Fastify, { type FastifyServerOptions } from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { type Db, sql } from "@event-manager/db";
import type { TokenVerifier } from "./auth.js";
import { contextPlugin } from "./plugins/context.js";
import { problemPlugin } from "./plugins/problem.js";
import { accountRoutes } from "./routes/account.js";
import { meRoutes } from "./routes/me.js";

export interface AppDeps {
  db: Db;
  verifier: TokenVerifier;
  corsOrigins?: string[];
  logger?: FastifyServerOptions["logger"];
}

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
        },
      },
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

  await app.register(
    async (v1) => {
      await v1.register(meRoutes);
      await v1.register(accountRoutes);
      v1.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());
    },
    { prefix: "/v1" },
  );

  return app;
}
