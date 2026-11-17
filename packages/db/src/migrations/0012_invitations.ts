import { type Kysely, sql } from "kysely";

// Registration milestone 3: guest invitations (docs/registration.md, "Guest invitation").
//
// A guest invitation belongs to an event; the guest picks an occurrence when accepting, and
// the registration links back to it. Each send (invitation or reminder) is logged with its
// Postmark message id and delivery status. A guest list import is staged as rows until staff
// have mapped the columns and seen the preview; the column mapping is remembered per account.
// Events gain an optional reminder before each occurrence, and registrations remember when
// it was sent.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TYPE registration.invitation_status AS ENUM ('pending', 'sent', 'accepted', 'declined');
    CREATE TYPE registration.send_kind AS ENUM ('invitation', 'reminder');
    CREATE TYPE registration.delivery_status AS ENUM ('queued', 'sent', 'delivered', 'bounced', 'spam_complaint', 'failed');

    CREATE TABLE registration.guest_invitation (
      id                  uuid PRIMARY KEY,
      tenant_id           uuid NOT NULL,
      event_id            uuid NOT NULL,
      email               text NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
      -- Optional: the guest enters it when accepting if the list has none.
      name                text CHECK (length(name) BETWEEN 1 AND 200),
      -- Null: the account's default locale.
      locale              text,
      -- Null: the event's setting.
      guest_allowed       boolean,
      external_contact_id text CHECK (length(external_contact_id) BETWEEN 1 AND 200),
      status              registration.invitation_status NOT NULL DEFAULT 'pending',
      -- Bumped to invalidate the personal link.
      token_version       int NOT NULL DEFAULT 1,
      first_sent_at       timestamptz,
      last_sent_at        timestamptz,
      responded_at        timestamptz,
      version             int NOT NULL DEFAULT 1,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, id),
      UNIQUE (event_id, email),
      FOREIGN KEY (tenant_id, event_id) REFERENCES catalog.event (tenant_id, id) ON DELETE CASCADE
    );
    SELECT platform.enable_tenant_rls('registration.guest_invitation');
    CREATE TRIGGER guest_invitation_updated_at BEFORE UPDATE ON registration.guest_invitation FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

    -- Removing an invitation keeps any registration it led to (only unanswered ones are removed, but a
    -- cancelled registration may still point to it).
    ALTER TABLE registration.registration
      ADD FOREIGN KEY (tenant_id, invitation_id) REFERENCES registration.guest_invitation (tenant_id, id) ON DELETE SET NULL (invitation_id),
      ADD COLUMN reminded_at timestamptz;
    -- One active registration per invitation.
    CREATE UNIQUE INDEX registration_active_invitation ON registration.registration (invitation_id) WHERE status <> 'cancelled' AND invitation_id IS NOT NULL;

    CREATE TABLE registration.invitation_send (
      id              uuid PRIMARY KEY,
      tenant_id       uuid NOT NULL,
      invitation_id   uuid NOT NULL,
      kind            registration.send_kind NOT NULL,
      -- Staff member who asked for it.
      requested_by    uuid,
      requested_at    timestamptz NOT NULL DEFAULT now(),
      sent_at         timestamptz,
      message_id      text,
      delivery_status registration.delivery_status NOT NULL DEFAULT 'queued',
      delivery_detail text,
      delivery_at     timestamptz,
      UNIQUE (tenant_id, id),
      FOREIGN KEY (tenant_id, invitation_id) REFERENCES registration.guest_invitation (tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX invitation_send_invitation ON registration.invitation_send (invitation_id, requested_at DESC);
    -- At most one email of each kind waiting per guest, so overlapping requests can never send two.
    CREATE UNIQUE INDEX invitation_send_one_queued ON registration.invitation_send (invitation_id, kind) WHERE delivery_status = 'queued';
    SELECT platform.enable_tenant_rls('registration.invitation_send');

    -- An uploaded guest list, kept until it is imported or for a day.
    CREATE TABLE registration.guest_import (
      id         uuid PRIMARY KEY,
      tenant_id  uuid NOT NULL,
      event_id   uuid NOT NULL,
      created_by uuid,
      file_name  text NOT NULL,
      headers    text[] NOT NULL,
      -- Array of rows, each an array of cell strings.
      rows       jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL DEFAULT now() + interval '1 day',
      UNIQUE (tenant_id, id),
      FOREIGN KEY (tenant_id, event_id) REFERENCES catalog.event (tenant_id, id) ON DELETE CASCADE
    );
    SELECT platform.enable_tenant_rls('registration.guest_import');

    -- The account's last column mapping, by header text: {"email": "E-post", "name": "Navn", ...}.
    CREATE TABLE registration.import_mapping (
      tenant_id  uuid PRIMARY KEY,
      mapping    jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    SELECT platform.enable_tenant_rls('registration.import_mapping');

    -- Null: no reminder before the event.
    ALTER TABLE catalog.event ADD COLUMN reminder_min_before int CHECK (reminder_min_before BETWEEN 60 AND 20160);

    GRANT SELECT, INSERT, UPDATE, DELETE ON registration.guest_invitation TO em_app;
    GRANT SELECT, INSERT, UPDATE ON registration.invitation_send TO em_app;
    GRANT SELECT, INSERT, DELETE ON registration.guest_import TO em_app;
    GRANT SELECT, INSERT, UPDATE ON registration.import_mapping TO em_app;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE catalog.event DROP COLUMN reminder_min_before;
    DROP TABLE registration.import_mapping;
    DROP TABLE registration.guest_import;
    DROP TABLE registration.invitation_send;
    DROP INDEX registration.registration_active_invitation;
    ALTER TABLE registration.registration DROP COLUMN reminded_at;
    ALTER TABLE registration.registration DROP CONSTRAINT IF EXISTS registration_tenant_id_invitation_id_fkey;
    DROP TABLE registration.guest_invitation;
    DROP TYPE registration.delivery_status;
    DROP TYPE registration.send_kind;
    DROP TYPE registration.invitation_status;
  `.execute(db);
}
