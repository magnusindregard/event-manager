import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "./migrate.js";

export interface TestDatabase {
  container: StartedPostgreSqlContainer;
  migratorUrl: string;
  appUrl: string;
  stop(): Promise<void>;
}

/** Starts Postgres 16, creates the local roles and runs all migrations. */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer("postgres:16").start();
  const migratorUrl = container.getConnectionUri();

  const initSql = await readFile(fileURLToPath(new URL("../local/init-roles.sql", import.meta.url)), "utf8");
  const client = new pg.Client({ connectionString: migratorUrl });
  await client.connect();
  await client.query(initSql);
  await client.end();

  await migrate(migratorUrl);

  const u = new URL(migratorUrl);
  u.username = "app_user";
  u.password = "app_user";
  return { container, migratorUrl, appUrl: u.toString(), stop: async () => void (await container.stop()) };
}
