import { type Kysely, sql } from "kysely";

// Registration milestone 4: forms and privacy (docs/registration.md).
//
// An event's registration form is a list of fields, saved as numbered versions so answers
// given to an older form stay readable after it changes. Plain answers are jsonb; sensitive
// ones (dietary needs, free text marked sensitive) are encrypted in the application with
// the tenant's data key, which is stored wrapped by a master key kept outside the database
// (Key Vault), so a database dump alone reveals nothing.
//
// Retention: the account says how long after an occurrence its sensitive answers are kept
// (default 30 days) and when its registrations are anonymised (default 12 months). An
// anonymised registration keeps its row, status and party size, so counts stay exact, but
// loses its name, email and answers.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE tenancy.account
      ADD COLUMN anonymise_after_months      int NOT NULL DEFAULT 12 CHECK (anonymise_after_months BETWEEN 1 AND 120),
      ADD COLUMN sensitive_delete_after_days int NOT NULL DEFAULT 30 CHECK (sensitive_delete_after_days BETWEEN 1 AND 365);

    -- Append-only: saving a changed form adds the next version. No rows: the event has no form fields.
    CREATE TABLE registration.form_version (
      tenant_id  uuid NOT NULL,
      event_id   uuid NOT NULL,
      version    int NOT NULL CHECK (version > 0),
      fields     jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'array'),
      created_by uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (event_id, version),
      FOREIGN KEY (tenant_id, event_id) REFERENCES catalog.event (tenant_id, id) ON DELETE CASCADE
    );
    SELECT platform.enable_tenant_rls('registration.form_version');

    ALTER TABLE registration.registration
      -- The form version the answers were last given to; null before any form.
      ADD COLUMN form_version         int,
      -- When the attendee agreed to sensitive answers being stored.
      ADD COLUMN sensitive_consent_at timestamptz,
      ADD COLUMN anonymised_at        timestamptz,
      ALTER COLUMN name DROP NOT NULL,
      ALTER COLUMN email DROP NOT NULL,
      ADD CONSTRAINT registration_anonymised CHECK ((anonymised_at IS NULL) = (name IS NOT NULL AND email IS NOT NULL));

    CREATE TABLE registration.answer (
      tenant_id       uuid NOT NULL,
      registration_id uuid NOT NULL,
      field_id        text NOT NULL CHECK (length(field_id) BETWEEN 1 AND 40),
      value           jsonb NOT NULL,
      PRIMARY KEY (registration_id, field_id),
      FOREIGN KEY (tenant_id, registration_id) REFERENCES registration.registration (tenant_id, id) ON DELETE CASCADE
    );
    SELECT platform.enable_tenant_rls('registration.answer');

    -- AES-256-GCM under the tenant's data key; the registration and field ids are bound in as
    -- additional data, so a ciphertext cannot be moved to another row.
    CREATE TABLE registration.sensitive_answer (
      tenant_id       uuid NOT NULL,
      registration_id uuid NOT NULL,
      field_id        text NOT NULL CHECK (length(field_id) BETWEEN 1 AND 40),
      ciphertext      bytea NOT NULL,
      created_at      timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (registration_id, field_id),
      FOREIGN KEY (tenant_id, registration_id) REFERENCES registration.registration (tenant_id, id) ON DELETE CASCADE
    );
    SELECT platform.enable_tenant_rls('registration.sensitive_answer');

    -- The tenant's data key, wrapped (AES-256-GCM) by the master key named in master_key_id.
    CREATE TABLE registration.data_key (
      tenant_id     uuid PRIMARY KEY,
      wrapped       bytea NOT NULL,
      master_key_id text NOT NULL CHECK (length(master_key_id) BETWEEN 1 AND 40),
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now()
    );
    SELECT platform.enable_tenant_rls('registration.data_key');

    CREATE INDEX registration_retention ON registration.registration (occurrence_id) WHERE anonymised_at IS NULL;

    GRANT SELECT, INSERT ON registration.form_version TO em_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON registration.answer, registration.sensitive_answer TO em_app;
    GRANT SELECT, INSERT, UPDATE ON registration.data_key TO em_app;

    -- The nightly retention job has no tenant; this lists the accounts, so it can then work
    -- per tenant under RLS.
    CREATE FUNCTION registration.retention_tenants()
      RETURNS SETOF uuid
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, tenancy AS $f$
        SELECT id FROM tenancy.account ORDER BY id
    $f$;
    GRANT CREATE ON SCHEMA registration TO em_definer;
    ALTER FUNCTION registration.retention_tenants() OWNER TO em_definer;
    REVOKE CREATE ON SCHEMA registration FROM em_definer;
    REVOKE ALL ON FUNCTION registration.retention_tenants() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION registration.retention_tenants() TO em_app;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP FUNCTION registration.retention_tenants();
    DROP TABLE registration.data_key;
    DROP TABLE registration.sensitive_answer;
    DROP TABLE registration.answer;
    DROP INDEX registration.registration_retention;
    ALTER TABLE registration.registration
      DROP CONSTRAINT registration_anonymised,
      ALTER COLUMN email SET NOT NULL,
      ALTER COLUMN name SET NOT NULL,
      DROP COLUMN anonymised_at,
      DROP COLUMN sensitive_consent_at,
      DROP COLUMN form_version;
    DROP TABLE registration.form_version;
    ALTER TABLE tenancy.account DROP COLUMN sensitive_delete_after_days, DROP COLUMN anonymise_after_months;
  `.execute(db);
}
