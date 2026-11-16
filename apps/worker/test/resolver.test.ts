import pg from "pg";
import { runOnce } from "graphile-worker";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDb, type Db, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { catalog, tenancy } from "@event-manager/domain";
import { defaultHandlers } from "../src/handlers.js";
import { buildTaskList } from "../src/tasks.js";

let tdb: TestDatabase;
let db: Db;
let admin: pg.Client;

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  admin = new pg.Client({ connectionString: tdb.superuserUrl });
  await admin.connect();
});
afterAll(async () => {
  await db?.destroy();
  await admin?.end();
  await tdb?.stop();
});

const work = async () => {
  await admin.query(`update graphile_worker._private_jobs set run_at = now()`);
  await runOnce({ connectionString: tdb.appUrl, taskList: buildTaskList(db, defaultHandlers) });
};

it("resolves rule changes on large events in the worker, once per burst of edits", async () => {
  const account = await tenancy.createAccount(db, { slug: "resolver", name: "R", ownerEmail: "o@r.test" });
  const userId = await tenancy.login(db, { issuer: "t", subject: "o", email: "o@r.test", name: null });
  const ctx = { tenantId: account.id, userId, clientId: null, roles: ["owner"] };
  const run = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db, ctx, fn);

  const { eventId, space, n } = await run(async (tx) => {
    const venue = await catalog.createLocation(tx, ctx, { kind: "venue", name: "Hall" });
    const space = await catalog.createLocation(tx, ctx, { kind: "space", parentId: venue.id, name: "Studio" });
    const e = await catalog.createEvent(tx, ctx, { translations: { nb: { title: "Verksted" } }, defaultLocationId: venue.id });
    // Four a day for 18 months: more than the inline limit.
    const s = await catalog.createSeries(tx, ctx, e.id, { rrule: "FREQ=DAILY;BYHOUR=9,10,11,12", dtstartLocal: "2027-01-01T09:00" }, { now: new Date("2027-01-01T00:00:00Z") });
    return { eventId: e.id, space, n: s.changes.counts.created };
  });
  expect(n).toBeGreaterThan(catalog.INLINE_RESOLVE_LIMIT);
  await work(); // dispatch the series' outbox events

  const created = await run((tx) => catalog.createRule(tx, ctx, eventId, { name: "Formiddag", conditions: { startTimeTo: "11:00" }, effects: [{ type: "location", value: space.id }] }));
  expect(created.resolution).toBe("queued");
  expect(created.preview.counts.changed).toBe(n / 2);
  const renamed = await run((tx) => catalog.updateRule(tx, ctx, created.rule!.id, 1, { conditions: { startTimeTo: "10:00" } }));
  expect(renamed).toMatchObject({ resolution: "queued", preview: { counts: { changed: n / 4 } } });

  // Until the worker runs, the previous values stay in place (and the public API serves them).
  const sources = async () => {
    const occs = await run((tx) => catalog.listOccurrences(tx, { eventId, limit: 10_000 }));
    return occs.filter((o) => o.effective.location?.source === "rule").length;
  };
  expect(await sources()).toBe(0);

  await work(); // dispatch: the resolver queues one job for both changes
  const jobs = await admin.query(`select count(*)::int as n from graphile_worker._private_jobs j join graphile_worker._private_tasks t on t.id = j.task_id where t.identifier = 'rules.resolve_event'`);
  expect(jobs.rows[0].n).toBe(1);
  await work(); // the resolve job
  expect(await sources()).toBe(n / 4);
  const unresolved = await admin.query(`select count(*)::int as n from catalog.occurrence where event_id = $1 and resolved_version is distinct from version`, [eventId]);
  expect(unresolved.rows[0].n).toBe(0);
});
