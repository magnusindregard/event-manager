import { parseCrontab } from "graphile-worker";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDb, type Db, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { catalog, tenancy } from "@event-manager/domain";
import { extendHorizons, HORIZON_CRONTAB, HORIZON_TASK } from "../src/horizon.js";

let tdb: TestDatabase;
let db: Db;

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
});
afterAll(async () => {
  await db?.destroy();
  await tdb?.stop();
});

it("extends open-ended series in every tenant to that tenant's horizon", async () => {
  const created = new Date("2027-01-01T00:00:00Z");
  const seriesIds: string[] = [];
  for (const [slug, months] of [["h-a", 18], ["h-b", 6]] as const) {
    const account = await tenancy.createAccount(db, { slug, name: slug, ownerEmail: `o@${slug}.test` });
    const userId = await tenancy.login(db, { issuer: "t", subject: slug, email: `o@${slug}.test`, name: null });
    const ctx = { tenantId: account.id, userId, clientId: null, roles: ["owner"] };
    const id = await withTenant(db, ctx, async (tx) => {
      await tenancy.updateAccountSettings(tx, ctx, account.version, { horizonMonths: months });
      const e = await catalog.createEvent(tx, ctx, { translations: { nb: { title: "Ukentlig" } } });
      return (await catalog.createSeries(tx, ctx, e.id, { rrule: "FREQ=WEEKLY", dtstartLocal: "2027-01-04T12:00" }, { now: created })).series!.id;
    });
    seriesIds.push(id);
  }

  const later = new Date("2027-02-01T02:00:00Z");
  const r = await extendHorizons(db, later, () => {});
  expect(r).toEqual({ series: 2, created: 9, failed: 0 }); // about a month of weekly slots in each tenant
  expect(await extendHorizons(db, later, () => {})).toEqual({ series: 0, created: 0, failed: 0 });
});

it("has a crontab graphile-worker accepts", () => {
  expect(parseCrontab(HORIZON_CRONTAB)).toMatchObject([{ task: HORIZON_TASK }]);
});
