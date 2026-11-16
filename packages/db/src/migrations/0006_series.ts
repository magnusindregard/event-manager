import { type Kysely, sql } from "kysely";

// Milestone 3: recurring series (docs/mvp.md, "Series").
//
// A series holds an RFC 5545 rule in floating local wall time (dtstart_local + timezone).
// Its occurrences are materialized rows keyed by recurrence_id_local, the slot's local
// start, so edits and cancellations survive changes to the rule.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE catalog.series (
      id              uuid PRIMARY KEY,
      tenant_id       uuid NOT NULL,
      event_id        uuid NOT NULL,
      -- RRULE body without DTSTART, e.g. FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20270131T235959 (UNTIL is local).
      rrule           text NOT NULL CHECK (rrule ~ '^FREQ=' AND length(rrule) <= 1000),
      dtstart_local   timestamp NOT NULL,
      duration_min    int NOT NULL CHECK (duration_min BETWEEN 1 AND 100000),
      timezone        text NOT NULL,
      -- Slots removed from the series (Outlook "delete this occurrence"), as local starts.
      exdates         timestamp[] NOT NULL DEFAULT '{}',
      -- Occurrences exist up to here. Open-ended series are extended nightly to the account horizon.
      generated_until timestamptz NOT NULL,
      -- True once every slot of the rule is generated (UNTIL/COUNT reached); the horizon job skips it.
      complete        boolean NOT NULL DEFAULT false,
      version         int NOT NULL DEFAULT 1,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, id),
      FOREIGN KEY (tenant_id, event_id) REFERENCES catalog.event (tenant_id, id)
    );
    CREATE INDEX series_event ON catalog.series (tenant_id, event_id);
    CREATE INDEX series_horizon ON catalog.series (generated_until) WHERE NOT complete;
    SELECT platform.enable_tenant_rls('catalog.series');
    CREATE TRIGGER series_updated_at BEFORE UPDATE ON catalog.series FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

    -- Detached occurrences whose slot moved or disappeared when the rule changed.
    ALTER TABLE catalog.occurrence ADD COLUMN conflict boolean NOT NULL DEFAULT false;
    ALTER TABLE catalog.occurrence
      ADD CONSTRAINT occurrence_series FOREIGN KEY (tenant_id, series_id) REFERENCES catalog.series (tenant_id, id);
    -- One occurrence per slot. Deferred, because regeneration re-keys occurrences when the
    -- rule's time changes and two rows may swap slots within one transaction.
    ALTER TABLE catalog.occurrence
      ADD CONSTRAINT occurrence_slot UNIQUE (tenant_id, series_id, recurrence_id_local) DEFERRABLE INITIALLY DEFERRED;
    CREATE INDEX occurrence_series_idx ON catalog.occurrence (tenant_id, series_id) WHERE series_id IS NOT NULL;

    GRANT SELECT, INSERT, UPDATE, DELETE ON catalog.series TO em_app;

    -- The nightly horizon job has no tenant; this lists the series it must extend.
    -- Ids only, so the job then works per tenant under RLS.
    GRANT USAGE ON SCHEMA catalog TO em_definer;
    GRANT SELECT ON catalog.series TO em_definer;
    GRANT SELECT ON tenancy.account TO em_definer;
    CREATE FUNCTION catalog.series_due_for_extension(at timestamptz)
      RETURNS TABLE (tenant_id uuid, series_id uuid)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, catalog, tenancy AS $f$
        SELECT s.tenant_id, s.id
          FROM catalog.series s
          JOIN tenancy.account a ON a.id = s.tenant_id
         WHERE NOT s.complete
           -- One day of slack, so a nightly run does not extend every series by a day each time.
           AND s.generated_until < at + make_interval(months => a.horizon_months) - interval '1 day'
         ORDER BY s.tenant_id, s.id
    $f$;
    ALTER FUNCTION catalog.series_due_for_extension(timestamptz) OWNER TO em_definer;
    REVOKE ALL ON FUNCTION catalog.series_due_for_extension(timestamptz) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION catalog.series_due_for_extension(timestamptz) TO em_app;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP FUNCTION catalog.series_due_for_extension(timestamptz);
    ALTER TABLE catalog.occurrence DROP CONSTRAINT occurrence_slot, DROP CONSTRAINT occurrence_series, DROP COLUMN conflict;
    DROP INDEX IF EXISTS catalog.occurrence_series_idx;
    DROP TABLE catalog.series;
  `.execute(db);
}
