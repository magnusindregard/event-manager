import { type Kysely, sql } from "kysely";

// Registration milestone 1: capacity (docs/registration.md, "Capacity and holds").
//
// Events gain registration settings and a default capacity; occurrences a capacity
// override. capacity and overbooking are rule effects, materialized in effective_value
// like location and tags. The inventory module keeps one capacity pool per occurrence of
// a registration event, and holds against it; places are taken with a conditional update
// (ADR 0003), so two people can never both get the last place.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- Not used in this migration, so it may be added inside the migration's transaction.
    ALTER TYPE catalog.admission_mode ADD VALUE 'registration';
    CREATE TYPE catalog.access_policy AS ENUM ('open', 'invite_only');

    ALTER TABLE catalog.event
      ADD COLUMN access_policy           catalog.access_policy NOT NULL DEFAULT 'open',
      ADD COLUMN listed                  boolean NOT NULL DEFAULT true,
      -- Null: places without limit.
      ADD COLUMN capacity                int CHECK (capacity BETWEEN 0 AND 1000000),
      ADD COLUMN overbooking_pct         int NOT NULL DEFAULT 0 CHECK (overbooking_pct BETWEEN 0 AND 100),
      ADD COLUMN guest_allowed           boolean NOT NULL DEFAULT false,
      -- Relative to each occurrence's start. Opens: null means as soon as the event is published.
      ADD COLUMN registration_opens_min  int CHECK (registration_opens_min BETWEEN 0 AND 525600),
      ADD COLUMN registration_closes_min int NOT NULL DEFAULT 0 CHECK (registration_closes_min BETWEEN 0 AND 525600),
      ADD COLUMN waitlist_enabled        boolean NOT NULL DEFAULT false,
      ADD COLUMN claim_window_min        int NOT NULL DEFAULT 1440 CHECK (claim_window_min BETWEEN 5 AND 20160),
      ADD COLUMN waitlist_cutoff_min     int NOT NULL DEFAULT 120 CHECK (waitlist_cutoff_min BETWEEN 0 AND 20160),
      ADD CHECK (registration_opens_min IS NULL OR registration_opens_min > registration_closes_min);

    ALTER TABLE catalog.occurrence
      ADD COLUMN capacity_override      int CHECK (capacity_override BETWEEN 0 AND 1000000),
      ADD COLUMN access_policy_override catalog.access_policy;

    ALTER TABLE rules.effective_value DROP CONSTRAINT effective_value_field_check;
    ALTER TABLE rules.effective_value ADD CONSTRAINT effective_value_field_check
      CHECK (field IN ('location', 'tags', 'externalUrl', 'capacity', 'overbooking'));

    CREATE SCHEMA inventory;
    GRANT USAGE ON SCHEMA inventory TO em_app;

    -- One pool per occurrence for now; offers will reference pools by id later.
    CREATE TABLE inventory.capacity_pool (
      id              uuid PRIMARY KEY,
      tenant_id       uuid NOT NULL,
      occurrence_id   uuid NOT NULL,
      -- Null: no limit.
      capacity        int CHECK (capacity >= 0),
      overbooking_pct int NOT NULL DEFAULT 0 CHECK (overbooking_pct BETWEEN 0 AND 100),
      bookable_limit  int GENERATED ALWAYS AS (floor(capacity * (100 + overbooking_pct) / 100.0)::int) STORED,
      held            int NOT NULL DEFAULT 0 CHECK (held >= 0),
      taken           int NOT NULL DEFAULT 0 CHECK (taken >= 0),
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, id),
      UNIQUE (occurrence_id),
      -- Pools go with their occurrence. Registrations (milestone 2) will keep occurrences
      -- that have them from being deleted.
      FOREIGN KEY (tenant_id, occurrence_id) REFERENCES catalog.occurrence (tenant_id, id) ON DELETE CASCADE
      -- No check that held + taken fits the limit: lowering capacity below what is taken is
      -- allowed (and flagged); the conditional update in the domain guards new places.
    );
    SELECT platform.enable_tenant_rls('inventory.capacity_pool');
    CREATE TRIGGER capacity_pool_updated_at BEFORE UPDATE ON inventory.capacity_pool FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

    -- Places set aside until expires_at, e.g. a waitlist offer. The sweeper releases expired holds.
    CREATE TABLE inventory.hold (
      id          uuid PRIMARY KEY,
      tenant_id   uuid NOT NULL,
      pool_id     uuid NOT NULL,
      quantity    int NOT NULL CHECK (quantity > 0),
      expires_at  timestamptz NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, id),
      FOREIGN KEY (tenant_id, pool_id) REFERENCES inventory.capacity_pool (tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX hold_expiry ON inventory.hold (expires_at);
    SELECT platform.enable_tenant_rls('inventory.hold');

    GRANT SELECT, INSERT, UPDATE ON inventory.capacity_pool TO em_app;
    GRANT SELECT, INSERT, DELETE ON inventory.hold TO em_app;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP SCHEMA inventory CASCADE;
    DELETE FROM rules.effective_value WHERE field IN ('capacity', 'overbooking');
    ALTER TABLE rules.effective_value DROP CONSTRAINT effective_value_field_check;
    ALTER TABLE rules.effective_value ADD CONSTRAINT effective_value_field_check CHECK (field IN ('location', 'tags', 'externalUrl'));
    ALTER TABLE catalog.occurrence DROP COLUMN capacity_override, DROP COLUMN access_policy_override;
    ALTER TABLE catalog.event
      DROP COLUMN access_policy, DROP COLUMN listed, DROP COLUMN capacity, DROP COLUMN overbooking_pct,
      DROP COLUMN guest_allowed, DROP COLUMN registration_opens_min, DROP COLUMN registration_closes_min,
      DROP COLUMN waitlist_enabled, DROP COLUMN claim_window_min, DROP COLUMN waitlist_cutoff_min;
    DROP TYPE catalog.access_policy;
    -- Enum values cannot be dropped; 'registration' stays on catalog.admission_mode.
  `.execute(db);
}
