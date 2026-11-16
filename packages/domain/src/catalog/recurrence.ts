import { tzOffset } from "@date-fns/tz";
import type { LocalDateTime } from "@event-manager/db";
import * as rruleModule from "rrule";
import { invalid } from "./shared.js";

// rrule ships CommonJS for Node and ESM for bundlers; take the exports from either.
const { Frequency, RRule } = ((rruleModule as unknown as { default?: typeof rruleModule }).default ?? rruleModule) as typeof rruleModule;
type RRule = rruleModule.RRule;

// Recurrence in floating local wall time (docs/implementation-plan.md, "Recurrence").
//
// A rule is expanded with rrule.js on "floating" dates: Date objects whose UTC fields hold
// the local wall time. Each slot is then converted to a real instant in the series'
// timezone, so a 14:00 tour stays at 14:00 across DST changes.

export interface SeriesDef {
  /** RRULE body without DTSTART; UNTIL is local wall time. */
  rrule: string;
  dtstartLocal: LocalDateTime;
  durationMin: number;
  timezone: string;
  exdates: readonly LocalDateTime[];
}

export interface Slot {
  /** The slot's local start, as iCalendar RECURRENCE-ID. Key for matching occurrences. */
  recurrenceIdLocal: LocalDateTime;
  startUtc: Date;
  endUtc: Date;
}

/** Most occurrences one series may materialize in its window. */
export const MAX_SLOTS = 10_000;

const LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

/** "2027-01-04T14:00" or "...:00" → canonical "2027-01-04T14:00:00". */
export function normalizeLocal(field: string, s: string): LocalDateTime {
  if (!LOCAL_RE.test(s) || Number.isNaN(Date.parse(`${s}Z`))) throw invalid(field, "Use local date and time, YYYY-MM-DDTHH:mm");
  return s.length === 16 ? `${s}:00` : s;
}

const floating = (local: LocalDateTime) => new Date(`${local}Z`);
const toLocal = (d: Date): LocalDateTime => d.toISOString().slice(0, 19);

/**
 * The instant of a local wall time in a timezone. In the spring-forward gap the time
 * moves forward by the gap (02:30 → 03:30); in the autumn overlap the earlier instant wins.
 */
export function localToUtc(local: LocalDateTime, timeZone: string): Date {
  const wall = floating(local).getTime();
  const before = tzOffset(timeZone, new Date(wall - 12 * 3_600_000));
  const after = tzOffset(timeZone, new Date(wall + 12 * 3_600_000));
  const valid = [...new Set([before, after])]
    .map((offset) => wall - offset * 60_000)
    .filter((t) => tzOffset(timeZone, new Date(t)) * 60_000 === wall - t);
  return new Date(valid.length ? Math.min(...valid) : wall - before * 60_000);
}

export function utcToLocal(instant: Date, timeZone: string): LocalDateTime {
  return toLocal(new Date(instant.getTime() + tzOffset(timeZone, instant) * 60_000));
}

const ALLOWED_FREQ = new Set([Frequency.YEARLY, Frequency.MONTHLY, Frequency.WEEKLY, Frequency.DAILY]);

/**
 * Validates an RRULE body and returns it in canonical form (UNTIL as local wall time,
 * no DTSTART). Sub-daily frequencies are not allowed; use BYHOUR for several a day.
 */
export function normalizeRrule(text: string): string {
  const body = text.trim().replace(/^RRULE:/i, "");
  if (/DTSTART|TZID/i.test(body)) throw invalid("rrule", "Give the start as dtstartLocal, not in the rule");
  let options;
  try {
    options = RRule.parseString(body);
  } catch {
    throw invalid("rrule", "Not a valid RFC 5545 recurrence rule");
  }
  if (options.freq === undefined || !ALLOWED_FREQ.has(options.freq)) throw invalid("rrule", "Repeat daily, weekly, monthly or yearly");
  if (options.until && options.count) throw invalid("rrule", "Use either UNTIL or COUNT, not both");
  if (options.count !== undefined && options.count !== null && (options.count < 1 || options.count > MAX_SLOTS)) {
    throw invalid("rrule", `COUNT must be between 1 and ${MAX_SLOTS}`);
  }
  if (options.interval !== undefined && (options.interval < 1 || options.interval > 1000)) throw invalid("rrule", "INTERVAL must be between 1 and 1000");
  return RRule.optionsToString(options).replace(/^RRULE:/, "").replace(/(UNTIL=\d{8}T\d{6})Z/, "$1");
}

function rule(def: Pick<SeriesDef, "rrule" | "dtstartLocal">): RRule {
  return new RRule({ ...RRule.parseString(def.rrule), dtstart: floating(def.dtstartLocal) });
}

export function slotAt(def: Pick<SeriesDef, "durationMin" | "timezone">, recurrenceIdLocal: LocalDateTime): Slot {
  const startUtc = localToUtc(recurrenceIdLocal, def.timezone);
  return { recurrenceIdLocal, startUtc, endUtc: new Date(startUtc.getTime() + def.durationMin * 60_000) };
}

export interface Expansion {
  slots: Slot[];
  /** No slots of the rule fall after the window: the series is fully generated. */
  complete: boolean;
}

/**
 * Slots of a series that start in [fromUtc, untilUtc], EXDATEs removed. Expansion starts
 * at dtstart (COUNT counts from there), so fromUtc only filters.
 */
export function expand(def: SeriesDef, window: { fromUtc?: Date; untilUtc: Date }): Expansion {
  const r = rule(def);
  // Slots are compared in local time with a day of margin, then filtered by instant.
  const limit = new Date(floating(utcToLocal(window.untilUtc, def.timezone)).getTime() + 86_400_000);
  const ex = new Set(def.exdates);
  const slots: Slot[] = [];
  let beyond = false;
  r.all((d) => {
    if (d > limit) {
      beyond = true;
      return false;
    }
    const local = toLocal(d);
    if (ex.has(local)) return true;
    const slot = slotAt(def, local);
    if (slot.startUtc > window.untilUtc) {
      beyond = true;
      return true;
    }
    if (!window.fromUtc || slot.startUtc >= window.fromUtc) slots.push(slot);
    return slots.length <= MAX_SLOTS;
  });
  if (slots.length > MAX_SLOTS) {
    throw invalid("rrule", `The series would have more than ${MAX_SLOTS} occurrences in the planning horizon`);
  }
  return { slots, complete: !beyond };
}

/** True when the local time is a slot of the rule (EXDATEs count as not belonging). */
export function isSlot(def: SeriesDef, recurrenceIdLocal: LocalDateTime): boolean {
  if (def.exdates.includes(recurrenceIdLocal)) return false;
  const d = floating(recurrenceIdLocal);
  return rule(def).between(d, d, true).length > 0;
}

/**
 * EXDATEs follow a rule change the way occurrences do (same local date, same order within
 * the day), so a deleted 14:00 slot stays deleted when the series moves to 15:00.
 * Exclusions whose date no longer occurs are dropped.
 */
export function remapExdates(before: SeriesDef, after: Omit<SeriesDef, "exdates">): LocalDateTime[] {
  const oldRule = rule(before);
  const newRule = rule(after);
  const out = new Set<LocalDateTime>();
  for (const ex of before.exdates) {
    const day = floating(`${localDate(ex)}T00:00:00`);
    const end = new Date(day.getTime() + 86_400_000 - 1000);
    const ordinal = oldRule.between(day, end, true).map(toLocal).indexOf(ex);
    const target = ordinal >= 0 ? newRule.between(day, end, true)[ordinal] : undefined;
    if (target) out.add(toLocal(target));
  }
  return [...out].sort();
}

/** Rule options used when splitting a series. */
function ruleOptions(rrule: string) {
  return RRule.parseString(rrule);
}

/**
 * "This and following": the rules of the two series when a series is split at a slot.
 * The old series ends just before the slot; the new one starts at it and keeps the end
 * (UNTIL, or the remaining COUNT).
 */
export function splitRules(def: SeriesDef, atLocal: LocalDateTime): { before: string; after: string } {
  const opts = ruleOptions(def.rrule);
  const at = floating(atLocal);
  const untilBefore = toLocal(new Date(at.getTime() - 1000));
  const before = normalizeRrule(RRule.optionsToString({ ...opts, count: null, until: floating(untilBefore) }));
  let after = def.rrule;
  if (opts.count) {
    const used = rule(def).between(floating(def.dtstartLocal), at, true).filter((d) => d < at).length;
    after = normalizeRrule(RRule.optionsToString({ ...opts, count: Math.max(1, opts.count - used) }));
  }
  return { before, after };
}

export const localDate = (local: LocalDateTime) => local.slice(0, 10);
export { toLocal as floatingToLocal };
