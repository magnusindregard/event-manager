import { type Kysely, sql } from "kysely";

// Hosted checkout milestone 1 (docs/checkout.md, ADR 0018): payments with Vipps MobilePay.
//
// The client's Vipps keys are encrypted with the account's data key (platform.data_key, shared
// since 0022_integrations).
//
// A new module, payments, holds each account's provider account (its own Vipps merchant: the
// platform initiates payments on the client's behalf and never holds money), one payment per
// hosted reservation, and the refunds made against it. Keys and webhook secrets are encrypted in
// the application, bound to the provider account's id.
//
// The account gets merchant details for receipts.
//
// Sales channels get a new kind, hosted: the platform's own checkout, at most one per account.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- Not used as a literal in this migration, so it may be added inside the migration's
    -- transaction. IF NOT EXISTS: down cannot drop enum values.
    ALTER TYPE offers.channel_kind ADD VALUE IF NOT EXISTS 'hosted';
    -- At most one hosted channel per account. A new enum value cannot be named in the
    -- transaction that adds it, and a cast to text is not immutable, so the predicate uses
    -- the sort order instead: values sort in the order they were added, and 'hosted' is the
    -- only one after 'pos'. Restate this as kind = 'hosted' before adding another kind.
    CREATE UNIQUE INDEX sales_channel_one_hosted ON offers.sales_channel (tenant_id) WHERE kind > 'pos';

    -- Merchant details printed on receipts. Optional until the account sells through the hosted checkout.
    ALTER TABLE tenancy.account
      ADD COLUMN merchant_legal_name    text CHECK (length(merchant_legal_name) BETWEEN 1 AND 200),
      ADD COLUMN merchant_org_number    text CHECK (merchant_org_number ~ '^[0-9]{9}$'),
      ADD COLUMN merchant_address       text CHECK (length(merchant_address) BETWEEN 1 AND 500),
      ADD COLUMN merchant_vat_registered boolean NOT NULL DEFAULT false;

    CREATE SCHEMA payments;
    GRANT USAGE ON SCHEMA payments TO em_app, em_definer;

    CREATE TABLE payments.provider_account (
      id                     uuid PRIMARY KEY,
      tenant_id              uuid NOT NULL REFERENCES tenancy.account (id),
      provider               text NOT NULL CHECK (provider IN ('vipps')),
      environment            text NOT NULL CHECK (environment IN ('test', 'production')),
      merchant_serial_number text NOT NULL CHECK (merchant_serial_number ~ '^[0-9]{4,10}$'),
      client_id              text NOT NULL CHECK (length(client_id) BETWEEN 1 AND 200),
      -- {clientSecret, subscriptionKey}, encrypted with the account's data key. Removed on disconnect.
      credentials            bytea,
      -- The webhook registered at the provider, and its signing secret (encrypted).
      webhook_id             text CHECK (length(webhook_id) BETWEEN 1 AND 200),
      webhook_secret         bytea,
      status                 text NOT NULL CHECK (status IN ('active', 'invalid', 'disconnected')),
      status_reason          text CHECK (length(status_reason) BETWEEN 1 AND 500),
      verified_at            timestamptz,
      connected_by           uuid,
      connected_at           timestamptz NOT NULL,
      disconnected_at        timestamptz,
      version                int NOT NULL DEFAULT 1,
      created_at             timestamptz NOT NULL DEFAULT now(),
      updated_at             timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, id),
      CHECK ((status = 'disconnected') = (disconnected_at IS NOT NULL)),
      CHECK (status = 'disconnected' OR credentials IS NOT NULL),
      CHECK ((webhook_id IS NULL) = (webhook_secret IS NULL))
    );
    -- One connected account per provider; disconnected ones stay as history.
    CREATE UNIQUE INDEX provider_account_connected ON payments.provider_account (tenant_id, provider) WHERE status <> 'disconnected';
    SELECT platform.enable_tenant_rls('payments.provider_account');
    CREATE TRIGGER provider_account_updated_at BEFORE UPDATE ON payments.provider_account FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

    -- One payment per hosted reservation. The reference is the provider's id for it and the
    -- reservation's external order ref once confirmed.
    CREATE TABLE payments.payment (
      id                  uuid PRIMARY KEY,
      tenant_id           uuid NOT NULL,
      provider_account_id uuid NOT NULL,
      reservation_id      uuid NOT NULL,
      provider            text NOT NULL CHECK (provider IN ('vipps')),
      reference           text NOT NULL UNIQUE CHECK (reference ~ '^[A-Za-z0-9-]{8,64}$'),
      -- Minor units, VAT included: the reservation's total when it was created.
      amount              int NOT NULL CHECK (amount > 0),
      currency            text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
      state               text NOT NULL DEFAULT 'created' CHECK (state IN ('created', 'authorized', 'captured', 'cancelled', 'expired', 'failed')),
      -- Where the buyer approves the payment, and what the provider said last.
      redirect_url        text,
      aggregate           jsonb,
      -- The buyer from the checkout form, given to confirm (the tickets email) and on the receipt. Personal data.
      buyer_name          text CHECK (length(buyer_name) BETWEEN 1 AND 200),
      buyer_email         text CHECK (buyer_email = lower(buyer_email) AND length(buyer_email) BETWEEN 3 AND 254),
      buyer_phone         text CHECK (buyer_phone ~ '^[0-9]{8,15}$'),
      -- Sent: the receipt email, and the receipt in the Vipps app.
      receipt_sent_at     timestamptz,
      failure_reason      text CHECK (length(failure_reason) BETWEEN 1 AND 500),
      authorized_at       timestamptz,
      captured_at         timestamptz,
      cancelled_at        timestamptz,
      version             int NOT NULL DEFAULT 1,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, id),
      UNIQUE (reservation_id),
      FOREIGN KEY (tenant_id, provider_account_id) REFERENCES payments.provider_account (tenant_id, id),
      FOREIGN KEY (tenant_id, reservation_id) REFERENCES sales.reservation (tenant_id, id)
    );
    -- The reconcile job looks for payments that have not settled.
    CREATE INDEX payment_open ON payments.payment (updated_at) WHERE state IN ('created', 'authorized');
    SELECT platform.enable_tenant_rls('payments.payment');
    CREATE TRIGGER payment_updated_at BEFORE UPDATE ON payments.payment FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

    -- Money given back for cancelled tickets. The idempotency key makes a retried refund safe.
    CREATE TABLE payments.refund (
      id              uuid PRIMARY KEY,
      tenant_id       uuid NOT NULL,
      payment_id      uuid NOT NULL,
      amount          int NOT NULL CHECK (amount > 0),
      ticket_ids      uuid[] NOT NULL DEFAULT '{}',
      idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 100),
      state           text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done', 'failed')),
      failure_reason  text CHECK (length(failure_reason) BETWEEN 1 AND 500),
      created_by      uuid,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (tenant_id, payment_id) REFERENCES payments.payment (tenant_id, id)
    );
    CREATE INDEX refund_payment ON payments.refund (payment_id);
    CREATE INDEX refund_pending ON payments.refund (updated_at) WHERE state = 'pending';
    SELECT platform.enable_tenant_rls('payments.refund');
    CREATE TRIGGER refund_updated_at BEFORE UPDATE ON payments.refund FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

    GRANT SELECT, INSERT, UPDATE ON payments.provider_account, payments.payment, payments.refund TO em_app;

    -- The reconcile job finds accounts with payments that have not settled, or refunds Vipps
    -- did not answer, across tenants.
    GRANT SELECT ON payments.payment, payments.refund TO em_definer;
    CREATE FUNCTION payments.open_payment_tenants(p_before timestamptz)
      RETURNS SETOF uuid
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, payments AS $f$
        SELECT tenant_id FROM payments.payment WHERE state IN ('created', 'authorized') AND updated_at <= p_before
        UNION
        SELECT tenant_id FROM payments.refund WHERE state = 'pending' AND updated_at <= p_before
        ORDER BY 1
    $f$;
    GRANT CREATE ON SCHEMA payments TO em_definer;
    ALTER FUNCTION payments.open_payment_tenants(timestamptz) OWNER TO em_definer;
    REVOKE CREATE ON SCHEMA payments FROM em_definer;
    REVOKE ALL ON FUNCTION payments.open_payment_tenants(timestamptz) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION payments.open_payment_tenants(timestamptz) TO em_app;

    -- The buy page (/b/{occurrence}) knows only the occurrence id. This finds its tenant, and
    -- only for occurrences of published ticketed events, so it reveals nothing the public API does not.
    CREATE FUNCTION payments.checkout_occurrence_tenant(p_occurrence uuid)
      RETURNS uuid
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, catalog AS $f$
        SELECT o.tenant_id
          FROM catalog.occurrence o
          JOIN catalog.event e ON e.tenant_id = o.tenant_id AND e.id = o.event_id
         WHERE o.id = p_occurrence AND e.status IN ('published', 'cancelled') AND e.admission_mode::text = 'tickets'
    $f$;
    GRANT CREATE ON SCHEMA payments TO em_definer;
    ALTER FUNCTION payments.checkout_occurrence_tenant(uuid) OWNER TO em_definer;
    REVOKE CREATE ON SCHEMA payments FROM em_definer;
    REVOKE ALL ON FUNCTION payments.checkout_occurrence_tenant(uuid) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION payments.checkout_occurrence_tenant(uuid) TO em_app;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP SCHEMA payments CASCADE;
    ALTER TABLE tenancy.account
      DROP COLUMN merchant_legal_name, DROP COLUMN merchant_org_number, DROP COLUMN merchant_address, DROP COLUMN merchant_vat_registered;
    DROP INDEX offers.sales_channel_one_hosted;
    -- 'hosted' stays on offers.channel_kind; enum values cannot be dropped.
  `.execute(db);
}
