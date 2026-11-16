import { describe, expect, it } from "vitest";
import { DomainError, rules } from "../src/index.js";

// Rule engine (docs/implementation-plan.md, "Rules"): matching in event-local time,
// priority, ties, effect handlers and the preview.

const any: rules.Conditions = { dateFrom: null, dateTo: null, weekdays: null, startTimeFrom: null, startTimeTo: null };
const LOC_A = "0190a000-0000-7000-8000-00000000000a";
const LOC_B = "0190a000-0000-7000-8000-00000000000b";
const TAG_1 = "0190a000-0000-7000-8000-000000000001";
const TAG_2 = "0190a000-0000-7000-8000-000000000002";
const TAG_3 = "0190a000-0000-7000-8000-000000000003";

const rule = (id: string, over: Partial<rules.RuleDef> = {}): rules.RuleDef => ({
  id, name: id, priority: 0, active: true, conditions: any, effects: [{ type: "location", targetRef: null, value: LOC_A }], ...over,
});
const defaults: rules.FieldValues = { location: LOC_B, tags: [TAG_1], externalUrl: "https://tickets.test/default" };

describe("matching", () => {
  it("checks dates inclusively, weekdays and the start-time window", () => {
    const summerEvening: rules.Conditions = { ...any, dateFrom: "2027-06-01", dateTo: "2027-08-31", startTimeFrom: "18:00" };
    expect(rules.matches(summerEvening, "2027-06-01T18:00:00")).toBe(true);
    expect(rules.matches(summerEvening, "2027-08-31T21:30:00")).toBe(true);
    expect(rules.matches(summerEvening, "2027-05-31T19:00:00")).toBe(false);
    expect(rules.matches(summerEvening, "2027-09-01T19:00:00")).toBe(false);
    expect(rules.matches(summerEvening, "2027-07-01T17:59:00")).toBe(false);

    const wednesdays: rules.Conditions = { ...any, weekdays: [3] };
    expect(rules.matches(wednesdays, "2027-06-02T12:00:00")).toBe(true); // a Wednesday
    expect(rules.matches(wednesdays, "2027-06-03T12:00:00")).toBe(false);
    expect(rules.isoWeekday("2027-06-06")).toBe(7); // Sunday
  });

  it("treats the end of the window as exclusive and wraps past midnight", () => {
    const morning: rules.Conditions = { ...any, startTimeFrom: "09:00", startTimeTo: "12:00" };
    expect(rules.matches(morning, "2027-01-01T09:00:00")).toBe(true);
    expect(rules.matches(morning, "2027-01-01T12:00:00")).toBe(false);
    const night: rules.Conditions = { ...any, startTimeFrom: "22:00", startTimeTo: "02:00" };
    expect(rules.matches(night, "2027-01-01T23:00:00")).toBe(true);
    expect(rules.matches(night, "2027-01-01T01:30:00")).toBe(true);
    expect(rules.matches(night, "2027-01-01T02:00:00")).toBe(false);
    expect(rules.matches(night, "2027-01-01T12:00:00")).toBe(false);
  });

  it("validates and normalizes conditions", () => {
    expect(rules.normalizeConditions({ weekdays: [5, 3, 3], startTimeFrom: "18:00:00" })).toEqual({ ...any, weekdays: [3, 5], startTimeFrom: "18:00" });
    expect(rules.normalizeConditions({ weekdays: [] }).weekdays).toBeNull();
    expect(() => rules.normalizeConditions({ dateFrom: "2027-02-30" })).toThrow(DomainError);
    expect(() => rules.normalizeConditions({ dateFrom: "2027-09-01", dateTo: "2027-06-01" })).toThrow(/before the start/);
    expect(() => rules.normalizeConditions({ weekdays: [0] })).toThrow(/Weekdays/);
    expect(() => rules.normalizeConditions({ startTimeFrom: "25:00" })).toThrow(DomainError);
    expect(() => rules.normalizeConditions({ startTimeFrom: "10:00", startTimeTo: "10:00" })).toThrow(/empty/);
  });
});

describe("effects", () => {
  it("validates values per effect type", () => {
    expect(rules.normalizeEffects([{ type: "tags", value: { add: [TAG_2, TAG_2] } }])).toEqual([{ type: "tags", targetRef: null, value: { add: [TAG_2], remove: [] } }]);
    expect(() => rules.normalizeEffects([])).toThrow(/at least one/);
    expect(() => rules.normalizeEffects([{ type: "price", value: 100 }])).toThrow(/Unknown effect type/);
    expect(() => rules.normalizeEffects([{ type: "location", value: "rooftop" }])).toThrow(/location id/);
    expect(() => rules.normalizeEffects([{ type: "externalUrl", value: "ftp://x" }])).toThrow(/http/);
    expect(() => rules.normalizeEffects([{ type: "location", targetRef: "offer-1", value: LOC_A }])).toThrow(/no targetRef/);
    expect(() => rules.normalizeEffects([{ type: "location", value: LOC_A }, { type: "location", value: LOC_B }])).toThrow(/already has/);
    expect(() => rules.normalizeEffects([{ type: "tags", value: { add: [TAG_1], remove: [TAG_1] } }])).toThrow(/both/);
  });

  it("lists referenced locations and tags", () => {
    const effects = rules.normalizeEffects([{ type: "location", value: LOC_A }, { type: "tags", value: { add: [TAG_2], remove: [TAG_1] } }]);
    expect(rules.effectRefs(effects)).toEqual({ locations: [LOC_A], tags: [TAG_2, TAG_1] });
  });
});

describe("resolution", () => {
  const at = (startLocal: string, overrides: Partial<rules.FieldValues> = {}) => ({ defaults, overrides, startLocal });

  it("override → highest-priority matching rule → default, per field", () => {
    const low = rule("0190a000-0000-7000-8000-0000000000r1", { priority: 0 });
    const high = rule("0190a000-0000-7000-8000-0000000000r2", { priority: 10, effects: [{ type: "location", targetRef: null, value: LOC_B }, { type: "externalUrl", targetRef: null, value: "https://tickets.test/evening" }] });
    const r = rules.resolve(at("2027-06-02T19:00:00"), rules.ordered([low, high]));
    expect(r.values.location).toEqual({ value: LOC_B, source: "rule", ruleId: high.id });
    expect(r.values.externalUrl).toEqual({ value: "https://tickets.test/evening", source: "rule", ruleId: high.id });
    expect(r.values.tags).toEqual({ value: [TAG_1], source: "default", ruleId: null });
    expect(r.ties).toEqual([]);

    const o = rules.resolve(at("2027-06-02T19:00:00", { location: LOC_A }), rules.ordered([low, high]));
    expect(o.values.location).toEqual({ value: LOC_A, source: "override", ruleId: null });
  });

  it("ignores inactive and non-matching rules", () => {
    const off = rule("0190a000-0000-7000-8000-0000000000r1", { active: false });
    const mornings = rule("0190a000-0000-7000-8000-0000000000r2", { conditions: { ...any, startTimeTo: "12:00" } });
    expect(rules.resolve(at("2027-06-02T19:00:00"), rules.ordered([off, mornings])).values.location.source).toBe("default");
  });

  it("on equal priority the older rule wins and the tie is reported", () => {
    const older = rule("0190a000-0000-7000-8000-0000000000r1");
    const newer = rule("0190a000-0000-7000-8000-0000000000r2", { effects: [{ type: "location", targetRef: null, value: LOC_B }] });
    const r = rules.resolve(at("2027-06-02T19:00:00"), rules.ordered([newer, older]));
    expect(r.values.location.ruleId).toBe(older.id);
    expect(r.ties).toEqual([{ field: "location", ruleIds: [older.id, newer.id] }]);
  });

  it("tags rules add to and remove from the event's tags", () => {
    const late = rule("0190a000-0000-7000-8000-0000000000r1", { effects: [{ type: "tags", targetRef: null, value: { add: [TAG_3, TAG_2], remove: [TAG_1] } }] });
    expect(rules.resolve(at("2027-06-02T19:00:00"), [late]).values.tags).toEqual({ value: [TAG_2, TAG_3], source: "rule", ruleId: late.id });
  });
});

describe("preview", () => {
  it("counts matched, changed, overridden and tied occurrences", () => {
    const existing = rule("0190a000-0000-7000-8000-0000000000r1", { conditions: { ...any, weekdays: [3] }, effects: [{ type: "location", targetRef: null, value: LOC_B }] });
    const candidate = rule("0190a000-0000-7000-8000-0000000000r2", { conditions: { ...any, startTimeFrom: "18:00" } });
    const occ = (id: string, startLocal: string, overrides: Partial<rules.FieldValues> = {}) => ({ id, startUtc: new Date(`${startLocal}Z`), startLocal, overrides });
    const p = rules.previewRules({
      defaults: { ...defaults, location: null },
      occurrences: [
        occ("a", "2027-06-01T19:00:00"), // Tuesday evening: changes
        occ("b", "2027-06-02T19:00:00"), // Wednesday evening: ties with the Wednesday rule, which wins (older)
        occ("c", "2027-06-03T19:00:00", { location: LOC_B }), // overridden
        occ("d", "2027-06-03T10:00:00"), // morning: no match
      ],
      before: [existing],
      after: [existing, candidate],
      ruleId: candidate.id,
    });
    expect(p.counts).toEqual({ matched: 3, changed: 1, overridden: 1, conflicts: 1 });
    expect(p.changes).toEqual([{ occurrenceId: "a", startUtc: expect.any(Date), fields: [{ field: "location", from: { value: null, source: "default", ruleId: null }, to: { value: LOC_A, source: "rule", ruleId: candidate.id } }] }]);
    expect(p.conflicts).toEqual([{ occurrenceId: "b", startUtc: expect.any(Date), field: "location", ruleIds: [existing.id, candidate.id] }]);
  });
});
