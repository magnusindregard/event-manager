import { type Kysely, sql } from "kysely";

// Registration milestone 5: the waitlist (docs/registration.md, "Waitlist").
//
// A registration that finds the occurrence full joins the waitlist (status waitlisted) when the
// event has one. Its place in line is waitlist_position, drawn from a sequence, so two people
// joining at once never share a position; the attendee is shown their rank among those still
// waiting. When places come free, the first in line whose party fits gets an offer (status
// offered): a hold on the pool (inventory.hold) that expires at offer_expires_at. Claiming turns
// the hold into taken places and confirms the registration; an offer that is not claimed in time
// is cancelled with cancelled_by 'expired' and the places go to the next in line.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE SEQUENCE registration.waitlist_seq AS bigint;
    GRANT USAGE ON SEQUENCE registration.waitlist_seq TO em_app;

    ALTER TABLE registration.registration
      ALTER COLUMN waitlist_position TYPE bigint,
      -- The hold behind an offer. No foreign key: holds belong to the inventory module, which
      -- deletes them when they are claimed or released.
      ADD COLUMN offer_hold_id    uuid,
      ADD COLUMN offer_expires_at timestamptz,
      -- When the registration got its places: at once, or when a waitlist offer was claimed.
      ADD COLUMN confirmed_at     timestamptz,
      DROP CONSTRAINT registration_cancelled_by_check,
      ADD CONSTRAINT registration_cancelled_by_check CHECK (cancelled_by IN ('attendee', 'staff', 'expired')),
      ADD CONSTRAINT registration_offer CHECK ((status = 'offered') = (offer_expires_at IS NOT NULL AND offer_hold_id IS NOT NULL)),
      ADD CONSTRAINT registration_waitlist_position CHECK ((status IN ('waitlisted', 'offered')) = (waitlist_position IS NOT NULL));

    UPDATE registration.registration SET confirmed_at = created_at WHERE status = 'confirmed';

    -- The line, in order, for promotion and for showing positions.
    CREATE INDEX registration_waitlist ON registration.registration (occurrence_id, waitlist_position) WHERE status IN ('waitlisted', 'offered');
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP INDEX registration.registration_waitlist;
    -- Waiting registrations cannot be represented without the waitlist; they are cancelled.
    UPDATE registration.registration
       SET status = 'cancelled', cancelled_at = coalesce(cancelled_at, now()), waitlist_position = NULL
     WHERE status IN ('waitlisted', 'offered');
    UPDATE registration.registration SET cancelled_by = 'staff' WHERE cancelled_by = 'expired';
    ALTER TABLE registration.registration
      DROP CONSTRAINT registration_waitlist_position,
      DROP CONSTRAINT registration_offer,
      DROP CONSTRAINT registration_cancelled_by_check,
      ADD CONSTRAINT registration_cancelled_by_check CHECK (cancelled_by IN ('attendee', 'staff')),
      DROP COLUMN confirmed_at,
      DROP COLUMN offer_expires_at,
      DROP COLUMN offer_hold_id,
      ALTER COLUMN waitlist_position TYPE int;
    DROP SEQUENCE registration.waitlist_seq;
  `.execute(db);
}
