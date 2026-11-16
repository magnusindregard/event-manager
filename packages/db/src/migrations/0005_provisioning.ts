import { type Kysely, sql } from "kysely";

// ADR 0012: inviting someone also creates their identity in the Entra External ID tenant
// (a guest for work accounts, a local one-time-passcode account otherwise). The worker does
// the Graph call and records the outcome here, so owners can see and retry it.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TYPE tenancy.signin_kind AS ENUM ('auto', 'work', 'local');
    CREATE TYPE tenancy.provision_status AS ENUM ('pending', 'provisioned', 'failed');

    ALTER TABLE tenancy.invitation
      ADD COLUMN signin_kind        tenancy.signin_kind NOT NULL DEFAULT 'auto',
      ADD COLUMN provision_status   tenancy.provision_status NOT NULL DEFAULT 'pending',
      ADD COLUMN provisioned_kind   text CHECK (provisioned_kind IN ('work', 'local')),
      ADD COLUMN entra_object_id    text,
      ADD COLUMN provision_error    text,
      ADD COLUMN provision_attempts int NOT NULL DEFAULT 0,
      ADD COLUMN provisioned_at     timestamptz,
      ADD COLUMN email_sent_at      timestamptz;

    GRANT UPDATE (signin_kind, provision_status, provisioned_kind, entra_object_id, provision_error,
                  provision_attempts, provisioned_at, email_sent_at) ON tenancy.invitation TO em_app;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE tenancy.invitation
      DROP COLUMN signin_kind, DROP COLUMN provision_status, DROP COLUMN provisioned_kind, DROP COLUMN entra_object_id,
      DROP COLUMN provision_error, DROP COLUMN provision_attempts, DROP COLUMN provisioned_at, DROP COLUMN email_sent_at;
    DROP TYPE tenancy.provision_status;
    DROP TYPE tenancy.signin_kind;
  `.execute(db);
}
