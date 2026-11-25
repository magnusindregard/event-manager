import { type Kysely, sql } from "kysely";

// HubSpot connector milestone 6: a guest list from a HubSpot list (docs/hubspot.md, "Guest list
// from a HubSpot list"). The list is remembered on the event, so "Refresh from HubSpot" re-runs
// the import. Fetching the members is a worker job; while it runs the row says `fetching`, and
// once done it names the staged import (registration.guest_import) for staff to map, preview
// and commit as for a file. There is no live sync.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE integrations.guest_list_source (
      tenant_id    uuid NOT NULL,
      event_id     uuid NOT NULL,
      provider     text NOT NULL CHECK (provider IN ('hubspot')),
      list_id      text NOT NULL,
      list_name    text NOT NULL,
      status       text NOT NULL DEFAULT 'fetching' CHECK (status IN ('fetching', 'ready', 'failed')),
      -- The staged import the last fetch made; null while fetching, after a failure, or once committed and gone.
      import_id    uuid,
      error        text,
      member_count integer,
      requested_by uuid REFERENCES tenancy.user (id),
      requested_at timestamptz NOT NULL DEFAULT now(),
      fetched_at   timestamptz,
      PRIMARY KEY (tenant_id, event_id),
      FOREIGN KEY (tenant_id, event_id) REFERENCES catalog.event (tenant_id, id) ON DELETE CASCADE
    );
    SELECT platform.enable_tenant_rls('integrations.guest_list_source');
    GRANT SELECT, INSERT, UPDATE, DELETE ON integrations.guest_list_source TO em_app;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE integrations.guest_list_source;`.execute(db);
}
