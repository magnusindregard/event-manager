import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDatabase, type TestDatabase } from "../src/testing.js";

// Acceptance: "A second tenant cannot see any data from the first, verified by
// tests on every table." Tables are discovered from the catalog, so a new
// tenant-owned table fails this suite until it has RLS and a fixture below.

type Ids = {
  tenantA: string; tenantB: string; user: string; event: string;
  vocabulary: string; tag: string; location: string; catalogEvent: string; occurrence: string; series: string; rule: string; pool: string; registration: string; guestInvitation: string; vatClass: string; offer: string; channel: string; reservation: string; line: string; ticket: string; group: string; connection: string;
};
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
  "tenancy.idempotency_key": (c, t) =>
    c.query(`insert into tenancy.idempotency_key (tenant_id, key, request_hash, status_code, response) values ($1, $2, 'h', 201, '{}')`, [t, randomUUID()]).then(() => {}),
  "tenancy.tag_vocabulary": (c, t, ids) =>
    c.query(`insert into tenancy.tag_vocabulary (id, tenant_id, key) values ($1, $2, $3)`, [ids.vocabulary, t, `v${ids.vocabulary.slice(0, 8)}`]).then(() => {}),
  "tenancy.tag": (c, t, ids) =>
    c.query(`insert into tenancy.tag (id, tenant_id, vocabulary_id, key) values ($1, $2, $3, 'x')`, [ids.tag, t, ids.vocabulary]).then(() => {}),
  "catalog.location": (c, t, ids) =>
    c.query(`insert into catalog.location (id, tenant_id, kind, name) values ($1, $2, 'venue', 'Venue')`, [ids.location, t]).then(() => {}),
  "catalog.event": (c, t, ids) =>
    c.query(`insert into catalog.event (id, tenant_id, slug, timezone, default_location_id) values ($1, $2, $3, 'Europe/Oslo', $4)`,
      [ids.catalogEvent, t, `e-${ids.catalogEvent.slice(0, 8)}`, ids.location]).then(() => {}),
  "catalog.event_translation": (c, t, ids) =>
    c.query(`insert into catalog.event_translation (tenant_id, event_id, locale, title) values ($1, $2, 'nb', 'Tittel')`, [t, ids.catalogEvent]).then(() => {}),
  "catalog.event_tag": (c, t, ids) =>
    c.query(`insert into catalog.event_tag (tenant_id, event_id, tag_id) values ($1, $2, $3)`, [t, ids.catalogEvent, ids.tag]).then(() => {}),
  "catalog.occurrence": (c, t, ids) =>
    c.query(`insert into catalog.occurrence (id, tenant_id, event_id, start_utc, end_utc) values ($1, $2, $3, now(), now() + interval '1 hour')`,
      [ids.occurrence, t, ids.catalogEvent]).then(() => {}),
  "catalog.series": (c, t, ids) =>
    c.query(`insert into catalog.series (id, tenant_id, event_id, rrule, dtstart_local, duration_min, timezone, generated_until)
              values ($1, $2, $3, 'FREQ=WEEKLY', '2027-01-04 14:00', 60, 'Europe/Oslo', now())`, [ids.series, t, ids.catalogEvent]).then(() => {}),
  "rules.rule": (c, t, ids) =>
    c.query(`insert into rules.rule (id, tenant_id, event_id, name, weekdays, start_time_from) values ($1, $2, $3, 'Kveld', '{3}', '18:00')`,
      [ids.rule, t, ids.catalogEvent]).then(() => {}),
  "rules.rule_effect": (c, t, ids) =>
    c.query(`insert into rules.rule_effect (id, tenant_id, rule_id, effect_type, value) values ($1, $2, $3, 'externalUrl', '"https://x.test"')`,
      [randomUUID(), t, ids.rule]).then(() => {}),
  "rules.effective_value": (c, t, ids) =>
    c.query(`insert into rules.effective_value (tenant_id, occurrence_id, field, value, source) values ($1, $2, 'location', 'null', 'default')`,
      [t, ids.occurrence]).then(() => {}),
  "inventory.capacity_pool": (c, t, ids) =>
    c.query(`insert into inventory.capacity_pool (id, tenant_id, occurrence_id, capacity) values ($1, $2, $3, 40)`, [ids.pool, t, ids.occurrence]).then(() => {}),
  "inventory.hold": (c, t, ids) =>
    c.query(`insert into inventory.hold (id, tenant_id, pool_id, quantity, expires_at) values ($1, $2, $3, 1, now() + interval '1 day')`,
      [randomUUID(), t, ids.pool]).then(() => {}),
  "registration.registration": (c, t, ids) =>
    c.query(`insert into registration.registration (id, tenant_id, event_id, occurrence_id, name, email, locale, party_size, status, source)
              values ($1, $2, $3, $4, 'Kari', 'kari@example.com', 'nb', 1, 'confirmed', 'open')`, [ids.registration, t, ids.catalogEvent, ids.occurrence]).then(() => {}),
  "registration.token_key": (c, t) =>
    c.query(`insert into registration.token_key (tenant_id, key) values ($1, decode(repeat('ab', 32), 'hex'))`, [t]).then(() => {}),
  "registration.guest_invitation": (c, t, ids) =>
    c.query(`insert into registration.guest_invitation (id, tenant_id, event_id, email) values ($1, $2, $3, $4)`,
      [ids.guestInvitation, t, ids.catalogEvent, `guest-${ids.guestInvitation}@example.com`]).then(() => {}),
  "registration.invitation_send": (c, t, ids) =>
    c.query(`insert into registration.invitation_send (id, tenant_id, invitation_id, kind) values ($1, $2, $3, 'invitation')`,
      [randomUUID(), t, ids.guestInvitation]).then(() => {}),
  "registration.guest_import": (c, t, ids) =>
    c.query(`insert into registration.guest_import (id, tenant_id, event_id, file_name, headers, rows) values ($1, $2, $3, 'g.csv', '{E-post}', '[["a@example.com"]]')`,
      [randomUUID(), t, ids.catalogEvent]).then(() => {}),
  "registration.import_mapping": (c, t) =>
    c.query(`insert into registration.import_mapping (tenant_id, mapping) values ($1, '{"email":"E-post"}')`, [t]).then(() => {}),
  "registration.form_version": (c, t, ids) =>
    c.query(`insert into registration.form_version (tenant_id, event_id, version, fields) values ($1, $2, 1, '[]')`,
      [t, ids.catalogEvent]).then(() => {}),
  "registration.answer": (c, t, ids) =>
    c.query(`insert into registration.answer (tenant_id, registration_id, field_id, value) values ($1, $2, 'org', '"NTNU"')`,
      [t, ids.registration]).then(() => {}),
  "registration.sensitive_answer": (c, t, ids) =>
    c.query(`insert into registration.sensitive_answer (tenant_id, registration_id, field_id, ciphertext) values ($1, $2, 'diet', '\\x00')`,
      [t, ids.registration]).then(() => {}),
  "platform.data_key": (c, t) =>
    c.query(`insert into platform.data_key (tenant_id, wrapped, master_key_id) values ($1, '\\x00', 'k1')`, [t]).then(() => {}),
  "integrations.connection": (c, t, ids) =>
    c.query(`insert into integrations.connection (id, tenant_id, provider, status, external_account_id, connected_at) values ($1, $2, 'hubspot', 'active', '123', now())`,
      [ids.connection, t]).then(() => {}),
  "integrations.credential": (c, t, ids) =>
    c.query(`insert into integrations.credential (connection_id, tenant_id, ciphertext, access_expires_at) values ($1, $2, '\\x00', now())`, [ids.connection, t]).then(() => {}),
  "integrations.sync_item": (c, t, ids) =>
    c.query(`insert into integrations.sync_item (tenant_id, connection_id, kind, local_key) values ($1, $2, 'contact', 'a@example.com')`, [t, ids.connection]).then(() => {}),
  "integrations.contact_state": (c, t, ids) =>
    c.query(`insert into integrations.contact_state (tenant_id, connection_id, email) values ($1, $2, 'a@example.com')`, [t, ids.connection]).then(() => {}),
  "offers.vat_class": (c, t, ids) =>
    c.query(`insert into offers.vat_class (id, tenant_id, code, label, rate_pct) values ($1, $2, 'exempt', 'Exempt', 0)`, [ids.vatClass, t]).then(() => {}),
  "offers.offer": (c, t, ids) =>
    c.query(`insert into offers.offer (id, tenant_id, event_id, code, vat_class_id, default_price) values ($1, $2, $3, 'adult', $4, 45000)`,
      [ids.offer, t, ids.catalogEvent, ids.vatClass]).then(() => {}),
  "offers.offer_translation": (c, t, ids) =>
    c.query(`insert into offers.offer_translation (tenant_id, offer_id, locale, name) values ($1, $2, 'nb', 'Voksen')`, [t, ids.offer]).then(() => {}),
  "offers.offer_override": (c, t, ids) =>
    c.query(`insert into offers.offer_override (tenant_id, offer_id, occurrence_id, amount) values ($1, $2, $3, 40000)`,
      [t, ids.offer, ids.occurrence]).then(() => {}),
  "offers.effective_price": (c, t, ids) =>
    c.query(`insert into offers.effective_price (tenant_id, occurrence_id, offer_id, amount, amount_source, available, available_source)
              values ($1, $2, $3, 40000, 'override', true, 'default')`, [t, ids.occurrence, ids.offer]).then(() => {}),
  "offers.sales_channel": (c, t, ids) =>
    c.query(`insert into offers.sales_channel (id, tenant_id, code, name, kind) values ($1, $2, 'web', 'Web', 'ecom')`, [ids.channel, t]).then(() => {}),
  "offers.sku_mapping": (c, t, ids) =>
    c.query(`insert into offers.sku_mapping (tenant_id, vat_class_id, channel_id, external_sku) values ($1, $2, $3, 'TICKET-VAT0')`, [t, ids.vatClass, ids.channel]).then(() => {}),
  "offers.offer_channel": (c, t, ids) =>
    c.query(`insert into offers.offer_channel (tenant_id, offer_id, channel_id) values ($1, $2, $3)`, [t, ids.offer, ids.channel]).then(() => {}),
  "catalog.user_group": (c, t, ids) =>
    c.query(`insert into catalog.user_group (id, tenant_id, code, names) values ($1, $2, 'member', '{"nb":"Medlem"}')`, [ids.group, t]).then(() => {}),
  "catalog.event_access_group": (c, t, ids) =>
    c.query(`insert into catalog.event_access_group (tenant_id, event_id, group_id) values ($1, $2, $3)`, [t, ids.catalogEvent, ids.group]).then(() => {}),
  "offers.offer_access_group": (c, t, ids) =>
    c.query(`insert into offers.offer_access_group (tenant_id, offer_id, group_id) values ($1, $2, $3)`, [t, ids.offer, ids.group]).then(() => {}),
  "offers.offer_group_price": (c, t, ids) =>
    c.query(`insert into offers.offer_group_price (tenant_id, offer_id, group_id, amount) values ($1, $2, $3, 35000)`, [t, ids.offer, ids.group]).then(() => {}),
  "offers.offer_group_override": (c, t, ids) =>
    c.query(`insert into offers.offer_group_override (tenant_id, offer_id, occurrence_id, group_id, amount) values ($1, $2, $3, $4, 30000)`,
      [t, ids.offer, ids.occurrence, ids.group]).then(() => {}),
  "offers.effective_group_price": (c, t, ids) =>
    c.query(`insert into offers.effective_group_price (tenant_id, occurrence_id, offer_id, group_id, amount, amount_source) values ($1, $2, $3, $4, 35000, 'default')`,
      [t, ids.occurrence, ids.offer, ids.group]).then(() => {}),
  "sales.reservation": (c, t, ids) =>
    c.query(`insert into sales.reservation (id, tenant_id, channel_id, expires_at, locale) values ($1, $2, $3, now() + interval '15 minutes', 'nb')`,
      [ids.reservation, t, ids.channel]).then(() => {}),
  "sales.reservation_line": (c, t, ids) =>
    c.query(`insert into sales.reservation_line (id, tenant_id, reservation_id, line_no, occurrence_id, offer_id, quantity, places_per_unit, offer_code,
              unit_price, currency, vat_class_code, vat_rate_pct, external_sku, line_name, occurrence_start_utc, timezone)
              values ($1, $2, $3, 1, $4, $5, 1, 1, 'adult', 45000, 'NOK', 'exempt', 0, 'TICKET-VAT0', 'Voksen – Hamlet', now(), 'Europe/Oslo')`,
      [ids.line, t, ids.reservation, ids.occurrence, ids.offer]).then(() => {}),
  "sales.reservation_hold": (c, t, ids) =>
    c.query(`insert into sales.reservation_hold (tenant_id, reservation_id, occurrence_id, hold_id, places) values ($1, $2, $3, $4, 1)`,
      [t, ids.reservation, ids.occurrence, randomUUID()]).then(() => {}),
  "sales.ticket": (c, t, ids) =>
    c.query(`insert into sales.ticket (id, tenant_id, reservation_id, line_id, occurrence_id, offer_id) values ($1, $2, $3, $4, $5, $6)`,
      [ids.ticket, t, ids.reservation, ids.line, ids.occurrence, ids.offer]).then(() => {}),
  // After registrations and tickets: an admission belongs to one of them.
  "admission.admission": (c, t, ids) =>
    c.query(`insert into admission.admission (id, tenant_id, registration_id, ticket_id, occurrence_id, party_size) values ($1, $2, $3, null, $5, 1), ($6, $2, null, $4, $5, 1)`,
      [randomUUID(), t, ids.registration, ids.ticket, ids.occurrence, randomUUID()]).then(() => {}),
};

const randomRowIds = () => ({ vocabulary: randomUUID(), tag: randomUUID(), location: randomUUID(), catalogEvent: randomUUID(), occurrence: randomUUID(), series: randomUUID(), rule: randomUUID(), pool: randomUUID(), registration: randomUUID(), guestInvitation: randomUUID(), vatClass: randomUUID(), offer: randomUUID(), channel: randomUUID(), reservation: randomUUID(), line: randomUUID(), ticket: randomUUID(), group: randomUUID(), connection: randomUUID() });

let db: TestDatabase;
let admin: pg.Client;
let app: pg.Client;
let tables: string[];
const ids: Ids = { tenantA: randomUUID(), tenantB: randomUUID(), user: randomUUID(), event: randomUUID(), ...randomRowIds() };

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
  admin = new pg.Client({ connectionString: db.superuserUrl });
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
        const err = await fixtures[t]!(app, ids.tenantA, { ...ids, event: randomUUID(), ...randomRowIds() }).then(
          () => null,
          (e: { code?: string }) => e,
        );
        // 42501 = RLS check violation or missing grant; 23503 = FK to a row B cannot see.
        expect(err?.code, t).toMatch(/^(42501|23503)$/);
      });
    }
  });
});
