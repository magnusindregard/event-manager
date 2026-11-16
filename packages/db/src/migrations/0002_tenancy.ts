import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE SCHEMA tenancy;
    GRANT USAGE ON SCHEMA tenancy TO em_app, em_definer;

    -- Full role model from ADR 0005; the MVP enables owner and editor.
    CREATE TYPE tenancy.role AS ENUM ('owner', 'editor', 'event_manager', 'box_office', 'door_staff', 'finance');
    CREATE TYPE tenancy.api_key_kind AS ENUM ('publishable', 'preview');

    CREATE TABLE tenancy.account (
      id               uuid PRIMARY KEY,
      tenant_id        uuid GENERATED ALWAYS AS (id) STORED,
      slug             text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
      name             text NOT NULL,
      default_timezone text NOT NULL DEFAULT 'Europe/Oslo',
      default_locale   text NOT NULL DEFAULT 'nb',
      locales          text[] NOT NULL DEFAULT ARRAY['nb', 'en'],
      horizon_months   int NOT NULL DEFAULT 18 CHECK (horizon_months BETWEEN 1 AND 60),
      version          int NOT NULL DEFAULT 1,
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_at       timestamptz NOT NULL DEFAULT now(),
      CHECK (default_locale = ANY (locales))
    );
    SELECT platform.enable_tenant_rls('tenancy.account');
    CREATE TRIGGER account_updated_at BEFORE UPDATE ON tenancy.account FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

    -- Staff identities are global (one person can belong to several accounts).
    -- em_app sees a user only if it is the current user or a member of the current tenant.
    CREATE TABLE tenancy."user" (
      id            uuid PRIMARY KEY,
      idp_issuer    text NOT NULL,
      idp_subject   text NOT NULL,
      email         text NOT NULL,
      name          text,
      created_at    timestamptz NOT NULL DEFAULT now(),
      last_login_at timestamptz,
      UNIQUE (idp_issuer, idp_subject)
    );

    CREATE TABLE tenancy.membership (
      id         uuid PRIMARY KEY,
      tenant_id  uuid NOT NULL REFERENCES tenancy.account (id),
      user_id    uuid NOT NULL REFERENCES tenancy."user" (id),
      role       tenancy.role NOT NULL,
      scope_type text CHECK (scope_type IN ('venue', 'event')),
      scope_id   uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK ((scope_type IS NULL) = (scope_id IS NULL)),
      UNIQUE NULLS NOT DISTINCT (tenant_id, user_id, role, scope_type, scope_id)
    );
    SELECT platform.enable_tenant_rls('tenancy.membership');

    ALTER TABLE tenancy."user" ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tenancy."user" FORCE ROW LEVEL SECURITY;
    CREATE POLICY visible_users ON tenancy."user" FOR SELECT TO em_app USING (
      id = platform.current_user_id()
      OR EXISTS (SELECT 1 FROM tenancy.membership m WHERE m.user_id = "user".id)
    );
    CREATE POLICY definer_all ON tenancy."user" TO em_definer USING (true) WITH CHECK (true);

    CREATE TABLE tenancy.invitation (
      id          uuid PRIMARY KEY,
      tenant_id   uuid NOT NULL REFERENCES tenancy.account (id),
      email       text NOT NULL CHECK (email = lower(email)),
      role        tenancy.role NOT NULL,
      invited_by  uuid REFERENCES tenancy."user" (id),
      created_at  timestamptz NOT NULL DEFAULT now(),
      accepted_at timestamptz,
      UNIQUE (tenant_id, email, role)
    );
    SELECT platform.enable_tenant_rls('tenancy.invitation');

    -- Append-only: em_app gets INSERT and SELECT, nothing else.
    CREATE TABLE tenancy.audit_log (
      id              uuid PRIMARY KEY,
      tenant_id       uuid NOT NULL REFERENCES tenancy.account (id),
      actor_user_id   uuid REFERENCES tenancy."user" (id),
      actor_client_id text,
      action          text NOT NULL,
      entity_type     text NOT NULL,
      entity_id       uuid NOT NULL,
      diff            jsonb NOT NULL DEFAULT '{}',
      at              timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX audit_log_entity ON tenancy.audit_log (tenant_id, entity_type, entity_id, at DESC);
    SELECT platform.enable_tenant_rls('tenancy.audit_log');

    CREATE TABLE tenancy.api_key (
      id          uuid PRIMARY KEY,
      tenant_id   uuid NOT NULL REFERENCES tenancy.account (id),
      kind        tenancy.api_key_kind NOT NULL,
      prefix      text NOT NULL UNIQUE,
      secret_hash text NOT NULL,
      label       text NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      revoked_at  timestamptz
    );
    SELECT platform.enable_tenant_rls('tenancy.api_key');

    GRANT SELECT, INSERT, UPDATE ON tenancy.account TO em_app;
    GRANT SELECT ON tenancy."user" TO em_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON tenancy.membership TO em_app;
    GRANT SELECT, INSERT, DELETE ON tenancy.invitation TO em_app;
    GRANT SELECT, INSERT ON tenancy.audit_log TO em_app;
    GRANT SELECT, INSERT, UPDATE ON tenancy.api_key TO em_app;
    GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA tenancy TO em_definer;

    -- Called by the API after it has verified the IdP token. Upserts the user and
    -- turns pending invitations for the verified email into memberships.
    CREATE FUNCTION tenancy.login(p_user_id uuid, p_issuer text, p_subject text, p_email text, p_name text)
    RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, tenancy AS $f$
    DECLARE v_id uuid;
    BEGIN
      INSERT INTO tenancy."user" (id, idp_issuer, idp_subject, email, name, last_login_at)
      VALUES (p_user_id, p_issuer, p_subject, lower(p_email), p_name, now())
      ON CONFLICT (idp_issuer, idp_subject)
        DO UPDATE SET email = excluded.email, name = excluded.name, last_login_at = now()
      RETURNING id INTO v_id;

      INSERT INTO tenancy.membership (id, tenant_id, user_id, role)
      SELECT gen_random_uuid(), i.tenant_id, v_id, i.role
        FROM tenancy.invitation i
       WHERE i.email = lower(p_email) AND i.accepted_at IS NULL
      ON CONFLICT DO NOTHING;

      UPDATE tenancy.invitation SET accepted_at = now()
       WHERE email = lower(p_email) AND accepted_at IS NULL;
      RETURN v_id;
    END $f$;

    CREATE FUNCTION tenancy.my_accounts(p_user_id uuid)
    RETURNS TABLE (account_id uuid, slug text, name text, roles tenancy.role[])
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, tenancy AS $f$
      SELECT a.id, a.slug, a.name, array_agg(DISTINCT m.role ORDER BY m.role)
        FROM tenancy.membership m JOIN tenancy.account a ON a.id = m.tenant_id
       WHERE m.user_id = p_user_id
       GROUP BY a.id, a.slug, a.name
       ORDER BY a.name
    $f$;

    CREATE FUNCTION tenancy.resolve_api_key(p_prefix text)
    RETURNS TABLE (tenant_id uuid, kind tenancy.api_key_kind, secret_hash text)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, tenancy AS $f$
      SELECT k.tenant_id, k.kind, k.secret_hash FROM tenancy.api_key k
       WHERE k.prefix = p_prefix AND k.revoked_at IS NULL
    $f$;

    ALTER FUNCTION tenancy.login(uuid, text, text, text, text) OWNER TO em_definer;
    ALTER FUNCTION tenancy.my_accounts(uuid) OWNER TO em_definer;
    ALTER FUNCTION tenancy.resolve_api_key(text) OWNER TO em_definer;
    REVOKE ALL ON FUNCTION tenancy.login(uuid, text, text, text, text), tenancy.my_accounts(uuid), tenancy.resolve_api_key(text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION tenancy.login(uuid, text, text, text, text), tenancy.my_accounts(uuid), tenancy.resolve_api_key(text) TO em_app;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP SCHEMA tenancy CASCADE`.execute(db);
}
