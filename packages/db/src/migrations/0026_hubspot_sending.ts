import { type Kysely, sql } from "kysely";

// HubSpot connector milestone 5: HubSpot sending (docs/hubspot.md, "HubSpot sending").
//
// `integrations.event_sending` is an event's choice of who sends its invitations, reminders and
// welcome (the platform or HubSpot), the template emails it uses instead of the account's
// defaults, the subject and preview text per kind, and what the last check of its guests in
// HubSpot found (how many would become marketing contacts). It lives in the integrations module,
// not on catalog.event, since only the connector reads it.
//
// `integrations.event_email` is the event's own email per kind in HubSpot: a clone of the
// template, with the event's links, published for the single-send API. One per event and kind;
// made again while nothing has been sent from it, deleted when the event is archived.
//
// The guest's sends record which channel sent them: `invitation_send.channel`, with HubSpot's
// status id (so a retried job reads the result instead of sending again) and, when the platform
// sent instead, why. The welcome (the registration reminder) the same, on the registration.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE integrations.event_sending (
      tenant_id       uuid NOT NULL,
      event_id        uuid NOT NULL,
      channel         text NOT NULL DEFAULT 'platform' CHECK (channel IN ('platform', 'hubspot')),
      -- Template email ids by kind (invitation, reminder, welcome), overriding the account's defaults.
      templates       jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(templates) = 'object'),
      -- Subject and preview text by kind; missing: made from the event.
      texts           jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(texts) = 'object'),
      marketing_check jsonb CHECK (marketing_check IS NULL OR jsonb_typeof(marketing_check) = 'object'),
      updated_by      uuid REFERENCES tenancy.user (id),
      version         integer NOT NULL DEFAULT 1,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, event_id),
      FOREIGN KEY (tenant_id, event_id) REFERENCES catalog.event (tenant_id, id) ON DELETE CASCADE
    );
    SELECT platform.enable_tenant_rls('integrations.event_sending');
    CREATE TRIGGER event_sending_updated_at BEFORE UPDATE ON integrations.event_sending FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();
    GRANT SELECT, INSERT, UPDATE, DELETE ON integrations.event_sending TO em_app;

    CREATE TABLE integrations.event_email (
      tenant_id     uuid NOT NULL,
      connection_id uuid NOT NULL,
      event_id      uuid NOT NULL,
      kind          text NOT NULL CHECK (kind IN ('invitation', 'reminder', 'welcome')),
      template_id   text NOT NULL,
      -- HubSpot's id of the clone; null until made.
      remote_id     text,
      name          text,
      subject       text,
      preview_text  text,
      status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
      error         text,
      warnings      text[] NOT NULL DEFAULT '{}',
      first_sent_at timestamptz,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (connection_id, event_id, kind),
      FOREIGN KEY (tenant_id, connection_id) REFERENCES integrations.connection (tenant_id, id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, event_id) REFERENCES catalog.event (tenant_id, id) ON DELETE CASCADE
    );
    SELECT platform.enable_tenant_rls('integrations.event_email');
    CREATE TRIGGER event_email_updated_at BEFORE UPDATE ON integrations.event_email FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();
    GRANT SELECT, INSERT, UPDATE, DELETE ON integrations.event_email TO em_app;

    ALTER TABLE registration.invitation_send
      ADD COLUMN channel text NOT NULL DEFAULT 'platform' CHECK (channel IN ('platform', 'hubspot')),
      ADD COLUMN provider_status_id text,
      ADD COLUMN fallback_reason text;

    ALTER TABLE registration.registration
      ADD COLUMN reminder_channel text CHECK (reminder_channel IN ('platform', 'hubspot')),
      ADD COLUMN reminder_status_id text,
      ADD COLUMN reminder_detail text;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE registration.registration DROP COLUMN reminder_detail, DROP COLUMN reminder_status_id, DROP COLUMN reminder_channel;
    ALTER TABLE registration.invitation_send DROP COLUMN fallback_reason, DROP COLUMN provider_status_id, DROP COLUMN channel;
    DROP TABLE integrations.event_email;
    DROP TABLE integrations.event_sending;
  `.execute(db);
}
