import { type Kysely, sql } from "kysely";

// HubSpot connector milestone 2: contacts, marketing events and attendance (docs/hubspot.md).
//
// One row per thing the platform keeps in step in the provider, per connection: a contact (by
// email), a marketing event (by occurrence) or a contact's attendance at one (by occurrence and
// email). The row is both the id mapping and the pending change: the outbox handler writes what
// it should be and sets `dirty`; the sync job pushes dirty rows in batches and clears the flag.
// So a busy hour costs a few batch calls, a replayed event changes nothing, and a failed push
// stays dirty for the next run.
//
// `created_by_us` (contacts) records whether the platform created the contact in HubSpot, from
// the first upsert's `new` flag. The cleanup (milestone 4) deletes only those, so it is recorded
// from the very first sync.
//
// Rows belong to the connection and go with it: disconnecting deletes them (they are ids in a
// portal the account no longer reaches).
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE integrations.sync_item (
      tenant_id      uuid NOT NULL,
      connection_id  uuid NOT NULL,
      kind           text NOT NULL CHECK (kind IN ('contact', 'marketing_event', 'attendance')),
      -- contact: lower-case email; marketing_event: occurrence id; attendance: occurrence id and email.
      local_key      text NOT NULL CHECK (length(local_key) BETWEEN 1 AND 400),
      -- contact: HubSpot record id; marketing_event: HubSpot object id.
      remote_id      text,
      -- What the item should be in HubSpot (contact: email, name; attendance: occurrence, email, state).
      data           jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(data) = 'object'),
      created_by_us  boolean,
      -- attendance: the state HubSpot has last been told.
      synced_state   text,
      dirty          boolean NOT NULL DEFAULT true,
      attempts       int NOT NULL DEFAULT 0,
      last_error     text,
      last_synced_at timestamptz,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (connection_id, kind, local_key),
      FOREIGN KEY (tenant_id, connection_id) REFERENCES integrations.connection (tenant_id, id) ON DELETE CASCADE
    );
    SELECT platform.enable_tenant_rls('integrations.sync_item');
    CREATE INDEX sync_item_dirty ON integrations.sync_item (connection_id, kind) WHERE dirty;
    CREATE TRIGGER sync_item_updated_at BEFORE UPDATE ON integrations.sync_item FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();
    GRANT SELECT, INSERT, UPDATE, DELETE ON integrations.sync_item TO em_app;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE integrations.sync_item`.execute(db);
}
