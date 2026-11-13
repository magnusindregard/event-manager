import { useAzureMonitor } from "@azure/monitor-opentelemetry";

if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) useAzureMonitor();

const { run } = await import("graphile-worker");
const { createDb } = await import("@event-manager/db");
const { buildTaskList } = await import("./tasks.js");
const { defaultHandlers } = await import("./handlers.js");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const db = createDb(connectionString);
const runner = await run({
  connectionString,
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 5),
  taskList: buildTaskList(db, defaultHandlers),
  // Nightly jobs (series horizon) arrive in milestone 3, e.g. "0 2 * * * series.extend_horizons".
  crontab: "",
});
await runner.promise;
await db.destroy();
