import { describe, expect, it } from "vitest";
import { localToUtc, normalizeLocal, normalizeRrule, remapExdates, utcToLocal, expand, splitRules } from "../src/catalog/recurrence.js";
import { planRegeneration } from "../src/catalog/regenerate.js";

const OSLO = "Europe/Oslo";
const iso = (d: Date) => d.toISOString();

describe("local time in a timezone", () => {
  it("converts both ways in winter and summer", () => {
    expect(iso(localToUtc("2027-01-04T14:00:00", OSLO))).toBe("2027-01-04T13:00:00.000Z");
    expect(iso(localToUtc("2027-07-05T14:00:00", OSLO))).toBe("2027-07-05T12:00:00.000Z");
    expect(utcToLocal(new Date("2027-07-05T12:00:00Z"), OSLO)).toBe("2027-07-05T14:00:00");
  });

  it("moves a time in the spring-forward gap forward, and picks the earlier instant in the autumn overlap", () => {
    // 28 March 2027: 02:00 → 03:00 in Oslo.
    expect(iso(localToUtc("2027-03-28T02:30:00", OSLO))).toBe("2027-03-28T01:30:00.000Z"); // = 03:30 CEST
    // 31 October 2027: 03:00 → 02:00; 02:30 happens twice.
    expect(iso(localToUtc("2027-10-31T02:30:00", OSLO))).toBe("2027-10-31T00:30:00.000Z"); // 02:30 CEST
  });

  it("validates local times", () => {
    expect(normalizeLocal("x", "2027-01-04T14:00")).toBe("2027-01-04T14:00:00");
    expect(() => normalizeLocal("x", "2027-01-04T14:00Z")).toThrow();
  });
});

describe("rules", () => {
  it("normalizes and keeps UNTIL in local time", () => {
    expect(normalizeRrule("RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20270228T235959Z")).toBe("FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20270228T235959");
    expect(() => normalizeRrule("FREQ=HOURLY")).toThrow();
    expect(() => normalizeRrule("FREQ=DAILY;COUNT=2;UNTIL=20270101T000000")).toThrow();
    expect(() => normalizeRrule("nonsense")).toThrow();
  });

  it("splits COUNT and UNTIL rules at a slot", () => {
    const def = { rrule: "FREQ=DAILY;COUNT=10", dtstartLocal: "2027-01-01T10:00:00", durationMin: 60, timezone: OSLO, exdates: [] };
    expect(splitRules(def, "2027-01-04T10:00:00")).toEqual({ before: "FREQ=DAILY;UNTIL=20270104T095959", after: "FREQ=DAILY;COUNT=7" });
  });
});

describe("acceptance: a series crossing the DST change keeps its local start time", () => {
  it("weekly 14:00 tour stays at 14:00 Oslo time on both sides of both changes", () => {
    const def = { rrule: "FREQ=WEEKLY;BYDAY=SU", dtstartLocal: "2027-03-14T14:00:00", durationMin: 90, timezone: OSLO, exdates: [] };
    const { slots } = expand(def, { untilUtc: new Date("2027-11-15T00:00:00Z") });
    for (const s of slots) {
      expect(utcToLocal(s.startUtc, OSLO).slice(11)).toBe("14:00:00");
      expect(s.endUtc.getTime() - s.startUtc.getTime()).toBe(90 * 60_000);
    }
    const byDate = Object.fromEntries(slots.map((s) => [s.recurrenceIdLocal.slice(0, 10), iso(s.startUtc)]));
    expect(byDate["2027-03-21"]).toBe("2027-03-21T13:00:00.000Z"); // CET, UTC+1
    expect(byDate["2027-03-28"]).toBe("2027-03-28T12:00:00.000Z"); // CEST from that morning
    expect(byDate["2027-10-24"]).toBe("2027-10-24T12:00:00.000Z");
    expect(byDate["2027-10-31"]).toBe("2027-10-31T13:00:00.000Z"); // back to CET
  });

  it("an occurrence running through the change has its real length", () => {
    const def = { rrule: "FREQ=DAILY;COUNT=1", dtstartLocal: "2027-03-28T01:00:00", durationMin: 180, timezone: OSLO, exdates: [] };
    const [s] = expand(def, { untilUtc: new Date("2028-01-01T00:00:00Z") }).slots;
    expect(utcToLocal(s!.endUtc, OSLO)).toBe("2027-03-28T05:00:00"); // 3 real hours, 4 on the wall clock
  });
});

describe("remapExdates", () => {
  it("keeps a deleted slot deleted when the series moves to another time, and drops it when its day goes", () => {
    const before = { rrule: "FREQ=WEEKLY;BYDAY=MO,WE", dtstartLocal: "2027-01-04T14:00:00", durationMin: 60, timezone: OSLO, exdates: ["2027-01-06T14:00:00", "2027-01-11T14:00:00"] };
    expect(remapExdates(before, { ...before, dtstartLocal: "2027-01-04T15:00:00" })).toEqual(["2027-01-06T15:00:00", "2027-01-11T15:00:00"]);
    expect(remapExdates(before, { ...before, rrule: "FREQ=WEEKLY;BYDAY=MO" })).toEqual(["2027-01-11T14:00:00"]);
  });
});

describe("expand", () => {
  const def = { rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=24", dtstartLocal: "2027-01-04T14:00:00", durationMin: 60, timezone: OSLO, exdates: ["2027-01-06T14:00:00"] };
  it("drops EXDATEs, keeps COUNT counting them, and reports completeness", () => {
    const all = expand(def, { untilUtc: new Date("2028-01-01T00:00:00Z") });
    expect(all.slots).toHaveLength(23);
    expect(all.complete).toBe(true);
    const part = expand(def, { untilUtc: new Date("2027-01-20T00:00:00Z") });
    expect(part.complete).toBe(false);
    expect(part.slots.at(-1)!.recurrenceIdLocal).toBe("2027-01-18T14:00:00");
  });
});

describe("planRegeneration", () => {
  const before = { rrule: "FREQ=DAILY;COUNT=3", dtstartLocal: "2027-01-04T14:00:00", durationMin: 60, timezone: OSLO, exdates: [] };
  const after = { ...before, dtstartLocal: "2027-01-04T15:00:00" };
  const slotsBefore = expand(before, { untilUtc: new Date("2028-01-01Z") }).slots;
  const slotsAfter = expand(after, { untilUtc: new Date("2028-01-01Z") }).slots;
  const existing = slotsBefore.map((s, i) => ({ id: `o${i}`, recurrenceIdLocal: s.recurrenceIdLocal, startUtc: s.startUtc, endUtc: s.endUtc, detached: i === 1, conflict: false }));

  it("moves occurrences to the new time, keeps their IDs, and flags the detached one", () => {
    const plan = planRegeneration({ before, after, existing, slots: slotsAfter, cutoff: new Date("2026-01-01Z") });
    expect(plan.create).toEqual([]);
    expect(plan.delete).toEqual([]);
    expect(plan.move.map((m) => [m.id, m.to.recurrenceIdLocal])).toEqual([["o0", "2027-01-04T15:00:00"], ["o2", "2027-01-06T15:00:00"]]);
    expect(plan.rekey).toEqual([{ id: "o1", recurrenceIdLocal: "2027-01-05T15:00:00" }]);
    expect(plan.conflicts).toMatchObject([{ id: "o1", reason: "moved" }]);
  });

  it("leaves history alone", () => {
    const plan = planRegeneration({ before, after, existing, slots: slotsAfter, cutoff: new Date("2027-01-05T00:00:00Z") });
    expect(plan.move.map((m) => m.id)).toEqual(["o2"]);
  });

  it("deletes slots that disappear, unless detached", () => {
    const shorter = { ...before, rrule: "FREQ=DAILY;COUNT=1" };
    const plan = planRegeneration({ before, after: shorter, existing, slots: expand(shorter, { untilUtc: new Date("2028-01-01Z") }).slots, cutoff: new Date("2026-01-01Z") });
    expect(plan.delete.map((d) => d.id)).toEqual(["o2"]);
    expect(plan.conflicts).toMatchObject([{ id: "o1", reason: "removed" }]);
    expect(plan.unchanged).toBe(1);
  });
});
