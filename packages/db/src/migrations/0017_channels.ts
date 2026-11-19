import { type Kysely, sql } from "kysely";

// Ticketing milestone 2: sales channels, channel keys and SKUs (docs/ticketing.md).
//
// Each account sells through its own channels (its web shop, its POS). A channel holds the
// connector's settings and its keys (sk_<id>_<secret>, a new API key kind). The SKU mapping
// tells the shop which of its products a ticket line is: one SKU per (VAT class, channel).
// Offers name the channels that may sell them and a sales window per occurrence.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- Not used as a literal in this migration (the check below compares text), so it may be
    -- added inside the migration's transaction. IF NOT EXISTS: down cannot drop enum values.
    ALTER TYPE tenancy.api_key_kind ADD VALUE IF NOT EXISTS 'channel';

    CREATE TYPE offers.channel_kind AS ENUM ('ecom', 'pos');

    CREATE TABLE offers.sales_channel (
      id            uuid PRIMARY KEY,
      tenant_id     uuid NOT NULL REFERENCES tenancy.account (id),
      code          text NOT NULL CHECK (code ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
      name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
      kind          offers.channel_kind NOT NULL,
      -- How long a reservation holds its places; extend brings it to at most 60 in total.
      hold_minutes  int NOT NULL DEFAULT 15 CHECK (hold_minutes BETWEEN 1 AND 60),
      -- The platform emails the tickets on confirm when the buyer gives an email.
      send_tickets  boolean NOT NULL DEFAULT false,
      active        boolean NOT NULL DEFAULT true,
      version       int NOT NULL DEFAULT 1,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, code),
      UNIQUE (tenant_id, id)
    );
    SELECT platform.enable_tenant_rls('offers.sales_channel');
    CREATE TRIGGER sales_channel_updated_at BEFORE UPDATE ON offers.sales_channel FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

    -- The shop's product for a ticket line: exempt + web → TICKET-VAT0.
    CREATE TABLE offers.sku_mapping (
      tenant_id    uuid NOT NULL,
      vat_class_id uuid NOT NULL,
      channel_id   uuid NOT NULL,
      external_sku text NOT NULL CHECK (length(external_sku) BETWEEN 1 AND 100),
      updated_at   timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (vat_class_id, channel_id),
      FOREIGN KEY (tenant_id, vat_class_id) REFERENCES offers.vat_class (tenant_id, id),
      FOREIGN KEY (tenant_id, channel_id) REFERENCES offers.sales_channel (tenant_id, id)
    );
    CREATE INDEX sku_mapping_channel ON offers.sku_mapping (channel_id);
    SELECT platform.enable_tenant_rls('offers.sku_mapping');
    CREATE TRIGGER sku_mapping_updated_at BEFORE UPDATE ON offers.sku_mapping FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

    -- Which channels may sell an offer.
    CREATE TABLE offers.offer_channel (
      tenant_id  uuid NOT NULL,
      offer_id   uuid NOT NULL,
      channel_id uuid NOT NULL,
      PRIMARY KEY (offer_id, channel_id),
      FOREIGN KEY (tenant_id, offer_id) REFERENCES offers.offer (tenant_id, id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, channel_id) REFERENCES offers.sales_channel (tenant_id, id)
    );
    CREATE INDEX offer_channel_channel ON offers.offer_channel (channel_id);
    SELECT platform.enable_tenant_rls('offers.offer_channel');

    -- Sales window per occurrence: each bound relative to the start or absolute, not both.
    -- No opening bound: on sale once the event is published. No closing bound: until the start.
    -- Sales never run past the start.
    ALTER TABLE offers.offer
      ADD COLUMN on_sale_min_before  int CHECK (on_sale_min_before BETWEEN 0 AND 525600),
      ADD COLUMN on_sale_at          timestamptz,
      ADD COLUMN off_sale_min_before int CHECK (off_sale_min_before BETWEEN 0 AND 525600),
      ADD COLUMN off_sale_at         timestamptz,
      ADD CHECK (num_nonnulls(on_sale_min_before, on_sale_at) <= 1),
      ADD CHECK (num_nonnulls(off_sale_min_before, off_sale_at) <= 1),
      ADD CHECK (on_sale_min_before IS NULL OR off_sale_min_before IS NULL OR on_sale_min_before > off_sale_min_before),
      ADD CHECK (on_sale_at IS NULL OR off_sale_at IS NULL OR on_sale_at < off_sale_at);

    -- Channel keys belong to one channel; other kinds to none.
    ALTER TABLE tenancy.api_key
      ADD COLUMN channel_id uuid,
      ADD FOREIGN KEY (tenant_id, channel_id) REFERENCES offers.sales_channel (tenant_id, id),
      ADD CHECK ((kind::text = 'channel') = (channel_id IS NOT NULL));
    CREATE INDEX api_key_channel ON tenancy.api_key (channel_id) WHERE channel_id IS NOT NULL;

    GRANT SELECT, INSERT, UPDATE ON offers.sales_channel TO em_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON offers.sku_mapping, offers.offer_channel TO em_app;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DELETE FROM tenancy.api_key WHERE channel_id IS NOT NULL;
    ALTER TABLE tenancy.api_key DROP COLUMN channel_id;
    ALTER TABLE offers.offer
      DROP COLUMN on_sale_min_before, DROP COLUMN on_sale_at, DROP COLUMN off_sale_min_before, DROP COLUMN off_sale_at;
    DROP TABLE offers.offer_channel, offers.sku_mapping, offers.sales_channel;
    DROP TYPE offers.channel_kind;
    -- 'channel' stays on tenancy.api_key_kind; enum values cannot be dropped.
  `.execute(db);
}
