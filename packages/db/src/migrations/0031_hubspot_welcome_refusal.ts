import { type Kysely, sql } from "kysely";

// HubSpot connector, from the sixth review of PR #116: HubSpot's confirmed refusal of a welcome,
// kept when the platform's own welcome is put off to a later reminder time. The later job then
// sends through the platform on the strength of that answer, without asking HubSpot again, so a
// disconnect in between cannot leave the welcome unresolved.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE registration.registration ADD COLUMN reminder_refusal text;`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE registration.registration DROP COLUMN reminder_refusal;`.execute(db);
}
