import { migrate } from "./migrate.js";

const url = process.env.MIGRATOR_DATABASE_URL;
if (!url) {
  console.error("MIGRATOR_DATABASE_URL is required");
  process.exit(1);
}
await migrate(url);
