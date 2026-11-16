import { type Kysely, sql } from "kysely";

// Milestone 4: occurrence rules (docs/mvp.md, "Occurrence rules").
//
// A rule is a set of conditions on an event's occurrences (local date range, weekdays and
// start-time window in the event's timezone) plus generic effects. Effects are rows of
// (effect_type, target_ref, value), validated by the effect-type registry in the domain,
// so later types (capacity, price per offer) need no schema change.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE rules.rule (
      id              uuid PRIMARY KEY,
      tenant_id       uuid NOT NULL,
      event_id        uuid NOT NULL,
      name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
      -- Higher wins. Equal priority: the older rule (lower UUIDv7) wins, reported as a conflict.
      priority        int NOT NULL DEFAULT 0 CHECK (priority BETWEEN -1000 AND 1000),
      -- Conditions; null means "any". Dates are inclusive, in the event's local time.
      date_from       date,
      date_to         date,
      -- ISO weekdays, 1 = Monday.
      weekdays        smallint[] CHECK (weekdays <@ '{1,2,3,4,5,6,7}'::smallint[] AND cardinality(weekdays) > 0),
      -- Start time window [from, to). from > to wraps midnight (22:00–02:00).
      start_time_from time,
      start_time_to   time,
      active          boolean NOT NULL DEFAULT true,
      version         int NOT NULL DEFAULT 1,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, id),
      FOREIGN KEY (tenant_id, event_id) REFERENCES catalog.event (tenant_id, id),
      CHECK (date_from IS NULL OR date_to IS NULL OR date_from <= date_to),
      CHECK (start_time_from IS NULL OR start_time_to IS NULL OR start_time_from <> start_time_to)
    );
    CREATE INDEX rule_event ON rules.rule (tenant_id, event_id);
    SELECT platform.enable_tenant_rls('rules.rule');
    CREATE TRIGGER rule_updated_at BEFORE UPDATE ON rules.rule FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

    CREATE TABLE rules.rule_effect (
      id          uuid PRIMARY KEY,
      tenant_id   uuid NOT NULL,
      rule_id     uuid NOT NULL,
      effect_type text NOT NULL CHECK (effect_type ~ '^[a-z][A-Za-z0-9]{0,40}$'),
      -- What the effect applies to within the field, e.g. an offer for a later price effect.
      target_ref  text CHECK (length(target_ref) BETWEEN 1 AND 200),
      value       jsonb NOT NULL,
      FOREIGN KEY (tenant_id, rule_id) REFERENCES rules.rule (tenant_id, id) ON DELETE CASCADE,
      UNIQUE NULLS NOT DISTINCT (rule_id, effect_type, target_ref)
    );
    SELECT platform.enable_tenant_rls('rules.rule_effect');

    -- effective_value.rule_id stays without a foreign key: after a rule is deleted, events
    -- with many occurrences are resolved again by the worker, and until then the old value
    -- (with its rule id) is still what the public API serves.

    GRANT SELECT, INSERT, UPDATE, DELETE ON rules.rule, rules.rule_effect TO em_app;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE rules.rule_effect, rules.rule`.execute(db);
}
