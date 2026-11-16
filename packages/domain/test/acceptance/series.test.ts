import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, sql, type Tx, withoutTenant, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { type ActorContext, catalog, tenancy } from "../../src/index.js";

// Acceptance scenarios for milestone 3 (docs/mvp.md): the guided tour, the 18-month
// horizon and the DST change, against a real Postgres with RLS.

let tdb: TestDatabase;
let db: Db;
let ctx: ActorContext;

const OSLO = "Europe/Oslo";
const run = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(db, ctx, fn);
const localStart = (o: catalog.Occurrence) => catalog.utcToLocal(o.startUtc, OSLO);
const all = (eventId: string) => run((tx) => catalog.listOccurrences(tx, { eventId, limit: 5000 }));

async function newEvent(title: string) {
  return run((tx) => catalog.createEvent(tx, ctx, { translations: { nb: { title } }, defaultDurationMin: 60 }));
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  const account = await tenancy.createAccount(db, { slug: "series", name: "Series", ownerEmail: "owner@series.test" });
  const userId = await tenancy.login(db, { issuer: "https://idp.test", subject: "owner@series.test", email: "owner@series.test", name: null });
  ctx = { tenantId: account.id, userId, clientId: null, roles: ["owner"] };
});
afterAll(async () => {
  await db?.destroy();
  await tdb?.stop();
});

describe("acceptance: guided tour", () => {
  it("Mon/Wed/Fri 14:00 for 8 weeks; one cancelled, one moved; changing to 15:00 moves the rest and flags the moved one", async () => {
    const now = new Date("2027-01-01T12:00:00Z");
    const venue = await run((tx) => catalog.createLocation(tx, ctx, { kind: "venue", name: "MUNCH" }));
    const space = await run((tx) => catalog.createLocation(tx, ctx, { kind: "space", parentId: venue.id, name: "Floor 12" }));
    const event = await newEvent("Omvisning");

    const created = await run((tx) =>
      catalog.createSeries(tx, ctx, event.id, { rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=24", dtstartLocal: "2027-01-04T14:00" }, { now }),
    );
    expect(created.changes.counts.created).toBe(24);
    expect(created.series).toMatchObject({ complete: true, timezone: OSLO, durationMin: 60 });
    let occs = await all(event.id);
    expect(occs).toHaveLength(24);
    expect(occs.every((o) => localStart(o).endsWith("T14:00:00"))).toBe(true);
    expect(occs.at(-1)!.recurrenceIdLocal).toBe("2027-02-26T14:00:00"); // 8th Friday

    const cancelled = occs[3]!;
    const moved = occs[5]!;
    await run((tx) => catalog.updateOccurrence(tx, ctx, cancelled.id, cancelled.version, { status: "cancelled" }));
    await run((tx) => catalog.updateOccurrence(tx, ctx, moved.id, moved.version, { locationOverrideId: space.id }));

    const preview = await run((tx) => catalog.updateSeries(tx, ctx, created.series!.id, created.series!.version, { dtstartLocal: "2027-01-04T15:00" }, { now, dryRun: true }));
    expect(preview.changes.counts).toEqual({ created: 0, moved: 23, deleted: 0, conflicts: 1, unchanged: 0 });
    expect(await all(event.id)).toEqual(occs.map((o) => expect.objectContaining({ id: o.id }))); // dry run changed nothing
    expect((await all(event.id)).every((o) => localStart(o).endsWith("T14:00:00"))).toBe(true);

    const changed = await run((tx) => catalog.updateSeries(tx, ctx, created.series!.id, created.series!.version, { dtstartLocal: "2027-01-04T15:00" }, { now }));
    expect(changed.changes.conflicts).toMatchObject([{ occurrenceId: moved.id, reason: "moved" }]);

    occs = await all(event.id);
    expect(occs.map((o) => o.id).sort()).toEqual(created.changes.created.map((c) => c.occurrenceId).sort()); // same IDs
    for (const o of occs) {
      if (o.id === moved.id) {
        expect(localStart(o)).toBe("2027-01-15T14:00:00");
        expect(o).toMatchObject({ detached: true, conflict: true, effective: { location: { value: space.id, source: "override" } } });
      } else {
        expect(localStart(o)).toMatch(/T15:00:00$/);
        expect(o.conflict).toBe(false);
      }
    }
    expect(occs.find((o) => o.id === cancelled.id)).toMatchObject({ status: "cancelled", detached: false });

    // Putting the moved one back on its slot clears the conflict and the override.
    const back = await run((tx) => catalog.reattachOccurrence(tx, ctx, moved.id, occs.find((o) => o.id === moved.id)!.version));
    expect(back).toMatchObject({ detached: false, conflict: false, overrides: { locationId: null } });
    expect(localStart(back)).toBe("2027-01-15T15:00:00");
  });

  it("delete this occurrence excludes its slot; this and following splits the series", async () => {
    const now = new Date("2027-01-01T12:00:00Z");
    const event = await newEvent("Split");
    const { series } = await run((tx) => catalog.createSeries(tx, ctx, event.id, { rrule: "FREQ=DAILY;COUNT=10", dtstartLocal: "2027-01-04T10:00" }, { now }));
    let occs = await all(event.id);

    await run((tx) => catalog.deleteOccurrence(tx, ctx, occs[1]!.id, occs[1]!.version));
    const afterDelete = await run((tx) => catalog.getSeries(tx, series!.id));
    expect(afterDelete.exdates).toEqual(["2027-01-05T10:00:00"]);
    // Regenerating does not bring the slot back.
    const again = await run((tx) => catalog.updateSeries(tx, ctx, series!.id, afterDelete.version, { durationMin: 45 }, { now }));
    expect(again.changes.counts).toMatchObject({ created: 0, moved: 9 });

    occs = await all(event.id);
    const at = occs[5]!; // 2027-01-10
    const split = await run((tx) => catalog.splitSeries(tx, ctx, series!.id, again.series!.version, at.recurrenceIdLocal!, { dtstartLocal: "2027-01-10T18:00" }, { now }));
    expect(split.series).toMatchObject({ rrule: "FREQ=DAILY;COUNT=4", dtstartLocal: "2027-01-10T18:00:00" });
    const head = await run((tx) => catalog.getSeries(tx, series!.id));
    expect(head).toMatchObject({ rrule: "FREQ=DAILY;UNTIL=20270110T095959", complete: true });

    occs = await all(event.id);
    expect(occs).toHaveLength(9);
    expect(occs.filter((o) => o.seriesId === series!.id).map(localStart)).toEqual([
      "2027-01-04T10:00:00", "2027-01-06T10:00:00", "2027-01-07T10:00:00", "2027-01-08T10:00:00", "2027-01-09T10:00:00",
    ]);
    const tail = occs.filter((o) => o.seriesId === split.series!.id);
    expect(tail.map(localStart)).toEqual(["2027-01-10T18:00:00", "2027-01-11T18:00:00", "2027-01-12T18:00:00", "2027-01-13T18:00:00"]);
    expect(tail[0]!.id).toBe(at.id); // the occurrence moved to the new series, same ID

    // Deleting a series keeps hand-edited occurrences as one-offs.
    await run((tx) => catalog.updateOccurrence(tx, ctx, tail[1]!.id, tail[1]!.version, { externalUrlOverride: "https://tix.example/x" }));
    const deleted = await run((tx) => catalog.deleteSeries(tx, ctx, split.series!.id, split.series!.version, { now }));
    expect(deleted.counts).toMatchObject({ deleted: 3, unchanged: 1 });
    expect((await all(event.id)).find((o) => o.id === tail[1]!.id)).toMatchObject({ seriesId: null, recurrenceIdLocal: null, detached: true });
  });
});

describe("acceptance: an open-ended weekly series always has occurrences 18 months ahead", () => {
  it("generates to the horizon and the nightly job extends it", async () => {
    const event = await newEvent("Weekly");
    const created = new Date("2027-01-01T12:00:00Z");
    const { series } = await run((tx) => catalog.createSeries(tx, ctx, event.id, { rrule: "FREQ=WEEKLY;BYDAY=TH", dtstartLocal: "2027-01-07T18:00" }, { now: created }));
    expect(series).toMatchObject({ complete: false, generatedUntil: new Date("2028-07-01T12:00:00Z") });
    let last = (await all(event.id)).at(-1)!;
    expect(last.startUtc.getTime()).toBeGreaterThan(new Date("2028-06-24T00:00:00Z").getTime());

    // Two months later the job finds the series (across tenants, by id only) and extends it.
    const later = new Date("2027-03-01T02:00:00Z");
    const due = await withoutTenant(db, (tx) => sql<{ tenant_id: string; series_id: string }>`select * from catalog.series_due_for_extension(${later})`.execute(tx));
    expect(due.rows).toContainEqual({ tenant_id: ctx.tenantId, series_id: series!.id });
    const added = await run((tx) => catalog.extendSeriesHorizon(tx, ctx.tenantId, series!.id, later));
    expect(added).toBe(9);
    last = (await all(event.id)).at(-1)!;
    expect(last.startUtc.getTime()).toBeGreaterThan(new Date("2028-08-24T00:00:00Z").getTime());
    expect(last.startUtc.getTime()).toBeLessThanOrEqual(new Date("2028-09-01T02:00:00Z").getTime());

    // Right after, nothing is due.
    const dueNow = await withoutTenant(db, (tx) => sql<{ series_id: string }>`select series_id from catalog.series_due_for_extension(${later})`.execute(tx));
    expect(dueNow.rows.map((r) => r.series_id)).not.toContain(series!.id);
    // Every generated occurrence is resolved, so the public API can show it.
    const unresolved = await run((tx) => tx.selectFrom("catalog.occurrence").select("id").where("event_id", "=", event.id).where(sql<boolean>`resolved_version is distinct from version`).execute());
    expect(unresolved).toEqual([]);
  });
});

describe("acceptance: a series crossing the DST change keeps its local start time", () => {
  it("stores the right instants and keeps 14:00 after the clocks change", async () => {
    const event = await newEvent("DST");
    await run((tx) => catalog.createSeries(tx, ctx, event.id, { rrule: "FREQ=WEEKLY;BYDAY=SA;UNTIL=20270410T235959", dtstartLocal: "2027-03-20T14:00" }, { now: new Date("2027-03-01Z") }));
    const occs = await all(event.id);
    expect(occs.map((o) => o.startUtc.toISOString())).toEqual([
      "2027-03-20T13:00:00.000Z", "2027-03-27T13:00:00.000Z", "2027-04-03T12:00:00.000Z", "2027-04-10T12:00:00.000Z",
    ]);
    expect(occs.map(localStart).every((l) => l.endsWith("T14:00:00"))).toBe(true);
  });
});
