import { type Kysely, sql } from "kysely";

// HubSpot connector, from the fourth review of PR #116: when HubSpot took a welcome, so the
// worker stops reading a welcome HubSpot never settles after a fixed time from then, as it does
// for invitations (from the send's request).
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE registration.registration ADD COLUMN reminder_status_at timestamptz;`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE registration.registration DROP COLUMN reminder_status_at;`.execute(db);
}
