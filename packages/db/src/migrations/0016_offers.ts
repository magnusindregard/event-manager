import { type Kysely, sql } from "kysely";

// Ticketing milestone 1: offers and prices (docs/ticketing.md).
//
// Ticketed events (admission mode 'tickets') sell offers: ticket types such as Adult or
// Student, each with a VAT class and a default price in minor units, VAT included. Prices
// vary by occurrence through `price` rule effects (target_ref = the offer) and overrides per
// (offer, occurrence); `offerAvailable` effects and overrides take an offer off sale at some
// occurrences. The resolver materializes the result per (occurrence, offer) in
// offers.effective_price, with its source, so reading a price never evaluates rules.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- Not used in this migration, so it may be added inside the migration's transaction.
    -- IF NOT EXISTS: down cannot drop enum values, so up must work after a down.
    ALTER TYPE catalog.admission_mode ADD VALUE IF NOT EXISTS 'tickets';

    CREATE SCHEMA offers;
    GRANT USAGE ON SCHEMA offers TO em_app;

    -- Per account, set up with the client's accountant. A rate in use by an offer is not
    -- changed; a new class is added and offers move to it, so sold lines keep their rate.
    CREATE TABLE offers.vat_class (
      id          uuid PRIMARY KEY,
      tenant_id   uuid NOT NULL REFERENCES tenancy.account (id),
      code        text NOT NULL CHECK (code ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
      label       text NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
      rate_pct    numeric(5, 2) NOT NULL CHECK (rate_pct BETWEEN 0 AND 100),
      archived_at timestamptz,
      version     int NOT NULL DEFAULT 1,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, code),
      UNIQUE (tenant_id, id)
    );
    SELECT platform.enable_tenant_rls('offers.vat_class');
    CREATE TRIGGER vat_class_updated_at BEFORE UPDATE ON offers.vat_class FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

    CREATE TYPE offers.offer_status AS ENUM ('active', 'archived');

    CREATE TABLE offers.offer (
      id                 uuid PRIMARY KEY,
      tenant_id          uuid NOT NULL,
      event_id           uuid NOT NULL,
      -- Stable, for connectors (SKU mapping and reservations arrive in later milestones).
      code               text NOT NULL CHECK (code ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
      vat_class_id       uuid NOT NULL,
      sort_order         int NOT NULL DEFAULT 0,
      status             offers.offer_status NOT NULL DEFAULT 'active',
      -- A family ticket takes 4 places and gives one admission with party size 4.
      places_per_unit    int NOT NULL DEFAULT 1 CHECK (places_per_unit BETWEEN 1 AND 100),
      min_per_reservation int NOT NULL DEFAULT 1 CHECK (min_per_reservation BETWEEN 1 AND 1000),
      max_per_reservation int NOT NULL DEFAULT 20 CHECK (max_per_reservation BETWEEN 1 AND 1000),
      -- Minor units (øre), VAT included, in the account's currency.
      default_price      int NOT NULL CHECK (default_price BETWEEN 0 AND 100000000),
      version            int NOT NULL DEFAULT 1,
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, id),
      UNIQUE (event_id, code),
      CHECK (min_per_reservation <= max_per_reservation),
      FOREIGN KEY (tenant_id, event_id) REFERENCES catalog.event (tenant_id, id),
      FOREIGN KEY (tenant_id, vat_class_id) REFERENCES offers.vat_class (tenant_id, id)
    );
    CREATE INDEX offer_event ON offers.offer (event_id, sort_order);
    CREATE INDEX offer_vat_class ON offers.offer (vat_class_id);
    SELECT platform.enable_tenant_rls('offers.offer');
    CREATE TRIGGER offer_updated_at BEFORE UPDATE ON offers.offer FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

    CREATE TABLE offers.offer_translation (
      tenant_id   uuid NOT NULL,
      offer_id    uuid NOT NULL,
      locale      text NOT NULL,
      name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
      description text CHECK (length(description) <= 2000),
      PRIMARY KEY (offer_id, locale),
      FOREIGN KEY (tenant_id, offer_id) REFERENCES offers.offer (tenant_id, id) ON DELETE CASCADE
    );
    SELECT platform.enable_tenant_rls('offers.offer_translation');

    -- One offer at one occurrence: a price, an availability, or both. Null inherits.
    CREATE TABLE offers.offer_override (
      tenant_id     uuid NOT NULL,
      offer_id      uuid NOT NULL,
      occurrence_id uuid NOT NULL,
      amount        int CHECK (amount BETWEEN 0 AND 100000000),
      available     boolean,
      PRIMARY KEY (offer_id, occurrence_id),
      FOREIGN KEY (tenant_id, offer_id) REFERENCES offers.offer (tenant_id, id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, occurrence_id) REFERENCES catalog.occurrence (tenant_id, id) ON DELETE CASCADE,
      CHECK (amount IS NOT NULL OR available IS NOT NULL)
    );
    CREATE INDEX offer_override_occurrence ON offers.offer_override (occurrence_id);
    SELECT platform.enable_tenant_rls('offers.offer_override');

    -- Materialized by the resolver, like rules.effective_value. Rule ids have no foreign key
    -- for the same reason: a deleted rule's values are served until the event is resolved again.
    CREATE TABLE offers.effective_price (
      tenant_id        uuid NOT NULL,
      occurrence_id    uuid NOT NULL,
      offer_id         uuid NOT NULL,
      amount           int NOT NULL,
      amount_source    rules.value_source NOT NULL,
      amount_rule_id   uuid,
      available        boolean NOT NULL,
      available_source rules.value_source NOT NULL,
      available_rule_id uuid,
      PRIMARY KEY (occurrence_id, offer_id),
      FOREIGN KEY (tenant_id, occurrence_id) REFERENCES catalog.occurrence (tenant_id, id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, offer_id) REFERENCES offers.offer (tenant_id, id) ON DELETE CASCADE,
      CHECK ((amount_source = 'rule') = (amount_rule_id IS NOT NULL)),
      CHECK ((available_source = 'rule') = (available_rule_id IS NOT NULL))
    );
    CREATE INDEX effective_price_offer ON offers.effective_price (offer_id);
    SELECT platform.enable_tenant_rls('offers.effective_price');

    GRANT SELECT, INSERT, UPDATE ON offers.vat_class TO em_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON offers.offer, offers.offer_translation, offers.offer_override, offers.effective_price TO em_app;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DELETE FROM rules.rule_effect WHERE effect_type IN ('price', 'offerAvailable');
    DROP SCHEMA offers CASCADE;
    -- Enum values cannot be dropped; 'tickets' stays on catalog.admission_mode. Ticketed events
    -- fall back to no admission.
    UPDATE catalog.event SET admission_mode = 'none' WHERE admission_mode = 'tickets';
  `.execute(db);
}
