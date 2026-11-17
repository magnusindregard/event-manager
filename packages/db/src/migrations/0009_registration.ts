import { type Kysely, sql } from "kysely";

// Registration milestone 2: registrations and admissions (docs/registration.md).
//
// A registration belongs to one occurrence and takes its party size from the occurrence's
// capacity pool. One admission per registration carries the party size for a validator
// later; the QR code in the confirmation email holds a signed admission token. Attendee
// links are signed with a per-tenant key kept in the database, so verifying a link needs
// no secret outside the tenant's own data.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE SCHEMA registration;
    GRANT USAGE ON SCHEMA registration TO em_app, em_definer;

    CREATE TYPE registration.status AS ENUM ('confirmed', 'waitlisted', 'offered', 'cancelled');
    CREATE TYPE registration.source AS ENUM ('invitation', 'open', 'staff');

    CREATE TABLE registration.registration (
      id            uuid PRIMARY KEY,
      tenant_id     uuid NOT NULL,
      event_id      uuid NOT NULL,
      occurrence_id uuid NOT NULL,
      -- Guest invitations arrive in milestone 3; the foreign key is added with their table.
      invitation_id uuid,
      name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
      email         text NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
      locale        text NOT NULL,
      party_size    int NOT NULL CHECK (party_size BETWEEN 1 AND 2),
      status        registration.status NOT NULL,
      source        registration.source NOT NULL,
      waitlist_position int CHECK (waitlist_position > 0),
      -- Bumped to invalidate the attendee's links (manage and admission).
      token_version int NOT NULL DEFAULT 1,
      cancelled_at  timestamptz,
      cancelled_by  text CHECK (cancelled_by IN ('attendee', 'staff')),
      version       int NOT NULL DEFAULT 1,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, id),
      CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
      FOREIGN KEY (tenant_id, event_id) REFERENCES catalog.event (tenant_id, id),
      -- No cascade: an occurrence with registrations cannot be deleted (cancel it instead).
      FOREIGN KEY (tenant_id, occurrence_id) REFERENCES catalog.occurrence (tenant_id, id)
    );
    -- One active registration per email per occurrence.
    CREATE UNIQUE INDEX registration_active_email ON registration.registration (occurrence_id, email) WHERE status <> 'cancelled';
    CREATE INDEX registration_occurrence ON registration.registration (occurrence_id, created_at);
    CREATE INDEX registration_event ON registration.registration (event_id);
    SELECT platform.enable_tenant_rls('registration.registration');
    CREATE TRIGGER registration_updated_at BEFORE UPDATE ON registration.registration FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

    -- HMAC key for the tenant's attendee links (ADR 0005: signed, single-purpose tokens).
    CREATE TABLE registration.token_key (
      tenant_id  uuid PRIMARY KEY,
      key        bytea NOT NULL CHECK (length(key) >= 32),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    SELECT platform.enable_tenant_rls('registration.token_key');

    CREATE SCHEMA admission;
    GRANT USAGE ON SCHEMA admission TO em_app;
    CREATE TYPE admission.status AS ENUM ('valid', 'void');

    CREATE TABLE admission.admission (
      id              uuid PRIMARY KEY,
      tenant_id       uuid NOT NULL,
      registration_id uuid NOT NULL,
      occurrence_id   uuid NOT NULL,
      party_size      int NOT NULL CHECK (party_size BETWEEN 1 AND 100),
      status          admission.status NOT NULL DEFAULT 'valid',
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, id),
      UNIQUE (registration_id),
      FOREIGN KEY (tenant_id, registration_id) REFERENCES registration.registration (tenant_id, id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, occurrence_id) REFERENCES catalog.occurrence (tenant_id, id)
    );
    SELECT platform.enable_tenant_rls('admission.admission');
    CREATE TRIGGER admission_updated_at BEFORE UPDATE ON admission.admission FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

    GRANT SELECT, INSERT, UPDATE ON registration.registration TO em_app;
    GRANT SELECT, INSERT ON registration.token_key TO em_app;
    GRANT SELECT, INSERT, UPDATE ON admission.admission TO em_app;

    -- The open registration page (/r/{occurrence}) knows only the occurrence id. This finds
    -- its tenant, and only for occurrences of published registration events, so it reveals
    -- nothing the public API does not.
    GRANT SELECT ON catalog.occurrence, catalog.event TO em_definer;
    CREATE FUNCTION registration.occurrence_tenant(p_occurrence uuid)
      RETURNS uuid
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, catalog AS $f$
        SELECT o.tenant_id
          FROM catalog.occurrence o
          JOIN catalog.event e ON e.tenant_id = o.tenant_id AND e.id = o.event_id
         -- As text: the enum value is new in 0008, and migrations run in one transaction.
         WHERE o.id = p_occurrence AND e.status IN ('published', 'cancelled') AND e.admission_mode::text = 'registration'
    $f$;
    GRANT CREATE ON SCHEMA registration TO em_definer;
    ALTER FUNCTION registration.occurrence_tenant(uuid) OWNER TO em_definer;
    REVOKE CREATE ON SCHEMA registration FROM em_definer;
    REVOKE ALL ON FUNCTION registration.occurrence_tenant(uuid) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION registration.occurrence_tenant(uuid) TO em_app;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP SCHEMA admission CASCADE;
    DROP SCHEMA registration CASCADE;
    REVOKE SELECT ON catalog.occurrence, catalog.event FROM em_definer;
  `.execute(db);
}
