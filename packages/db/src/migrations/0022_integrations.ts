import { type Kysely, sql } from "kysely";

// HubSpot connector milestone 1: connections (docs/hubspot.md, ADR 0017).
//
// The data key moves from registration to platform: envelope encryption is now shared, so the
// integrations module can encrypt OAuth tokens with the same per-tenant key. The stored format
// and the rows are unchanged; policies and grants move with the table. Apps on the previous
// image keep running while this migrates (scripts/deploy-env.sh), so registration.data_key stays
// as a view over the moved table until a later migration drops it. security_invoker makes the
// caller's role and row-level security apply through it.
//
// A new module, integrations, owns the account's connections to outside systems. One row per
// account and provider; disconnecting keeps the row (who, when, which portal) and deletes the
// credential. Tokens are encrypted in the application, bound to the connection id.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE registration.data_key SET SCHEMA platform;
    CREATE VIEW registration.data_key WITH (security_invoker = true) AS SELECT * FROM platform.data_key;
    GRANT SELECT, INSERT, UPDATE ON registration.data_key TO em_app;

    CREATE SCHEMA integrations;
    GRANT USAGE ON SCHEMA integrations TO em_app, em_definer;

    CREATE TABLE integrations.connection (
      id                  uuid PRIMARY KEY,
      tenant_id           uuid NOT NULL REFERENCES tenancy.account (id),
      provider            text NOT NULL CHECK (provider IN ('hubspot')),
      status              text NOT NULL CHECK (status IN ('active', 'needs_reconnect', 'disconnected')),
      -- The HubSpot portal (hub) id.
      external_account_id text NOT NULL CHECK (length(external_account_id) BETWEEN 1 AND 64),
      scopes              text[] NOT NULL DEFAULT '{}',
      -- Who to sync and other per-account choices; read by the connector.
      settings            jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(settings) = 'object'),
      -- The setup job's last run in the portal (property group, guest key property).
      setup_status        text NOT NULL DEFAULT 'pending' CHECK (setup_status IN ('pending', 'done', 'failed')),
      setup_error         text,
      setup_at            timestamptz,
      -- Why the connection needs reconnecting, as HubSpot said it.
      status_reason       text,
      connected_by        uuid REFERENCES tenancy.user (id),
      connected_at        timestamptz NOT NULL,
      disconnected_at     timestamptz,
      version             int NOT NULL DEFAULT 1,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, provider),
      UNIQUE (tenant_id, id)
    );
    SELECT platform.enable_tenant_rls('integrations.connection');
    CREATE TRIGGER connection_updated_at BEFORE UPDATE ON integrations.connection FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

    -- Refresh and access token as one AES-256-GCM ciphertext under the tenant's data key.
    CREATE TABLE integrations.credential (
      connection_id     uuid PRIMARY KEY,
      tenant_id         uuid NOT NULL,
      ciphertext        bytea NOT NULL,
      access_expires_at timestamptz NOT NULL,
      updated_at        timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (tenant_id, connection_id) REFERENCES integrations.connection (tenant_id, id) ON DELETE CASCADE
    );
    SELECT platform.enable_tenant_rls('integrations.credential');

    GRANT SELECT, INSERT, UPDATE ON integrations.connection TO em_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON integrations.credential TO em_app;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP SCHEMA integrations CASCADE;
    DROP VIEW registration.data_key;
    ALTER TABLE platform.data_key SET SCHEMA registration;
  `.execute(db);
}
