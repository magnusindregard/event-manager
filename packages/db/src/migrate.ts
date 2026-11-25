import { Kysely, PostgresDialect, sql } from "kysely";
import { type Migration, type MigrationProvider, Migrator } from "kysely/migration";
import pg from "pg";
import { poolConfig } from "./connection.js";
import { runMigrations as runWorkerMigrations } from "graphile-worker";
import * as m0001 from "./migrations/0001_foundation.js";
import * as m0002 from "./migrations/0002_tenancy.js";
import * as m0003 from "./migrations/0003_outbox.js";
import * as m0004 from "./migrations/0004_catalog.js";
import * as m0005 from "./migrations/0005_provisioning.js";
import * as m0006 from "./migrations/0006_series.js";
import * as m0007 from "./migrations/0007_rules.js";
import * as m0008 from "./migrations/0008_capacity.js";
import * as m0009 from "./migrations/0009_registration.js";
import * as m0011 from "./migrations/0011_cleared_overrides.js";
import * as m0012 from "./migrations/0012_invitations.js";
import * as m0013 from "./migrations/0013_forms_privacy.js";
import * as m0014 from "./migrations/0014_reinvite.js";
import * as m0015 from "./migrations/0015_waitlist.js";
import * as m0016 from "./migrations/0016_offers.js";
import * as m0017 from "./migrations/0017_channels.js";
import * as m0018 from "./migrations/0018_reservations.js";
import * as m0019 from "./migrations/0019_after_sale.js";
import * as m0020 from "./migrations/0020_user_groups.js";
import * as m0021 from "./migrations/0021_group_prices.js";
import * as m0022 from "./migrations/0022_integrations.js";
import * as m0023 from "./migrations/0023_hubspot_sync.js";
import * as m0024 from "./migrations/0024_hubspot_segments.js";
import * as m0025 from "./migrations/0025_hubspot_cleanup.js";
import * as m0026 from "./migrations/0026_hubspot_sending.js";
import * as m0027 from "./migrations/0027_hubspot_guest_lists.js";
import * as m0028 from "./migrations/0028_hubspot_review_fixes.js";
import * as m0029 from "./migrations/0029_hubspot_unresolved_sends.js";
import * as m0030 from "./migrations/0030_hubspot_welcome_deadline.js";

/** By name, in order. Exported for tests that run one migration down and up again. */
export const migrations: Record<string, Migration> = {
  "0001_foundation": m0001,
  "0002_tenancy": m0002,
  "0003_outbox": m0003,
  "0004_catalog": m0004,
  "0005_provisioning": m0005,
  "0006_series": m0006,
  "0007_rules": m0007,
  "0008_capacity": m0008,
  "0009_registration": m0009,
  "0011_cleared_overrides": m0011,
  "0012_invitations": m0012,
  "0013_forms_privacy": m0013,
  "0014_reinvite": m0014,
  "0015_waitlist": m0015,
  "0016_offers": m0016,
  "0017_channels": m0017,
  "0018_reservations": m0018,
  "0019_after_sale": m0019,
  "0020_user_groups": m0020,
  "0021_group_prices": m0021,
  "0022_integrations": m0022,
  "0023_hubspot_sync": m0023,
  "0024_hubspot_segments": m0024,
  "0025_hubspot_cleanup": m0025,
  "0026_hubspot_sending": m0026,
  "0027_hubspot_guest_lists": m0027,
  "0028_hubspot_review_fixes": m0028,
  "0029_hubspot_unresolved_sends": m0029,
  "0030_hubspot_welcome_deadline": m0030,
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
