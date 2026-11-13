import { type Kysely, sql } from "kysely";

// Roles
//   em_app      – runtime role for api, public-api and worker. Cannot bypass RLS.
//   em_definer  – owns SECURITY DEFINER functions that must read across tenants
//                 (login, invitation acceptance, API key lookup). Gets explicit
//                 permissive policies instead of BYPASSRLS, which Azure does not grant.
// Tables are owned by the migrator. FORCE ROW LEVEL SECURITY means even the owner
// is filtered, so a mis-configured connection cannot leak data.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'em_app') THEN CREATE ROLE em_app NOLOGIN; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'em_definer') THEN CREATE ROLE em_definer NOLOGIN; END IF;
    END $$;
    GRANT em_definer TO current_user;

    CREATE SCHEMA platform;
    GRANT USAGE ON SCHEMA platform TO em_app, em_definer;

    CREATE FUNCTION platform.current_tenant_id() RETURNS uuid
      LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $f$;
    CREATE FUNCTION platform.current_user_id() RETURNS uuid
      LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $f$;

    -- Every tenant-owned table calls this. The RLS test enumerates tables with tenant_id.
    CREATE FUNCTION platform.enable_tenant_rls(tbl regclass) RETURNS void LANGUAGE plpgsql AS $f$
    BEGIN
      EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
      EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %s USING (tenant_id = platform.current_tenant_id()) WITH CHECK (tenant_id = platform.current_tenant_id())',
        tbl);
      EXECUTE format('CREATE POLICY definer_all ON %s TO em_definer USING (true) WITH CHECK (true)', tbl);
    END $f$;

    CREATE FUNCTION platform.set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN NEW.updated_at := now(); RETURN NEW; END $f$;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP SCHEMA platform CASCADE`.execute(db);
}
