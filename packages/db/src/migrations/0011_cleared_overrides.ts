import { type Kysely, sql } from "kysely";

// Occurrence overrides for location and external link get a third state (docs/mvp.md,
// "Occurrence"): inherit (override null, not cleared), set (override value) or clear
// (no value even when a rule or the event default has one). A null override alone can
// only mean inherit.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE catalog.occurrence
      ADD COLUMN location_cleared     boolean NOT NULL DEFAULT false,
      ADD COLUMN external_url_cleared boolean NOT NULL DEFAULT false,
      ADD CONSTRAINT occurrence_location_cleared_check CHECK (NOT location_cleared OR location_override_id IS NULL),
      ADD CONSTRAINT occurrence_external_url_cleared_check CHECK (NOT external_url_cleared OR external_url_override IS NULL);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE catalog.occurrence DROP COLUMN location_cleared, DROP COLUMN external_url_cleared;
  `.execute(db);
}
