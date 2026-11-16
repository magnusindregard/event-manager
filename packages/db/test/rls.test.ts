import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDatabase, type TestDatabase } from "../src/testing.js";

// Acceptance: "A second tenant cannot see any data from the first, verified by
// tests on every table." Tables are discovered from the catalog, so a new
// tenant-owned table fails this suite until it has RLS and a fixture below.

type Ids = { tenantA: string; tenantB: string; user: string; event: string };
type Fixture = (c: pg.ClientBase, tenantId: string, ids: Ids) => Promise<void>;

const fixtures: Record<string, Fixture> = {
  "tenancy.account": (c, t) =>
    c.query(`insert into tenancy.account (id, slug, name) values ($1, $2, 'Fixture')`, [t, `t-${t.slice(0, 8)}`]).then(() => {}),
  "tenancy.membership": (c, t, ids) =>
    c.query(`insert into tenancy.membership (id, tenant_id, user_id, role) values ($1, $2, $3, 'owner')`, [randomUUID(), t, ids.user]).then(() => {}),
  "tenancy.invitation": (c, t) =>
    c.query(`insert into tenancy.invitation (id, tenant_id, email, role) values ($1, $2, $3, 'editor')`, [randomUUID(), t, `${randomUUID()}@example.com`]).then(() => {}),
  "tenancy.audit_log": (c, t) =>
    c.query(`insert into tenancy.audit_log (id, tenant_id, action, entity_type, entity_id) values ($1, $2, 'x', 'account', $2)`, [randomUUID(), t]).then(() => {}),
  "tenancy.api_key": (c, t) =>
    c.query(`insert into tenancy.api_key (id, tenant_id, kind, prefix, secret_hash, label) values ($1, $2, 'publishable', $3, 'h', 'k')`, [randomUUID(), t, `pk_${randomUUID()}`]).then(() => {}),
  "outbox.event": (c, t, ids) =>
    c.query(`insert into outbox.event (id, tenant_id, type, source, subject, data) values ($1, $2, 'account.changed.v1', 'test', 's', '{}')`, [t === ids.tenantA ? ids.event : randomUUID(), t]).then(() => {}),
  "outbox.handled": (c, t, ids) =>
    c.query(`insert into outbox.handled (handler, event_id, tenant_id) values ($1, $2, $3)`, [randomUUID(), ids.event, t]).then(() => {}),
};

let db: TestDatabase;
let admin: pg.Client;
let app: pg.Client;
let tables: string[];
const ids: Ids = { tenantA: randomUUID(), tenantB: randomUUID(), user: randomUUID(), event: randomUUID() };

async function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  await app.query("begin");
  try {
    await app.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
    return await fn();
  } finally {
    await app.query("rollback");
  }
}

beforeAll(async () => {
  db = await startTestDatabase();
  admin = new pg.Client({ connectionString: db.migratorUrl });
  app = new pg.Client({ connectionString: db.appUrl });
  await Promise.all([admin.connect(), app.connect()]);

  const res = await admin.query<{ t: string }>(`
    select c.table_schema || '.' || c.table_name as t
      from information_schema.columns c
      join information_schema.tables tb using (table_schema, table_name)
     where c.column_name = 'tenant_id' and tb.table_type = 'BASE TABLE'
       and c.table_schema not in ('pg_catalog', 'information_schema', 'graphile_worker')
     order by 1`);
  tables = res.rows.map((r) => r.t);

  // Seed tenant A (and B's account) as the migrator, which bypasses RLS locally (superuser).
  await admin.query(`insert into tenancy."user" (id, idp_issuer, idp_subject, email) values ($1, 'test', 'u1', 'u1@example.com')`, [ids.user]);
  await fixtures["tenancy.account"]!(admin, ids.tenantB, ids);
  for (const t of Object.keys(fixtures)) await fixtures[t]!(admin, ids.tenantA, ids);
});

afterAll(async () => {
  await Promise.all([admin?.end(), app?.end()]);
  await db?.stop();
});

describe("row-level security", () => {
  it("discovers tenant tables", () => {
    expect(tables.length).toBeGreaterThanOrEqual(Object.keys(fixtures).length);
  });

  it("every tenant table has a fixture in this test", () => {
    expect(tables.filter((t) => !(t in fixtures))).toEqual([]);
  });

  it("every tenant table has RLS enabled and forced with a tenant_isolation policy", async () => {
    const res = await admin.query<{ t: string; enabled: boolean; forced: boolean; policy: boolean }>(`
      select n.nspname || '.' || c.relname as t, c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
             exists (select 1 from pg_policies p where p.schemaname = n.nspname and p.tablename = c.relname
                       and p.policyname = 'tenant_isolation') as policy
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname || '.' || c.relname = any($1)`, [tables]);
    for (const row of res.rows) expect(row, row.t).toMatchObject({ enabled: true, forced: true, policy: true });
  });

  it("the runtime role cannot bypass RLS", async () => {
    const res = await app.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      `select rolbypassrls, rolsuper from pg_roles where rolname = current_user`);
    expect(res.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
  });

  it("without a tenant set, nothing is visible", async () => {
    for (const t of tables) {
      const res = await app.query(`select count(*)::int as n from ${t}`);
      expect(res.rows[0].n, t).toBe(0);
    }
  });

  it("tenant A sees its own rows", async () => {
    await asTenant(ids.tenantA, async () => {
      for (const t of tables) {
        const res = await app.query(`select count(*)::int as n from ${t}`);
        expect(res.rows[0].n, t).toBeGreaterThan(0);
      }
    });
  });

  it("tenant B sees none of tenant A's rows", async () => {
    await asTenant(ids.tenantB, async () => {
      for (const t of tables) {
        const res = await app.query(`select count(*)::int as n from ${t} where tenant_id = $1`, [ids.tenantA]);
        expect(res.rows[0].n, t).toBe(0);
      }
    });
  });

  it("tenant B cannot update or delete tenant A's rows", async () => {
    for (const t of tables) {
      await asTenant(ids.tenantB, async () => {
        await app.query("savepoint s");
        try {
          const upd = await app.query(`update ${t} set tenant_id = tenant_id where tenant_id = $1`, [ids.tenantA]);
          expect(upd.rowCount, `${t} update`).toBe(0);
        } catch (e) {
          // No UPDATE grant (append-only tables) or generated column is also a pass.
          expect((e as { code?: string }).code, `${t} update`).toMatch(/^(42501|428C9)$/);
          await app.query("rollback to savepoint s");
        }
        try {
          const del = await app.query(`delete from ${t} where tenant_id = $1`, [ids.tenantA]);
          expect(del.rowCount, `${t} delete`).toBe(0);
        } catch (e) {
          expect((e as { code?: string }).code, `${t} delete`).toBe("42501");
        }
      });
    }
  });

  it("tenant B cannot insert rows for tenant A", async () => {
    for (const t of tables) {
      await asTenant(ids.tenantB, async () => {
        const err = await fixtures[t]!(app, ids.tenantA, { ...ids, event: randomUUID() }).then(
          () => null,
          (e: { code?: string }) => e,
        );
        // 42501 = RLS check violation or missing grant; 23503 = FK to a row B cannot see.
        expect(err?.code, t).toMatch(/^(42501|23503)$/);
      });
    }
  });
});
