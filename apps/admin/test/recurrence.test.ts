import { describe, expect, it } from "vitest";
import { buildRule, followingRule, slotsBefore, splitRrule } from "../src/lib/recurrence.js";

// A daily series of ten from 4 January 2027, split at its fourth occurrence (7 January).
const series = { id: "s1", rrule: "FREQ=DAILY;COUNT=10", exdates: [] as string[] };
const occurrences = Array.from({ length: 10 }, (_, i) => ({ seriesId: "s1", recurrenceIdLocal: `2027-01-${String(4 + i).padStart(2, "0")}T10:00:00` }));
const at = "2027-01-07T10:00:00";

describe("this and following", () => {
  it("starts the new series with the remaining count", () => {
    const used = slotsBefore(series, occurrences, at);
    expect(used).toBe(3);
    expect(buildRule(followingRule(series.rrule, used))).toBe("FREQ=DAILY;COUNT=7");
  });

  it("leaves the rule out when only the time changes, so the server keeps 3 + 7 = 10", () => {
    const initial = followingRule(series.rrule, slotsBefore(series, occurrences, at));
    expect(splitRrule({ ...initial }, initial)).toBeUndefined();
  });

  it("sends an end condition the editor changed on purpose", () => {
    const initial = followingRule(series.rrule, 3);
    expect(splitRrule({ ...initial, count: 4 }, initial)).toBe("FREQ=DAILY;COUNT=4");
    expect(splitRrule({ ...initial, end: "never" }, initial)).toBe("FREQ=DAILY");
  });

  it("counts removed slots, other series and detached slots like the server", () => {
    const withGaps = { ...series, exdates: ["2027-01-05T10:00:00"] };
    const kept = occurrences.filter((o) => o.recurrenceIdLocal !== "2027-01-05T10:00:00");
    const others = [...kept, { seriesId: "s2", recurrenceIdLocal: "2027-01-04T10:00:00" }, { seriesId: null, recurrenceIdLocal: null }];
    expect(slotsBefore(withGaps, others, at)).toBe(3);
  });

  it("keeps rules without COUNT as they are", () => {
    expect(buildRule(followingRule("FREQ=WEEKLY;BYDAY=MO;UNTIL=20270601T235959", 3))).toBe("FREQ=WEEKLY;BYDAY=MO;UNTIL=20270601T235959");
    expect(buildRule(followingRule("FREQ=DAILY", 3))).toBe("FREQ=DAILY");
  });
});
