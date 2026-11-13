import { useAzureMonitor } from "@azure/monitor-opentelemetry";

if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) useAzureMonitor();

const { default: Fastify } = await import("fastify");
const { createDb, sql } = await import("@event-manager/db");

// /public/v1 – read-only, cached at the edge (ADR 0007). Endpoints arrive in milestone 2:
// events, occurrences, locations. Caching rule (see docs/implementation-plan.md): the
// publishable key travels in the query string, because Front Door does not vary its
// cache on request headers.
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = createDb(url);
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

app.get("/healthz", async () => ({ ok: true }));
app.get("/readyz", async () => {
  await sql`select 1`.execute(db);
  return { ok: true };
});

await app.listen({ port: Number(process.env.PORT ?? 3001), host: "0.0.0.0" });
