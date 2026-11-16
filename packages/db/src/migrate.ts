import { Kysely, PostgresDialect, sql } from "kysely";
import { type Migration, type MigrationProvider, Migrator } from "kysely/migration";
import pg from "pg";
import { poolConfig } from "./connection.js";
import { runMigrations as runWorkerMigrations } from "graphile-worker";
import * as m0001 from "./migrations/0001_foundation.js";
import * as m0002 from "./migrations/0002_tenancy.js";
import * as m0003 from "./migrations/0003_outbox.js";

const migrations: Record<string, Migration> = {
  "0001_foundation": m0001,
  "0002_tenancy": m0002,
  "0003_outbox": m0003,
};

const provider: MigrationProvider = { getMigrations: async () => migrations };

/** Runs graphile-worker's schema migrations, then ours. Must use the migrator role. */
export async function migrate(migratorUrl: string): Promise<void> {
  const pool = new pg.Pool(poolConfig(migratorUrl, 1));
  await runWorkerMigrations({ pgPool: pool });

  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  try {
    // em_app may enqueue jobs (outbox trigger) and run the worker.
    await sql`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'em_app') THEN CREATE ROLE em_app NOLOGIN; END IF;
      END $$;
      GRANT USAGE ON SCHEMA graphile_worker TO em_app;
      GRANT ALL ON ALL TABLES IN SCHEMA graphile_worker TO em_app;
      GRANT ALL ON ALL SEQUENCES IN SCHEMA graphile_worker TO em_app;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA graphile_worker TO em_app;
      -- graphile-worker enables RLS on its private tables without policies (owner-only).
      -- The queue is not tenant data; let the runtime role use it.
      DO $$
      DECLARE t record;
      BEGIN
        FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'graphile_worker' AND c.relkind = 'r' AND c.relrowsecurity
                    AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'graphile_worker'
                                      AND p.tablename = c.relname AND p.policyname = 'em_app_all')
        LOOP
          EXECUTE format('CREATE POLICY em_app_all ON graphile_worker.%I TO em_app USING (true) WITH CHECK (true)', t.relname);
        END LOOP;
      END $$;
    `.execute(db);

    const migrator = new Migrator({ db, provider, migrationTableSchema: "platform_migrations" });
    await sql`CREATE SCHEMA IF NOT EXISTS platform_migrations`.execute(db);
    const { error, results } = await migrator.migrateToLatest();
    for (const r of results ?? []) {
      console.log(`migration ${r.migrationName}: ${r.status}`);
    }
    if (error) throw error;

  } finally {
    await db.destroy();
  }

  // Azure: register the apps' managed identity as a Postgres principal in em_app.
  // pgaadauth lives in the "postgres" database; roles are cluster-wide.
  const principal = process.env.APP_DB_PRINCIPAL;
  if (principal) {
    const u = new URL(migratorUrl);
    u.pathname = "/postgres";
    const adminDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: new pg.Pool(poolConfig(u.toString(), 1)) }) });
    try {
      const exists = await sql<{ n: number }>`select count(*)::int as n from pg_roles where rolname = ${principal}`.execute(adminDb);
      if (!exists.rows[0]?.n) await sql`select pgaadauth_create_principal(${principal}, false, false)`.execute(adminDb);
      await sql`GRANT em_app TO ${sql.id(principal)}`.execute(adminDb);
      console.log(`granted em_app to ${principal}`);
    } finally {
      await adminDb.destroy();
    }
  }
}
