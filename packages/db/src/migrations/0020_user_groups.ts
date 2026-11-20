import { type Kysely, sql } from "kysely";

// User groups milestone 1: groups and access (docs/user-groups.md).
//
// An account's user groups mirror the groups its frontend already has (Member, Sponsor). The
// platform does not authenticate buyers: the channel connector says which group a buyer is in
// when it reserves. Events and offers can be restricted to groups; an empty list is open.
// A reservation records the group it was made for, and each line freezes the group's code.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE catalog.user_group (
      id          uuid PRIMARY KEY,
      tenant_id   uuid NOT NULL REFERENCES tenancy.account (id),
      -- What the frontend and the connector use; cannot change after creation.
      code        text NOT NULL CHECK (code ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
      names       jsonb NOT NULL DEFAULT '{}',
      sort_order  int NOT NULL DEFAULT 0,
      archived_at timestamptz,
      version     int NOT NULL DEFAULT 1,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, code),
      UNIQUE (tenant_id, id)
    );
    SELECT platform.enable_tenant_rls('catalog.user_group');
    CREATE TRIGGER user_group_updated_at BEFORE UPDATE ON catalog.user_group FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

    -- Groups that may attend an event; none means everyone.
    CREATE TABLE catalog.event_access_group (
      tenant_id uuid NOT NULL,
      event_id  uuid NOT NULL,
      group_id  uuid NOT NULL,
      PRIMARY KEY (event_id, group_id),
      FOREIGN KEY (tenant_id, event_id) REFERENCES catalog.event (tenant_id, id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, group_id) REFERENCES catalog.user_group (tenant_id, id)
    );
    CREATE INDEX event_access_group_group ON catalog.event_access_group (group_id);
    SELECT platform.enable_tenant_rls('catalog.event_access_group');

    -- Groups that may buy an offer; none means everyone the event admits.
    CREATE TABLE offers.offer_access_group (
      tenant_id uuid NOT NULL,
      offer_id  uuid NOT NULL,
      group_id  uuid NOT NULL,
      PRIMARY KEY (offer_id, group_id),
      FOREIGN KEY (tenant_id, offer_id) REFERENCES offers.offer (tenant_id, id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, group_id) REFERENCES catalog.user_group (tenant_id, id)
    );
    CREATE INDEX offer_access_group_group ON offers.offer_access_group (group_id);
    SELECT platform.enable_tenant_rls('offers.offer_access_group');

    ALTER TABLE sales.reservation
      ADD COLUMN group_id uuid,
      ADD COLUMN group_code text,
      ADD FOREIGN KEY (tenant_id, group_id) REFERENCES catalog.user_group (tenant_id, id),
      ADD CONSTRAINT reservation_group CHECK ((group_id IS NULL) = (group_code IS NULL));
    -- Part of the snapshot: the line keeps the code it was sold under.
    ALTER TABLE sales.reservation_line ADD COLUMN group_code text;

    GRANT SELECT, INSERT, UPDATE ON catalog.user_group TO em_app;
    GRANT SELECT, INSERT, DELETE ON catalog.event_access_group, offers.offer_access_group TO em_app;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE sales.reservation_line DROP COLUMN group_code;
    ALTER TABLE sales.reservation DROP CONSTRAINT reservation_group, DROP COLUMN group_code, DROP COLUMN group_id;
    DROP TABLE offers.offer_access_group, catalog.event_access_group, catalog.user_group;
  `.execute(db);
}
