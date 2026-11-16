import { useAzureMonitor } from "@azure/monitor-opentelemetry";

if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) useAzureMonitor();

const { createDb } = await import("@event-manager/db");
const { buildPublicApp } = await import("./app.js");

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = createDb(url);
const app = await buildPublicApp({
  db,
  logger: { level: process.env.LOG_LEVEL ?? "info" },
  rateLimit: {
    capacity: Number(process.env.PUBLIC_RATE_LIMIT_BURST ?? 300),
    refillPerSecond: Number(process.env.PUBLIC_RATE_LIMIT_PER_SECOND ?? 20),
  },
});

const shutdown = async () => {
  await app.close();
  await db.destroy();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ port: Number(process.env.PORT ?? 3001), host: "0.0.0.0" });
