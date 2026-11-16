import pg from "pg";
import { runOnce } from "graphile-worker";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDb, type Db, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { tenancy } from "@event-manager/domain";
import { buildTaskList } from "../src/tasks.js";
import type { InternalHandler } from "../src/handlers.js";

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

it("dispatches outbox events to handlers once, under the event's tenant, as the runtime role", async () => {
  const account = await tenancy.createAccount(db, { slug: "worker-test", name: "W", ownerEmail: "o@w.test" });
  const userId = await tenancy.login(db, { issuer: "t", subject: "o", email: "o@w.test", name: null });
  const ctx = { tenantId: account.id, userId, clientId: null, roles: ["owner"] };
  await withTenant(db, ctx, (tx) => tenancy.updateAccountSettings(tx, ctx, account.version, { name: "W2" }));

  const seen: { type: string; tenant: string }[] = [];
  const recorder: InternalHandler = {
    name: "recorder",
    types: "*",
    async handle(tx, event) {
      // The handler's transaction is tenant-scoped: it can read the account.
      const a = await tenancy.getAccount(tx);
      seen.push({ type: event.type, tenant: a.id });
    },
  };

  // Run twice: the second run must not call the handler again (idempotent on event id).
  await runOnce({ connectionString: tdb.appUrl, taskList: buildTaskList(db, [recorder]) });
  await admin.query(`update graphile_worker._private_jobs set run_at = now()`);
  await runOnce({ connectionString: tdb.appUrl, taskList: buildTaskList(db, [recorder]) });

  expect(seen.map((s) => s.type).sort()).toEqual(["account.changed.v1", "account.created.v1"]);
  expect(seen.every((s) => s.tenant === account.id)).toBe(true);

  const res = await admin.query(`select count(*)::int as n from outbox.event where tenant_id = $1 and dispatched_at is null`, [account.id]);
  expect(res.rows[0].n).toBe(0);
});
