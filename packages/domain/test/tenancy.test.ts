import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { DomainError, type ActorContext, tenancy } from "../src/index.js";

let tdb: TestDatabase;
let db: Db;
let admin: pg.Client;

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  admin = new pg.Client({ connectionString: tdb.migratorUrl });
  await admin.connect();
});
afterAll(async () => {
  await db?.destroy();
  await admin?.end();
  await tdb?.stop();
});

async function bootstrap(slug: string, email: string) {
  const account = await tenancy.createAccount(db, { slug, name: slug.toUpperCase(), ownerEmail: email });
  const userId = await tenancy.login(db, { issuer: "https://idp.test", subject: email, email, name: "Owner" });
  const ctx: ActorContext = { tenantId: account.id, userId, clientId: null, roles: ["owner"] };
  return { account, userId, ctx };
}

describe("tenancy", () => {
  it("first sign-in accepts the owner invitation", async () => {
    const { account, userId } = await bootstrap("munch", "owner@munch.test");
    const accounts = await tenancy.myAccounts(db, userId);
    expect(accounts).toEqual([{ accountId: account.id, slug: "munch", name: "MUNCH", roles: ["owner"] }]);
    const roles = await withTenant(db, { tenantId: account.id }, (tx) => tenancy.rolesInTenant(tx, userId));
    expect(roles).toEqual(["owner"]);
  });

  it("updates settings with optimistic concurrency, audit and outbox in one transaction", async () => {
    const { account, ctx } = await bootstrap("nm", "owner@nm.test");
    const updated = await withTenant(db, ctx, (tx) =>
      tenancy.updateAccountSettings(tx, ctx, account.version, { name: "Nasjonalmuseet", locales: ["nb", "en", "nn"] }),
    );
    expect(updated.version).toBe(account.version + 1);

    const audit = await withTenant(db, ctx, (tx) => tenancy.listAudit(tx, { entityType: "account", entityId: account.id, limit: 10 }));
    expect(audit[0]).toMatchObject({ action: "account.updated", actor: { userId: ctx.userId, email: "owner@nm.test" } });
    expect(audit[0]!.diff).toMatchObject({ name: { from: "NM", to: "Nasjonalmuseet" } });

    const jobs = await admin.query(`select j.payload from graphile_worker._private_jobs j join graphile_worker._private_tasks t on t.id = j.task_id
        where t.identifier = 'outbox.dispatch' and j.payload->>'tenantId' = $1::text`, [account.id]);
    expect(jobs.rowCount).toBeGreaterThanOrEqual(2); // account.created + account.changed

    await expect(
      withTenant(db, ctx, (tx) => tenancy.updateAccountSettings(tx, ctx, account.version, { name: "Stale" })),
    ).rejects.toMatchObject({ code: "version_conflict" });
  });

  it("a rolled-back change leaves no audit entry, event or job", async () => {
    const { account, ctx } = await bootstrap("rollback", "owner@rb.test");
    const count = async () => {
      const r = await admin.query(
        `select (select count(*) from outbox.event where tenant_id = $1)::int as events,
                (select count(*) from tenancy.audit_log where tenant_id = $1)::int as audits,
                (select count(*) from graphile_worker._private_jobs where payload->>'tenantId' = $1::text)::int as jobs`, [account.id]);
      return r.rows[0];
    };
    const before = await count();
    await expect(
      withTenant(db, ctx, async (tx) => {
        await tenancy.updateAccountSettings(tx, ctx, account.version, { name: "Never" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await count()).toEqual(before);
  });

  it("editors cannot change account settings", async () => {
    const { account, ctx } = await bootstrap("editor-test", "owner@ed.test");
    const editor: ActorContext = { ...ctx, roles: ["editor"] };
    const err = await withTenant(db, ctx, (tx) => tenancy.updateAccountSettings(tx, editor, account.version, { name: "x" })).catch((e) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect(err.code).toBe("forbidden");
  });

  it("rejects an unknown timezone and a default locale outside the list", async () => {
    const { account, ctx } = await bootstrap("validation", "owner@val.test");
    await expect(withTenant(db, ctx, (tx) => tenancy.updateAccountSettings(tx, ctx, account.version, { defaultTimezone: "Mars/Olympus" })))
      .rejects.toMatchObject({ code: "validation_failed" });
    await expect(withTenant(db, ctx, (tx) => tenancy.updateAccountSettings(tx, ctx, account.version, { locales: ["en"] })))
      .rejects.toMatchObject({ code: "validation_failed" });
  });

  it("invited editors join on sign-in; members of other tenants stay invisible", async () => {
    const a = await bootstrap("tenant-a", "owner@a.test");
    const b = await bootstrap("tenant-b", "owner@b.test");
    await withTenant(db, a.ctx, (tx) => tenancy.inviteMember(tx, a.ctx, "Editor@A.test", "editor"));
    const editorId = await tenancy.login(db, { issuer: "https://idp.test", subject: "editor-a", email: "editor@a.test", name: null });

    const membersA = await withTenant(db, a.ctx, (tx) => tenancy.listMembers(tx));
    expect(membersA.map((m) => m.email).sort()).toEqual(["editor@a.test", "owner@a.test"]);
    const membersB = await withTenant(db, b.ctx, (tx) => tenancy.listMembers(tx));
    expect(membersB.map((m) => m.email)).toEqual(["owner@b.test"]);
    expect(await tenancy.myAccounts(db, editorId)).toHaveLength(1);
  });

  it("refuses to remove the last owner", async () => {
    const { ctx, userId } = await bootstrap("last-owner", "owner@lo.test");
    const other: ActorContext = { ...ctx, userId: null };
    await expect(withTenant(db, ctx, (tx) => tenancy.removeMember(tx, other, userId))).rejects.toMatchObject({ code: "conflict" });
  });
});
