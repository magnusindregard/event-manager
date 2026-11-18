// One run of the retention job, for environments where the worker is not always on
// (staging runs it as a Container Apps cron job). Exits non-zero if an account failed.
import { createDb } from "@event-manager/db";
import { runRetention } from "../retention.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = createDb(url, { max: 2 });
try {
  const r = await runRetention(db, new Date(), (m) => console.log(m));
  process.exitCode = r.failed ? 1 : 0;
} finally {
  await db.destroy();
}
