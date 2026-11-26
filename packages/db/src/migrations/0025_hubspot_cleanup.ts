import { type Kysely, sql } from "kysely";

// HubSpot connector milestone 4: cleanup (docs/hubspot.md, "Cleanup after HubSpot sending").
//
// `integrations.contact_state` remembers, per contact (by email), what the platform did to it in
// the portal, so the cleanup can undo exactly that and nothing else: whether it created the
// contact, whether the contact was a marketing contact before our first HubSpot send, which
// subscription types it unsubscribed and what they were before. A row is written before the
// first send, or by the nightly cleanup for contacts the platform created only for mirroring.
// Rows of contacts the cleanup has finished with (deleted, set back) are removed; `kept` and
// `failed` rows stay, so the sync log can show them and a kept contact is never touched again.
//
// `connection.portal_setup` holds what the setup made or found in the portal (the subscription
// types, the cleanup segments and workflow); `last_cleanup` what the last cleanup run did;
// `cleanup_disconnect_*` an owner's "Clean up and disconnect" while it runs.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE integrations.contact_state (
      tenant_id            uuid NOT NULL,
      connection_id        uuid NOT NULL,
      -- Lower-case email, as integrations.sync_item's contact key.
      email                text NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
      contact_id           text,
      created_by_us        boolean NOT NULL DEFAULT false,
      -- hs_marketable_status before our first HubSpot send; null: never sent to through HubSpot.
      marketable_before    boolean,
      -- Status per subscription type id before the platform changed any, and the ids it changed.
      subscriptions_before jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(subscriptions_before) = 'object'),
      subscriptions_set    text[] NOT NULL DEFAULT '{}',
      marketing_by_us_at   timestamptz,
      needed_until         timestamptz,
      cleanup_status       text NOT NULL DEFAULT 'none' CHECK (cleanup_status IN ('none', 'pending', 'kept', 'failed')),
      cleanup_reason       text,
      cleanup_at           timestamptz,
      created_at           timestamptz NOT NULL DEFAULT now(),
      updated_at           timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (connection_id, email),
      FOREIGN KEY (tenant_id, connection_id) REFERENCES integrations.connection (tenant_id, id) ON DELETE CASCADE
    );
    SELECT platform.enable_tenant_rls('integrations.contact_state');
    CREATE TRIGGER contact_state_updated_at BEFORE UPDATE ON integrations.contact_state FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();
    GRANT SELECT, INSERT, UPDATE, DELETE ON integrations.contact_state TO em_app;

    ALTER TABLE integrations.connection
      ADD COLUMN portal_setup jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(portal_setup) = 'object'),
      ADD COLUMN last_cleanup jsonb CHECK (last_cleanup IS NULL OR jsonb_typeof(last_cleanup) = 'object'),
      ADD COLUMN cleanup_disconnect_requested_at timestamptz,
      ADD COLUMN cleanup_disconnect_requested_by uuid REFERENCES tenancy.user (id);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE integrations.connection
      DROP COLUMN cleanup_disconnect_requested_by,
      DROP COLUMN cleanup_disconnect_requested_at,
      DROP COLUMN last_cleanup,
      DROP COLUMN portal_setup;
    DROP TABLE integrations.contact_state;
  `.execute(db);
}
