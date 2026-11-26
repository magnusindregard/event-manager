import { type Kysely, sql } from "kysely";

// HubSpot connector, fixes from the review of PR #116.
//
// `contact_state.prepared_at`: when the platform finished preparing a contact for its first
// HubSpot send (unsubscribed from the other subscription types, put in the temporary segment).
// What the contact was is recorded before those writes, so the cleanup can undo a half-done
// preparation; until `prepared_at` is set, a retried send finishes the writes before sending.
// Rows from before this migration were prepared in one go and count as done.
//
// One live connection per portal across accounts: two accounts on one portal would each prepare
// and clean up the same contacts, and one's cleanup could undo what the other still needs. The
// index sees every account's rows, whatever row-level security shows a transaction.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE integrations.contact_state ADD COLUMN prepared_at timestamptz;
    UPDATE integrations.contact_state SET prepared_at = created_at WHERE marketable_before IS NOT NULL;
    CREATE UNIQUE INDEX connection_portal_live ON integrations.connection (provider, external_account_id) WHERE status <> 'disconnected';
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP INDEX integrations.connection_portal_live;
    ALTER TABLE integrations.contact_state DROP COLUMN prepared_at;
  `.execute(db);
}
