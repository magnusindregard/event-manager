import { type Kysely, sql } from "kysely";

// Milestone 2: locations, events, one-off occurrences and effective values (docs/mvp.md).
//
// Every reference between tenant tables is a composite foreign key on (tenant_id, id).
// Foreign key checks bypass RLS, so a plain FK on id would let one tenant point at
// another tenant's row; the composite key makes that impossible.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- Tag vocabularies are account configuration, so they live in tenancy.
    CREATE TABLE tenancy.tag_vocabulary (
      id         uuid PRIMARY KEY,
      tenant_id  uuid NOT NULL REFERENCES tenancy.account (id),
      key        text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
      labels     jsonb NOT NULL DEFAULT '{}',
      version    int NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, key),
      UNIQUE (tenant_id, id)
    );
    SELECT platform.enable_tenant_rls('tenancy.tag_vocabulary');

    CREATE TABLE tenancy.tag (
      id            uuid PRIMARY KEY,
      tenant_id     uuid NOT NULL,
      vocabulary_id uuid NOT NULL,
      key           text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
      labels        jsonb NOT NULL DEFAULT '{}',
      archived_at   timestamptz,
      version       int NOT NULL DEFAULT 1,
      created_at    timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (tenant_id, vocabulary_id) REFERENCES tenancy.tag_vocabulary (tenant_id, id) ON DELETE CASCADE,
      UNIQUE (tenant_id, vocabulary_id, key),
      UNIQUE (tenant_id, id)
    );
    SELECT platform.enable_tenant_rls('tenancy.tag');

    -- Idempotency-Key for retriable POSTs (ADR 0007). Rows older than 24 h are ignored and replaced.
    CREATE TABLE tenancy.idempotency_key (
      tenant_id    uuid NOT NULL REFERENCES tenancy.account (id),
      key          text NOT NULL CHECK (length(key) BETWEEN 1 AND 255),
      request_hash text NOT NULL,
      status_code  int NOT NULL,
      response     jsonb NOT NULL,
      created_at   timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, key)
    );
    SELECT platform.enable_tenant_rls('tenancy.idempotency_key');

    CREATE SCHEMA catalog;
    GRANT USAGE ON SCHEMA catalog TO em_app;

    CREATE TYPE catalog.location_kind AS ENUM ('venue', 'space');
    CREATE TYPE catalog.event_status AS ENUM ('draft', 'published', 'cancelled', 'archived');
    CREATE TYPE catalog.admission_mode AS ENUM ('none', 'external');
    CREATE TYPE catalog.occurrence_status AS ENUM ('scheduled', 'cancelled');

    CREATE TABLE catalog.location (
      id          uuid PRIMARY KEY,
      tenant_id   uuid NOT NULL REFERENCES tenancy.account (id),
      kind        catalog.location_kind NOT NULL,
      parent_id   uuid,
      name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
      address     text,
      lat         double precision CHECK (lat BETWEEN -90 AND 90),
      lng         double precision CHECK (lng BETWEEN -180 AND 180),
      archived_at timestamptz,
      version     int NOT NULL DEFAULT 1,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, id),
      FOREIGN KEY (tenant_id, parent_id) REFERENCES catalog.location (tenant_id, id),
      -- Venues are roots; spaces belong to a venue.
      CHECK ((kind = 'venue') = (parent_id IS NULL)),
      CHECK ((lat IS NULL) = (lng IS NULL))
    );
    SELECT platform.enable_tenant_rls('catalog.location');
    CREATE TRIGGER location_updated_at BEFORE UPDATE ON catalog.location FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

    CREATE FUNCTION catalog.check_location_parent() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN
      IF NEW.parent_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM catalog.location p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.parent_id AND p.kind = 'venue'
      ) THEN
        RAISE EXCEPTION 'A space must belong to a venue' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END $f$;
    CREATE TRIGGER location_parent BEFORE INSERT OR UPDATE OF parent_id, kind ON catalog.location
      FOR EACH ROW EXECUTE FUNCTION catalog.check_location_parent();

    CREATE TABLE catalog.event (
      id                   uuid PRIMARY KEY,
      tenant_id            uuid NOT NULL REFERENCES tenancy.account (id),
      slug                 text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 120),
      status               catalog.event_status NOT NULL DEFAULT 'draft',
      timezone             text NOT NULL,
      default_location_id  uuid,
      default_duration_min int NOT NULL DEFAULT 60 CHECK (default_duration_min BETWEEN 1 AND 100000),
      admission_mode       catalog.admission_mode NOT NULL DEFAULT 'none',
      external_url         text CHECK (external_url ~ '^https?://'),
      external_refs        jsonb NOT NULL DEFAULT '{}',
      version              int NOT NULL DEFAULT 1,
      created_at           timestamptz NOT NULL DEFAULT now(),
      updated_at           timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, slug),
      UNIQUE (tenant_id, id),
      FOREIGN KEY (tenant_id, default_location_id) REFERENCES catalog.location (tenant_id, id),
      CHECK (admission_mode <> 'external' OR external_url IS NOT NULL)
    );
    SELECT platform.enable_tenant_rls('catalog.event');
    CREATE TRIGGER event_updated_at BEFORE UPDATE ON catalog.event FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

    CREATE TABLE catalog.event_translation (
      tenant_id         uuid NOT NULL,
      event_id          uuid NOT NULL,
      locale            text NOT NULL CHECK (locale ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
      title             text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
      short_description text,
      image_url         text CHECK (image_url ~ '^https?://'),
      image_alt         text,
      PRIMARY KEY (event_id, locale),
      FOREIGN KEY (tenant_id, event_id) REFERENCES catalog.event (tenant_id, id) ON DELETE CASCADE
    );
    SELECT platform.enable_tenant_rls('catalog.event_translation');

    CREATE TABLE catalog.event_tag (
      tenant_id uuid NOT NULL,
      event_id  uuid NOT NULL,
      tag_id    uuid NOT NULL,
      PRIMARY KEY (event_id, tag_id),
      FOREIGN KEY (tenant_id, event_id) REFERENCES catalog.event (tenant_id, id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, tag_id) REFERENCES tenancy.tag (tenant_id, id)
    );
    CREATE INDEX event_tag_tag ON catalog.event_tag (tenant_id, tag_id);
    SELECT platform.enable_tenant_rls('catalog.event_tag');

    -- Occurrence IDs are UUIDv7 and never reused (admissions will reference them).
    -- series_id and recurrence_id_local are filled by series in milestone 3.
    CREATE TABLE catalog.occurrence (
      id                    uuid PRIMARY KEY,
      tenant_id             uuid NOT NULL,
      event_id              uuid NOT NULL,
      series_id             uuid,
      recurrence_id_local   timestamp,
      start_utc             timestamptz NOT NULL,
      end_utc               timestamptz NOT NULL,
      status                catalog.occurrence_status NOT NULL DEFAULT 'scheduled',
      detached              boolean NOT NULL DEFAULT false,
      location_override_id  uuid,
      external_url_override text CHECK (external_url_override ~ '^https?://'),
      tags_override         uuid[],
      resolved_version      int,
      version               int NOT NULL DEFAULT 1,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, id),
      FOREIGN KEY (tenant_id, event_id) REFERENCES catalog.event (tenant_id, id),
      FOREIGN KEY (tenant_id, location_override_id) REFERENCES catalog.location (tenant_id, id),
      CHECK (end_utc > start_utc),
      CHECK ((series_id IS NULL) = (recurrence_id_local IS NULL))
    );
    CREATE INDEX occurrence_start ON catalog.occurrence (tenant_id, start_utc, id);
    CREATE INDEX occurrence_event ON catalog.occurrence (tenant_id, event_id, start_utc);
    SELECT platform.enable_tenant_rls('catalog.occurrence');
    CREATE TRIGGER occurrence_updated_at BEFORE UPDATE ON catalog.occurrence FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

    -- Resolved values per occurrence and field (docs/mvp.md, "Resolution and effective values").
    -- The rule table arrives in milestone 4; rule_id stays unconstrained until then.
    CREATE SCHEMA rules;
    GRANT USAGE ON SCHEMA rules TO em_app;
    CREATE TYPE rules.value_source AS ENUM ('default', 'rule', 'override');

    CREATE TABLE rules.effective_value (
      tenant_id     uuid NOT NULL,
      occurrence_id uuid NOT NULL,
      field         text NOT NULL CHECK (field IN ('location', 'tags', 'externalUrl')),
      value         jsonb NOT NULL,
      source        rules.value_source NOT NULL,
      rule_id       uuid,
      PRIMARY KEY (occurrence_id, field),
      FOREIGN KEY (tenant_id, occurrence_id) REFERENCES catalog.occurrence (tenant_id, id) ON DELETE CASCADE,
      CHECK ((source = 'rule') = (rule_id IS NOT NULL))
    );
    SELECT platform.enable_tenant_rls('rules.effective_value');

    GRANT SELECT, INSERT, UPDATE, DELETE ON tenancy.tag_vocabulary, tenancy.tag TO em_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON tenancy.idempotency_key TO em_app;
    GRANT SELECT, INSERT, UPDATE ON catalog.location, catalog.event TO em_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON catalog.event_translation, catalog.event_tag, catalog.occurrence TO em_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON rules.effective_value TO em_app;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP SCHEMA rules CASCADE;
    DROP SCHEMA catalog CASCADE;
    DROP TABLE tenancy.idempotency_key, tenancy.tag, tenancy.tag_vocabulary;
  `.execute(db);
}
