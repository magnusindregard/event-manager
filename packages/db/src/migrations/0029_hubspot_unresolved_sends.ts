import { type Kysely, sql } from "kysely";

// HubSpot connector, from the third review of PR #116: a send HubSpot has taken but not yet
// resolved. The portal that took it is kept with HubSpot's status id, so only that portal reads
// the result (a reconnect to another portal does not). `provider_unresolved_at` marks a send the
// worker has stopped checking (our access to that portal went): staff see it, and may send again.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE registration.invitation_send
      ADD COLUMN provider_portal_id text,
      ADD COLUMN provider_unresolved_at timestamptz;
    ALTER TABLE registration.registration ADD COLUMN reminder_portal_id text;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE registration.registration DROP COLUMN reminder_portal_id;
    ALTER TABLE registration.invitation_send DROP COLUMN provider_unresolved_at, DROP COLUMN provider_portal_id;
  `.execute(db);
}
