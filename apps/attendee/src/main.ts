import { useAzureMonitor } from "@azure/monitor-opentelemetry";

if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) useAzureMonitor();

const { createDb } = await import("@event-manager/db");
const { buildAttendeeApp, redactUrl } = await import("./app.js");

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = createDb(url);
const app = await buildAttendeeApp({
  db,
  // Manage and invitation links carry the token in the path; never log it.
  logger: { level: process.env.LOG_LEVEL ?? "info", serializers: { req: (req) => ({ method: req.method, url: redactUrl(req.url) }) } },
  rateLimit: {
    capacity: Number(process.env.ATTENDEE_RATE_LIMIT_BURST ?? 10),
    refillPerSecond: Number(process.env.ATTENDEE_RATE_LIMIT_PER_SECOND ?? 0.2),
  },
  // Proxies whose X-Forwarded-For entries count (default: private addresses, the ingress).
  ...(process.env.TRUSTED_PROXIES ? { trustedProxies: process.env.TRUSTED_PROXIES } : {}),
});

const shutdown = async () => {
  await app.close();
  await db.destroy();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ port: Number(process.env.PORT ?? 3020), host: "0.0.0.0" });
