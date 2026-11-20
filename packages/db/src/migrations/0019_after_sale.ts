import { type Kysely, sql } from "kysely";

// Ticketing milestone 4: after the sale (docs/ticketing.md).
//
// Confirmed tickets can now be cancelled, by the channel (a refund in the shop) or by staff
// from the admin. Each cancelled ticket records who cancelled it and the channel's refund
// reference, so a refund can be reconciled with the line it gave back. Buyers are anonymised
// on the same schedule as registrations: the reservation keeps its lines, order reference and
// tickets for reconciliation, and records when the buyer went.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE sales.ticket
      ADD COLUMN cancelled_by text CHECK (cancelled_by IN ('channel', 'staff')),
      ADD COLUMN external_refund_ref text CHECK (length(external_refund_ref) BETWEEN 1 AND 200);
    -- Tickets cancelled before this migration (only after a rollback) were cancelled by their channel.
    UPDATE sales.ticket SET cancelled_by = 'channel' WHERE status = 'cancelled';
    ALTER TABLE sales.ticket
      ADD CONSTRAINT ticket_cancelled_by CHECK ((status = 'cancelled') = (cancelled_by IS NOT NULL)),
      ADD CONSTRAINT ticket_refund_when_cancelled CHECK (external_refund_ref IS NULL OR status = 'cancelled');

    ALTER TABLE sales.reservation
      ADD COLUMN anonymised_at timestamptz,
      ADD CONSTRAINT reservation_anonymised CHECK (anonymised_at IS NULL OR (buyer_name IS NULL AND buyer_email IS NULL AND buyer_locale IS NULL));
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE sales.reservation DROP CONSTRAINT reservation_anonymised, DROP COLUMN anonymised_at;
    ALTER TABLE sales.ticket DROP CONSTRAINT ticket_refund_when_cancelled, DROP CONSTRAINT ticket_cancelled_by,
      DROP COLUMN external_refund_ref, DROP COLUMN cancelled_by;
  `.execute(db);
}
