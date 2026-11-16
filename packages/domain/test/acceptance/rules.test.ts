import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, type Tx, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { type ActorContext, catalog, tenancy } from "../../src/index.js";

// Acceptance scenario for milestone 4 (docs/mvp.md): "A rule '1 June–31 August, start ≥
// 18:00 → location: Rooftop, tag: late opening' applies to all matching occurrences,
// including ones added later by extending the series."

let tdb: TestDatabase;
let db: Db;
let ctx: ActorContext;

const OSLO = "Europe/Oslo";
const run = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(db, ctx, fn);
const all = (eventId: string) => run((tx) => catalog.listOccurrences(tx, { eventId, limit: 5000 }));
const local = (o: catalog.Occurrence) => catalog.utcToLocal(o.startUtc, OSLO);
const summerEvening = (o: catalog.Occurrence) => {
  const l = local(o);
  return l >= "2027-06-01" && l < "2027-09-01" && l.slice(11, 16) >= "18:00";
};

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  const account = await tenancy.createAccount(db, { slug: "rules", name: "Rules", ownerEmail: "owner@rules.test" });
  const userId = await tenancy.login(db, { issuer: "https://idp.test", subject: "owner@rules.test", email: "owner@rules.test", name: null });
  ctx = { tenantId: account.id, userId, clientId: null, roles: ["owner"] };
});
afterAll(async () => {
  await db?.destroy();
  await tdb?.stop();
});

describe("acceptance: rooftop late opening", () => {
  it("applies to every matching occurrence, including ones the horizon job adds later", async () => {
    const { venue, rooftop, floor, late, event, seriesId } = await run(async (tx) => {
      const account = await tenancy.getAccount(tx);
      // A short horizon, so the summer is generated only when the nightly job extends the series.
      await tenancy.updateAccountSettings(tx, ctx, account.version, { horizonMonths: 3 });
      const venue = await catalog.createLocation(tx, ctx, { kind: "venue", name: "MUNCH" });
      const rooftop = await catalog.createLocation(tx, ctx, { kind: "space", parentId: venue.id, name: "Rooftop" });
      const floor = await catalog.createLocation(tx, ctx, { kind: "space", parentId: venue.id, name: "Floor 12" });
      const vocab = await catalog.createVocabulary(tx, ctx, { key: "program", labels: { nb: "Program" } });
      const late = await catalog.createTag(tx, ctx, vocab.id, { key: "late-opening", labels: { nb: "Kveldsåpent", en: "Late opening" } });
      const event = await catalog.createEvent(tx, ctx, {
        translations: { nb: { title: "Omvisning" } }, defaultLocationId: floor.id, defaultDurationMin: 60,
        admissionMode: "external", externalUrl: "https://tickets.test/omvisning",
      });
      // Open-ended: every day at 14:00 and 19:00.
      const s = await catalog.createSeries(tx, ctx, event.id, { rrule: "FREQ=DAILY;BYHOUR=14,19", dtstartLocal: "2027-03-01T14:00" }, { now: new Date("2027-03-01T00:00:00Z") });
      return { venue, rooftop, floor, late, event, seriesId: s.series!.id };
    });
    expect((await all(event.id)).some(summerEvening)).toBe(false); // generated through May only

    const rooftopRule = {
      name: "Sommerkveld", priority: 10,
      conditions: { dateFrom: "2027-06-01", dateTo: "2027-08-31", startTimeFrom: "18:00" },
      effects: [{ type: "location", value: rooftop.id }, { type: "tags", value: { add: [late.id] } }],
    };
    const preview = await run((tx) => catalog.createRule(tx, ctx, event.id, rooftopRule, { dryRun: true }));
    expect(preview).toMatchObject({ rule: null, resolution: "none", preview: { counts: { matched: 0, changed: 0 } } });
    const created = await run((tx) => catalog.createRule(tx, ctx, event.id, rooftopRule));
    expect(created.rule).toMatchObject({ name: "Sommerkveld", priority: 10, active: true, conditions: { dateFrom: "2027-06-01", dateTo: "2027-08-31", startTimeFrom: "18:00", startTimeTo: null, weekdays: null } });
    const ruleId = created.rule!.id;

    // The nightly job extends the series into and past the summer; each night adds a few days.
    for (const night of ["2027-03-15", "2027-04-15", "2027-05-15", "2027-06-15", "2027-07-15"]) {
      await run((tx) => catalog.extendSeriesHorizon(tx, ctx.tenantId, seriesId, new Date(`${night}T02:00:00Z`)));
    }
    let occs = await all(event.id);
    expect(occs.at(-1)!.startUtc > new Date("2027-10-01T00:00:00Z")).toBe(true);
    const evenings = occs.filter(summerEvening);
    expect(evenings).toHaveLength(92 * 1); // 1 June–31 August, one evening slot a day
    for (const o of occs) {
      if (summerEvening(o)) {
        expect(o.effective, local(o)).toEqual({
          location: { value: rooftop.id, source: "rule", ruleId },
          tags: { value: [late.id], source: "rule", ruleId },
          externalUrl: { value: "https://tickets.test/omvisning", source: "default", ruleId: null },
        });
      } else {
        expect(o.effective, local(o)).toMatchObject({ location: { value: floor.id, source: "default" }, tags: { value: [], source: "default" } });
      }
    }

    // An override still wins over the rule.
    const pick = evenings[10]!;
    const edited = await run((tx) => catalog.updateOccurrence(tx, ctx, pick.id, pick.version, { locationOverrideId: venue.id }));
    expect(edited.effective.location).toEqual({ value: venue.id, source: "override", ruleId: null });
    expect(edited.effective.tags).toEqual({ value: [late.id], source: "rule", ruleId });

    // Narrowing the rule to Wednesdays: the preview says what changes, and saving applies it.
    const narrow = await run((tx) => catalog.updateRule(tx, ctx, ruleId, created.rule!.version, { conditions: { weekdays: [3] } }, { dryRun: true }));
    const wednesdays = evenings.filter((o) => new Date(`${local(o).slice(0, 10)}T00:00:00Z`).getUTCDay() === 3).length;
    expect(narrow.preview.counts).toEqual({ matched: wednesdays, changed: 92 - wednesdays, overridden: 0, conflicts: 0 });
    const saved = await run((tx) => catalog.updateRule(tx, ctx, ruleId, created.rule!.version, { conditions: { weekdays: [3] } }));
    expect(saved).toMatchObject({ resolution: "done", rule: { version: 2, conditions: { weekdays: [3], dateFrom: "2027-06-01" } } });
    occs = await all(event.id);
    expect(occs.filter((o) => o.effective.location?.source === "rule")).toHaveLength(wednesdays - (new Date(`${local(pick).slice(0, 10)}T00:00:00Z`).getUTCDay() === 3 ? 1 : 0));

    // A second rule of equal priority on the same field is reported as a conflict.
    const tie = await run((tx) => catalog.createRule(tx, ctx, event.id, {
      name: "Onsdager", priority: 10, conditions: { weekdays: [3] }, effects: [{ type: "location", value: floor.id }],
    }, { dryRun: true }));
    expect(tie.preview.counts.conflicts).toBe(wednesdays);
    expect(tie.preview.conflicts[0]!.ruleIds).toEqual([ruleId, expect.any(String)]);

    // Deleting the rule puts every occurrence back on the event's defaults.
    const deleted = await run((tx) => catalog.deleteRule(tx, ctx, ruleId, 2));
    expect(deleted.rule).toBeNull();
    occs = await all(event.id);
    expect(occs.every((o) => o.effective.location?.source !== "rule" && o.effective.tags?.source === "default")).toBe(true);

    const audit = await run((tx) => tenancy.listAudit(tx, { entityType: "event", entityId: event.id, limit: 100 }));
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["rule.created", "rule.updated", "rule.deleted"]));
  });

  it("bulk overrides many occurrences at once, all or nothing", async () => {
    const { event, space } = await run(async (tx) => {
      const venue = await catalog.createLocation(tx, ctx, { kind: "venue", name: "Bjørvika" });
      const space = await catalog.createLocation(tx, ctx, { kind: "space", parentId: venue.id, name: "Auditorium" });
      const event = await catalog.createEvent(tx, ctx, { translations: { nb: { title: "Foredrag" } } });
      await catalog.createSeries(tx, ctx, event.id, { rrule: "FREQ=WEEKLY;COUNT=6", dtstartLocal: "2027-03-02T18:00" }, { now: new Date("2027-01-01T00:00:00Z") });
      return { event, space };
    });
    const occs = await all(event.id);
    const items = occs.slice(0, 4).map((o) => ({ id: o.id, version: o.version }));
    const stale = [...items.slice(0, 3), { ...items[3]!, version: items[3]!.version + 5 }];
    await expect(run((tx) => catalog.bulkUpdateOccurrences(tx, ctx, event.id, stale, { locationOverrideId: space.id }))).rejects.toMatchObject({ code: "version_conflict" });
    expect((await all(event.id)).every((o) => o.overrides.locationId === null)).toBe(true);

    const updated = await run((tx) => catalog.bulkUpdateOccurrences(tx, ctx, event.id, items, { locationOverrideId: space.id }));
    expect(updated).toHaveLength(4);
    expect(updated.every((o) => o.detached && o.effective.location?.source === "override" && o.effective.location.value === space.id)).toBe(true);
    const audit = await run((tx) => tenancy.listAudit(tx, { entityType: "event", entityId: event.id, limit: 10 }));
    expect(audit[0]).toMatchObject({ action: "occurrence.bulk_updated", diff: { count: 4, changed: 4 } });
  });
});
