import { useAzureMonitor } from "@azure/monitor-opentelemetry";

// OpenTelemetry → Application Insights when the connection string is set (ADR 0009).
if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) useAzureMonitor();

const { createDb } = await import("@event-manager/db");
const { buildApp } = await import("./app.js");
const { anyVerifier, devVerifier, oidcVerifier } = await import("./auth.js");
const { loadConfig } = await import("./config.js");

const config = loadConfig();
const verifiers = [
  ...(config.oidc ? [oidcVerifier(config.oidc)] : []),
  ...(config.devAuthSecret ? [devVerifier(config.devAuthSecret)] : []),
];
const db = createDb(config.databaseUrl);
const app = await buildApp({
  db,
  verifier: anyVerifier(verifiers),
  corsOrigins: config.corsOrigins,
  logger: { level: process.env.LOG_LEVEL ?? "info" },
});

const shutdown = async () => {
  await app.close();
  await db.destroy();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ port: config.port, host: "0.0.0.0" });
