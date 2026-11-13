import { type Kysely, sql } from "kysely";

// ADR 0008. Each outbox row enqueues a graphile-worker job in the same transaction,
// so there is no event without a commit and no commit without a dispatch job.
// The job carries the tenant id, so the dispatcher runs under RLS like everything else.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE SCHEMA outbox;
    GRANT USAGE ON SCHEMA outbox TO em_app;

    CREATE TABLE outbox.event (
      id            uuid PRIMARY KEY,
      tenant_id     uuid NOT NULL REFERENCES tenancy.account (id),
      type          text NOT NULL CHECK (type ~ '^[a-z_]+(\.[a-z_]+)+\.v[0-9]+$'),
      source        text NOT NULL,
      subject       text NOT NULL,
      data          jsonb NOT NULL,
      created_at    timestamptz NOT NULL DEFAULT now(),
      dispatched_at timestamptz
    );
    CREATE INDEX outbox_event_undispatched ON outbox.event (created_at) WHERE dispatched_at IS NULL;
    SELECT platform.enable_tenant_rls('outbox.event');

    CREATE TABLE outbox.handled (
      handler    text NOT NULL,
      event_id   uuid NOT NULL REFERENCES outbox.event (id),
      tenant_id  uuid NOT NULL REFERENCES tenancy.account (id),
      handled_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (handler, event_id)
    );
    SELECT platform.enable_tenant_rls('outbox.handled');

    GRANT SELECT, INSERT ON outbox.event TO em_app;
    GRANT UPDATE (dispatched_at) ON outbox.event TO em_app;
    GRANT SELECT, INSERT ON outbox.handled TO em_app;

    CREATE FUNCTION outbox.enqueue_dispatch() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN
      PERFORM graphile_worker.add_job(
        'outbox.dispatch',
        json_build_object('eventId', NEW.id, 'tenantId', NEW.tenant_id),
        max_attempts := 25);
      RETURN NEW;
    END $f$;
    CREATE TRIGGER event_enqueue AFTER INSERT ON outbox.event FOR EACH ROW EXECUTE FUNCTION outbox.enqueue_dispatch();
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP SCHEMA outbox CASCADE`.execute(db);
}
