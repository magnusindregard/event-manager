import { useAzureMonitor } from "@azure/monitor-opentelemetry";

if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) useAzureMonitor();

const { run } = await import("graphile-worker");
const { createDb } = await import("@event-manager/db");
const { buildTaskList } = await import("./tasks.js");
const { defaultHandlers } = await import("./handlers.js");
const { provisionDepsFromEnv } = await import("./config.js");
const { HORIZON_CRONTAB } = await import("./horizon.js");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const db = createDb(connectionString);
const runner = await run({
  connectionString,
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 5),
  taskList: buildTaskList(db, defaultHandlers, provisionDepsFromEnv(process.env, (l) => console.log(l))),
  crontab: process.env.WORKER_CRONTAB ?? HORIZON_CRONTAB,
});
await runner.promise;
await db.destroy();
