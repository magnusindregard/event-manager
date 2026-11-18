import pg from "pg";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "./migrate.js";

export { migrations } from "./migrate.js";

export interface TestDatabase {
  container: StartedPostgreSqlContainer;
  /** Superuser, for test fixtures that must get past RLS or into graphile-worker's tables. */
  superuserUrl: string;
  /** The runtime role (member of em_app), as the apps connect. */
  appUrl: string;
  stop(): Promise<void>;
}

/**
 * Starts Postgres 16 and migrates it the way Azure does: as a migrator that is not a
 * superuser (Azure's Entra administrator is not one) and creates em_app and em_definer
 * itself. Privilege mistakes in migrations then fail here instead of in the first deploy.
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer("postgres:16").start();
  const superuserUrl = container.getConnectionUri();
  const database = container.getDatabase();

  const su = new pg.Client({ connectionString: superuserUrl });
  await su.connect();
  try {
    await su.query(`
      CREATE ROLE migrator LOGIN PASSWORD 'migrator' CREATEROLE NOSUPERUSER;
      GRANT CREATE, CONNECT ON DATABASE "${database}" TO migrator;
      GRANT CREATE ON SCHEMA public TO migrator;
    `);
    const m = new URL(superuserUrl);
    m.username = "migrator";
    m.password = "migrator";
    await migrate(m.toString());
    // Login principals are added afterwards, as pgaadauth_create_principal does in Azure.
    await su.query(`CREATE ROLE app_user LOGIN PASSWORD 'app_user' IN ROLE em_app`);
  } finally {
    await su.end();
  }

  const u = new URL(superuserUrl);
  u.username = "app_user";
  u.password = "app_user";
  return { container, superuserUrl, appUrl: u.toString(), stop: async () => void (await container.stop()) };
}
