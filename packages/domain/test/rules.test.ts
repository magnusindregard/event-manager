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
const OFFER_A = "0190a000-0000-7000-8000-0000000000fa";
const OFFER_B = "0190a000-0000-7000-8000-0000000000fb";

const rule = (id: string, over: Partial<rules.RuleDef> = {}): rules.RuleDef => ({
  id, name: id, priority: 0, active: true, conditions: any, effects: [{ type: "location", targetRef: null, value: LOC_A }], ...over,
});
const defaults: rules.FieldValues = { location: LOC_B, tags: [TAG_1], externalUrl: "https://tickets.test/default", capacity: null, overbooking: 0 };

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
    expect(() => rules.normalizeEffects([{ type: "discount", value: 100 }])).toThrow(/Unknown effect type/);
    expect(() => rules.normalizeEffects([{ type: "location", value: "rooftop" }])).toThrow(/location id/);
    expect(() => rules.normalizeEffects([{ type: "externalUrl", value: "ftp://x" }])).toThrow(/http/);
    expect(() => rules.normalizeEffects([{ type: "location", targetRef: "offer-1", value: LOC_A }])).toThrow(/no targetRef/);
    expect(() => rules.normalizeEffects([{ type: "location", value: LOC_A }, { type: "location", value: LOC_B }])).toThrow(/already has/);
    expect(() => rules.normalizeEffects([{ type: "tags", value: { add: [TAG_1], remove: [TAG_1] } }])).toThrow(/both/);
  });

  it("validates targeted effects: an offer id and a value per type (docs/ticketing.md)", () => {
    expect(rules.normalizeEffects([{ type: "price", targetRef: OFFER_A.toUpperCase(), value: { amount: 45000 } }]))
      .toEqual([{ type: "price", targetRef: OFFER_A, value: { amount: 45000 } }]);
    expect(() => rules.normalizeEffects([{ type: "price", value: { amount: 1 } }])).toThrow(/needs a targetRef/);
    expect(() => rules.normalizeEffects([{ type: "price", targetRef: "adult", value: { amount: 1 } }])).toThrow(/offer id/);
    expect(() => rules.normalizeEffects([{ type: "price", targetRef: OFFER_A, value: 100 }])).toThrow(/amount/);
    expect(() => rules.normalizeEffects([{ type: "price", targetRef: OFFER_A, value: { amount: 1.5 } }])).toThrow(/whole amount/);
    expect(() => rules.normalizeEffects([{ type: "offerAvailable", targetRef: OFFER_A, value: "no" }])).toThrow(/true or false/);
    // One effect per (type, target); several targets in one rule are fine.
    expect(() => rules.normalizeEffects([
      { type: "price", targetRef: OFFER_A, value: { amount: 1 } }, { type: "price", targetRef: OFFER_A, value: { amount: 2 } },
    ])).toThrow(/for this target/);
    expect(rules.normalizeEffects([
      { type: "price", targetRef: OFFER_A, value: { amount: 1 } }, { type: "price", targetRef: OFFER_B, value: { amount: 2 } },
    ])).toHaveLength(2);
  });

  it("treats tag ids case-insensitively (#43)", () => {
    const upper = TAG_2.toUpperCase();
    expect(rules.normalizeEffects([{ type: "tags", value: { add: [upper, TAG_2] } }])).toEqual([{ type: "tags", targetRef: null, value: { add: [TAG_2], remove: [] } }]);
    expect(() => rules.normalizeEffects([{ type: "tags", value: { add: [TAG_1], remove: [TAG_1.toUpperCase()] } }])).toThrow(/both/);
    // A rule stored before ids were normalized still removes the lowercase default.
    expect(rules.effectType("tags").apply({ add: [], remove: [TAG_1.toUpperCase()] }, [TAG_1, TAG_2])).toEqual([TAG_2]);
  });

  it("lists referenced locations and tags", () => {
    const effects = rules.normalizeEffects([{ type: "location", value: LOC_A }, { type: "tags", value: { add: [TAG_2], remove: [TAG_1] } }]);
    expect(rules.effectRefs(effects)).toEqual({ locations: [LOC_A], tags: [TAG_2, TAG_1], offers: [], groups: [] });
    expect(rules.effectRefs(rules.normalizeEffects([{ type: "offerAvailable", targetRef: OFFER_A, value: false }])).offers).toEqual([OFFER_A]);
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
    expect(r.ties).toEqual([{ field: "location", targetRef: null, ruleIds: [older.id, newer.id] }]);
  });

  it("resolves targeted fields per offer: override → rule for that offer → the offer's default", () => {
    const targets = (overrides: Record<string, Partial<rules.TargetValues>> = {}) => [
      { ref: OFFER_A, defaults: { price: 45000, offerAvailable: true }, overrides: overrides[OFFER_A] ?? {} },
      { ref: OFFER_B, defaults: { price: 25000, offerAvailable: true }, overrides: overrides[OFFER_B] ?? {} },
    ];
    const weekend = rule("0190a000-0000-7000-8000-0000000000r1", {
      conditions: { ...any, weekdays: [6, 7] },
      effects: [{ type: "price", targetRef: OFFER_A, value: { amount: 50000 } }, { type: "offerAvailable", targetRef: OFFER_B, value: false }],
    });
    const tie = rule("0190a000-0000-7000-8000-0000000000r2", { effects: [{ type: "price", targetRef: OFFER_A, value: { amount: 1 } }] });
    const sat = rules.resolveTargets(targets(), "2027-02-13T19:30:00", rules.ordered([weekend, tie]));
    expect(sat.values.get(OFFER_A)).toEqual({
      price: { value: 50000, source: "rule", ruleId: weekend.id }, offerAvailable: { value: true, source: "default", ruleId: null },
    });
    expect(sat.values.get(OFFER_B)!.offerAvailable).toEqual({ value: false, source: "rule", ruleId: weekend.id });
    expect(sat.ties).toEqual([{ field: "price", targetRef: OFFER_A, ruleIds: [weekend.id, tie.id] }]);

    const fri = rules.resolveTargets(targets(), "2027-02-12T19:30:00", rules.ordered([weekend]));
    expect(fri.values.get(OFFER_A)!.price).toEqual({ value: 45000, source: "default", ruleId: null });

    const overridden = rules.resolveTargets(targets({ [OFFER_A]: { price: 40000 } }), "2027-02-13T19:30:00", rules.ordered([weekend]));
    expect(overridden.values.get(OFFER_A)!.price).toEqual({ value: 40000, source: "override", ruleId: null });
    // Untargeted resolution ignores targeted effects.
    expect(rules.resolve(at("2027-02-13T19:30:00"), rules.ordered([weekend])).values.location.source).toBe("default");
  });

  it("resolves group prices: group override → rule for that group → the offer's group price → none (the general price)", () => {
    const MEMBER = "0190a000-0000-7000-8000-0000000000c1";
    const SPONSOR = "0190a000-0000-7000-8000-0000000000c2";
    const weekend = rule("0190a000-0000-7000-8000-0000000000r1", {
      conditions: { ...any, weekdays: [6, 7] },
      effects: [
        { type: "price", targetRef: OFFER_A, value: { amount: 50000 } },
        { type: "price", targetRef: OFFER_A, targetGroup: MEMBER, value: { amount: 40000 } },
      ],
    });
    const inputs = (override?: number) => [
      { ref: OFFER_A, group: MEMBER, groupDefault: 35000, override },
      { ref: OFFER_A, group: SPONSOR, groupDefault: null },
    ];
    const ordered = rules.ordered([weekend]);
    // Weekdays: the member's own price; sponsors have none, so they are left out.
    const fri = rules.resolveGroupPrices(inputs(), "2027-02-12T19:30:00", ordered);
    expect([...fri.values]).toEqual([[`${OFFER_A}|${MEMBER}`, { value: 35000, source: "default", ruleId: null }]]);
    // Weekends: the rule's member effect wins over the member's own price.
    const sat = rules.resolveGroupPrices(inputs(), "2027-02-13T19:30:00", ordered);
    expect(sat.values.get(`${OFFER_A}|${MEMBER}`)).toEqual({ value: 40000, source: "rule", ruleId: weekend.id });
    expect(sat.values.has(`${OFFER_A}|${SPONSOR}`)).toBe(false);
    // A group override wins over everything.
    expect(rules.resolveGroupPrices(inputs(30000), "2027-02-13T19:30:00", ordered).values.get(`${OFFER_A}|${MEMBER}`)).toEqual({ value: 30000, source: "override", ruleId: null });
    // The general price ignores group effects.
    const general = rules.resolveTargets([{ ref: OFFER_A, defaults: { price: 45000, offerAvailable: true }, overrides: {} }], "2027-02-13T19:30:00", ordered);
    expect(general.values.get(OFFER_A)!.price).toEqual({ value: 50000, source: "rule", ruleId: weekend.id });
    // Ties are reported per (offer, group).
    const tie = rule("0190a000-0000-7000-8000-0000000000r2", { effects: [{ type: "price", targetRef: OFFER_A, targetGroup: MEMBER, value: { amount: 1 } }] });
    expect(rules.resolveGroupPrices(inputs(), "2027-02-13T19:30:00", rules.ordered([weekend, tie])).ties)
      .toEqual([{ field: "price", targetRef: OFFER_A, group: MEMBER, ruleIds: [weekend.id, tie.id] }]);
    expect(rules.groupRuleTargets([weekend, tie])).toEqual([{ ref: OFFER_A, group: MEMBER }]);
  });

  it("takes a group only on price effects, and one effect per (offer, group)", () => {
    const MEMBER = "0190a000-0000-7000-8000-0000000000c1";
    const both = rules.normalizeEffects([
      { type: "price", targetRef: OFFER_A, value: { amount: 1 } },
      { type: "price", targetRef: OFFER_A, targetGroup: MEMBER.toUpperCase(), value: { amount: 2 } },
    ]);
    expect(both.map((e) => e.targetGroup ?? null)).toEqual([null, MEMBER]);
    expect(() => rules.normalizeEffects([{ type: "offerAvailable", targetRef: OFFER_A, targetGroup: MEMBER, value: false }])).toThrow(DomainError);
    expect(() => rules.normalizeEffects([
      { type: "price", targetRef: OFFER_A, targetGroup: MEMBER, value: { amount: 1 } },
      { type: "price", targetRef: OFFER_A, targetGroup: MEMBER, value: { amount: 2 } },
    ])).toThrow(DomainError);
    expect(() => rules.normalizeEffects([{ type: "price", targetRef: OFFER_A, targetGroup: "member", value: { amount: 1 } }])).toThrow(DomainError);
    expect(rules.effectRefs(both).groups).toEqual([MEMBER]);
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
    expect(p.changes).toEqual([{ occurrenceId: "a", startUtc: expect.any(Date), fields: [{ field: "location", targetRef: null, group: null, from: { value: null, source: "default", ruleId: null }, to: { value: LOC_A, source: "rule", ruleId: candidate.id } }] }]);
    expect(p.conflicts).toEqual([{ occurrenceId: "b", startUtc: expect.any(Date), field: "location", targetRef: null, group: null, ruleIds: [existing.id, candidate.id] }]);
  });
});
