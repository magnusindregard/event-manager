import { type Kysely, sql } from "kysely";

// Ticketing milestone 3: reservations, tickets and their admissions (docs/ticketing.md).
//
// A sales channel reserves places while the buyer pays, confirms once it has charged, or
// cancels. Each reservation line freezes what was sold (price, VAT, SKU, line name) when it is
// reserved, so later price changes never reach it. Places are held with one inventory hold per
// pool; confirming turns them into taken places and issues one ticket per unit, each with its
// own admission. Admissions now belong to a registration or a ticket, never both.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE SCHEMA sales;
    GRANT USAGE ON SCHEMA sales TO em_app;

    CREATE TYPE sales.reservation_status AS ENUM ('held', 'confirmed', 'cancelled', 'expired');
    CREATE TYPE sales.ticket_status AS ENUM ('valid', 'cancelled');

    CREATE TABLE sales.reservation (
      id                 uuid PRIMARY KEY,
      tenant_id          uuid NOT NULL,
      channel_id         uuid NOT NULL,
      status             sales.reservation_status NOT NULL DEFAULT 'held',
      -- While held: when the places go back. Extend moves it, to at most 60 minutes after created_at.
      expires_at         timestamptz NOT NULL,
      -- The channel's cart or quote id, and its order once confirmed.
      external_ref       text CHECK (length(external_ref) BETWEEN 1 AND 200),
      external_order_ref text CHECK (length(external_order_ref) BETWEEN 1 AND 200),
      locale             text NOT NULL,
      -- One optional buyer, given on confirm. Personal data.
      buyer_name         text CHECK (length(buyer_name) BETWEEN 1 AND 200),
      buyer_email        text CHECK (buyer_email = lower(buyer_email) AND length(buyer_email) BETWEEN 3 AND 254),
      buyer_locale       text,
      confirmed_at       timestamptz,
      cancelled_at       timestamptz,
      expired_at         timestamptz,
      version            int NOT NULL DEFAULT 1,
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, id),
      CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
      CHECK (status <> 'expired' OR expired_at IS NOT NULL),
      -- A confirmed reservation that is later cancelled keeps its confirmation.
      CHECK (status <> 'confirmed' OR (confirmed_at IS NOT NULL AND external_order_ref IS NOT NULL)),
      FOREIGN KEY (tenant_id, channel_id) REFERENCES offers.sales_channel (tenant_id, id)
    );
    CREATE INDEX reservation_channel ON sales.reservation (channel_id, created_at);
    CREATE INDEX reservation_held_expiry ON sales.reservation (expires_at) WHERE status = 'held';
    SELECT platform.enable_tenant_rls('sales.reservation');
    CREATE TRIGGER reservation_updated_at BEFORE UPDATE ON sales.reservation FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

    -- What was sold, frozen at reserve time (the snapshot). Lines never change afterwards.
    CREATE TABLE sales.reservation_line (
      id                   uuid PRIMARY KEY,
      tenant_id            uuid NOT NULL,
      reservation_id       uuid NOT NULL,
      line_no              int NOT NULL CHECK (line_no > 0),
      occurrence_id        uuid NOT NULL,
      offer_id             uuid NOT NULL,
      quantity             int NOT NULL CHECK (quantity BETWEEN 1 AND 1000),
      places_per_unit      int NOT NULL CHECK (places_per_unit BETWEEN 1 AND 100),
      offer_code           text NOT NULL,
      -- Minor units, VAT included.
      unit_price           int NOT NULL CHECK (unit_price >= 0),
      currency             text NOT NULL,
      vat_class_code       text NOT NULL,
      vat_rate_pct         numeric(5,2) NOT NULL,
      external_sku         text NOT NULL,
      line_name            text NOT NULL,
      occurrence_start_utc timestamptz NOT NULL,
      timezone             text NOT NULL,
      location_name        text,
      UNIQUE (tenant_id, id),
      UNIQUE (reservation_id, line_no),
      FOREIGN KEY (tenant_id, reservation_id) REFERENCES sales.reservation (tenant_id, id) ON DELETE CASCADE,
      -- No cascade: an occurrence or offer that was reserved cannot be deleted.
      FOREIGN KEY (tenant_id, occurrence_id) REFERENCES catalog.occurrence (tenant_id, id),
      FOREIGN KEY (tenant_id, offer_id) REFERENCES offers.offer (tenant_id, id)
    );
    CREATE INDEX reservation_line_occurrence ON sales.reservation_line (occurrence_id);
    CREATE INDEX reservation_line_offer ON sales.reservation_line (offer_id);
    SELECT platform.enable_tenant_rls('sales.reservation_line');

    -- The inventory hold behind a reservation, one per pool (occurrence). hold_id has no foreign
    -- key: the hold row is deleted when it is claimed, released or swept.
    CREATE TABLE sales.reservation_hold (
      tenant_id      uuid NOT NULL,
      reservation_id uuid NOT NULL,
      occurrence_id  uuid NOT NULL,
      hold_id        uuid NOT NULL,
      places         int NOT NULL CHECK (places > 0),
      PRIMARY KEY (reservation_id, occurrence_id),
      FOREIGN KEY (tenant_id, reservation_id) REFERENCES sales.reservation (tenant_id, id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, occurrence_id) REFERENCES catalog.occurrence (tenant_id, id)
    );
    SELECT platform.enable_tenant_rls('sales.reservation_hold');

    -- One per unit of a confirmed line.
    CREATE TABLE sales.ticket (
      id             uuid PRIMARY KEY,
      tenant_id      uuid NOT NULL,
      reservation_id uuid NOT NULL,
      line_id        uuid NOT NULL,
      occurrence_id  uuid NOT NULL,
      offer_id       uuid NOT NULL,
      status         sales.ticket_status NOT NULL DEFAULT 'valid',
      -- Bumped to invalidate the ticket page link and the QR code.
      token_version  int NOT NULL DEFAULT 1,
      cancelled_at   timestamptz,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, id),
      CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
      FOREIGN KEY (tenant_id, reservation_id) REFERENCES sales.reservation (tenant_id, id),
      FOREIGN KEY (tenant_id, line_id) REFERENCES sales.reservation_line (tenant_id, id),
      FOREIGN KEY (tenant_id, occurrence_id) REFERENCES catalog.occurrence (tenant_id, id),
      FOREIGN KEY (tenant_id, offer_id) REFERENCES offers.offer (tenant_id, id)
    );
    CREATE INDEX ticket_reservation ON sales.ticket (reservation_id);
    CREATE INDEX ticket_occurrence ON sales.ticket (occurrence_id);
    SELECT platform.enable_tenant_rls('sales.ticket');
    CREATE TRIGGER ticket_updated_at BEFORE UPDATE ON sales.ticket FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

    -- An admission belongs to a registration or a ticket.
    ALTER TABLE admission.admission
      ALTER COLUMN registration_id DROP NOT NULL,
      ADD COLUMN ticket_id uuid UNIQUE,
      ADD FOREIGN KEY (tenant_id, ticket_id) REFERENCES sales.ticket (tenant_id, id) ON DELETE CASCADE,
      ADD CHECK (num_nonnulls(registration_id, ticket_id) = 1);

    GRANT SELECT, INSERT, UPDATE ON sales.reservation, sales.ticket TO em_app;
    GRANT SELECT, INSERT ON sales.reservation_line TO em_app;
    GRANT SELECT, INSERT, DELETE ON sales.reservation_hold TO em_app;
    GRANT UPDATE (expires_at) ON inventory.hold TO em_app;

    -- The sweeper runs without a tenant; this lists the accounts with held reservations past
    -- their expiry, so it can then work per tenant under RLS.
    GRANT USAGE ON SCHEMA sales TO em_definer;
    GRANT SELECT ON sales.reservation TO em_definer;
    CREATE FUNCTION sales.overdue_reservation_tenants(p_now timestamptz)
      RETURNS SETOF uuid
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, sales AS $f$
        SELECT DISTINCT tenant_id FROM sales.reservation WHERE status = 'held' AND expires_at <= p_now ORDER BY 1
    $f$;
    GRANT CREATE ON SCHEMA sales TO em_definer;
    ALTER FUNCTION sales.overdue_reservation_tenants(timestamptz) OWNER TO em_definer;
    REVOKE CREATE ON SCHEMA sales FROM em_definer;
    REVOKE ALL ON FUNCTION sales.overdue_reservation_tenants(timestamptz) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION sales.overdue_reservation_tenants(timestamptz) TO em_app;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- Give back the places that reservations hold and tickets take.
    UPDATE inventory.capacity_pool p SET held = greatest(p.held - x.n, 0)
      FROM (SELECT h.pool_id, sum(h.quantity)::int AS n FROM inventory.hold h JOIN sales.reservation_hold rh ON rh.hold_id = h.id GROUP BY 1) x
     WHERE p.id = x.pool_id;
    DELETE FROM inventory.hold h USING sales.reservation_hold rh WHERE rh.hold_id = h.id;
    UPDATE inventory.capacity_pool p SET taken = greatest(p.taken - x.n, 0)
      FROM (SELECT t.occurrence_id, sum(l.places_per_unit)::int AS n FROM sales.ticket t JOIN sales.reservation_line l ON l.id = t.line_id
             WHERE t.status = 'valid' GROUP BY 1) x
     WHERE p.occurrence_id = x.occurrence_id;
    REVOKE UPDATE (expires_at) ON inventory.hold FROM em_app;
    DELETE FROM admission.admission WHERE ticket_id IS NOT NULL;
    ALTER TABLE admission.admission DROP COLUMN ticket_id, ALTER COLUMN registration_id SET NOT NULL;
    DROP SCHEMA sales CASCADE;
  `.execute(db);
}
