import { type Kysely, sql } from "kysely";

// HubSpot connector milestone 3: segments (docs/hubspot.md, "Segments").
//
// Two more kinds of integrations.sync_item:
// - `segment`: a static segment (HubSpot list) per event and role, keyed `<event>:awaiting` or
//   `<event>:confirmed:<occurrence>`, with the list id as remote_id. Dirty means "make sure it
//   exists", or with `data.deleted` "delete it" (the event was archived).
// - `segment_member`: a contact's membership of one, keyed `<segment key>|<email>`, with
//   `data.member` what it should be and `synced_state` (`in`/`out`) what HubSpot was last told,
//   like attendance.
//
// `connection.last_reconcile` holds what the nightly reconcile found and fixed, for the sync log.
// `integrations.connected_tenants()` lists the accounts with a live connection, for that job.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE integrations.sync_item DROP CONSTRAINT sync_item_kind_check;
    ALTER TABLE integrations.sync_item ADD CONSTRAINT sync_item_kind_check
      CHECK (kind IN ('contact', 'marketing_event', 'attendance', 'segment', 'segment_member'));

    ALTER TABLE integrations.connection ADD COLUMN last_reconcile jsonb
      CHECK (last_reconcile IS NULL OR jsonb_typeof(last_reconcile) = 'object');

    CREATE FUNCTION integrations.connected_tenants(p_provider text)
      RETURNS SETOF uuid
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, integrations AS $f$
        SELECT tenant_id FROM integrations.connection WHERE provider = p_provider AND status = 'active' ORDER BY tenant_id
    $f$;
    GRANT SELECT ON integrations.connection TO em_definer;
    GRANT CREATE ON SCHEMA integrations TO em_definer;
    ALTER FUNCTION integrations.connected_tenants(text) OWNER TO em_definer;
    REVOKE CREATE ON SCHEMA integrations FROM em_definer;
    REVOKE ALL ON FUNCTION integrations.connected_tenants(text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION integrations.connected_tenants(text) TO em_app;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP FUNCTION integrations.connected_tenants(text);
    REVOKE SELECT ON integrations.connection FROM em_definer;
    ALTER TABLE integrations.connection DROP COLUMN last_reconcile;
    DELETE FROM integrations.sync_item WHERE kind IN ('segment', 'segment_member');
    ALTER TABLE integrations.sync_item DROP CONSTRAINT sync_item_kind_check;
    ALTER TABLE integrations.sync_item ADD CONSTRAINT sync_item_kind_check CHECK (kind IN ('contact', 'marketing_event', 'attendance'));
  `.execute(db);
}
