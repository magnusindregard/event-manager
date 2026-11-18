import { TZDate } from "@date-fns/tz";
import type { TFunction } from "i18next";

// The recurrence editor's model of an RRULE. Common patterns get a form; anything else
// (BYSETPOS, BYMONTHDAY lists…) is edited as raw RRULE text. The server validates and
// expands the rule, so this file never needs to compute dates itself.

export const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export type Freq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

export interface RuleForm {
  mode: "simple" | "custom";
  freq: Freq;
  interval: number;
  byday: Weekday[];
  end: "never" | "until" | "count";
  /** YYYY-MM-DD, last day included. */
  untilDate: string;
  count: number;
  /** Raw RRULE body for custom mode. */
  custom: string;
}

/** Local wall time "YYYY-MM-DDTHH:mm(:ss)" → parts. */
export const splitLocal = (local: string) => ({ date: local.slice(0, 10), time: local.slice(11, 16) });

export function parseRule(rrule: string): RuleForm {
  const parts = Object.fromEntries(rrule.replace(/^RRULE:/i, "").split(";").filter(Boolean).map((p) => p.split("=") as [string, string]));
  const base: RuleForm = { mode: "simple", freq: "WEEKLY", interval: 1, byday: [], end: "never", untilDate: "", count: 10, custom: rrule };
  const known = new Set(["FREQ", "INTERVAL", "BYDAY", "UNTIL", "COUNT"]);
  const freq = parts.FREQ as Freq | undefined;
  const byday = (parts.BYDAY ?? "").split(",").filter(Boolean);
  const simple =
    freq !== undefined && ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq) &&
    Object.keys(parts).every((k) => known.has(k)) &&
    byday.every((d) => (WEEKDAYS as readonly string[]).includes(d)) &&
    (byday.length === 0 || freq === "WEEKLY");
  if (!simple) return { ...base, mode: "custom" };
  const until = parts.UNTIL;
  return {
    ...base,
    freq,
    interval: Number(parts.INTERVAL ?? 1),
    byday: byday as Weekday[],
    end: until ? "until" : parts.COUNT ? "count" : "never",
    untilDate: until ? `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}` : "",
    count: parts.COUNT ? Number(parts.COUNT) : 10,
  };
}

/**
 * How many slots of a series come before `at`, kept or removed (exdates): what a COUNT rule has
 * used up by then. Matches the server's split, which counts the rule's slots before the split.
 */
export function slotsBefore(
  series: { id: string; exdates: readonly string[] },
  occurrences: readonly { seriesId?: string | null; recurrenceIdLocal: string | null }[],
  at: string,
): number {
  const ids = new Set(series.exdates.filter((x) => x < at));
  for (const o of occurrences) if (o.seriesId === series.id && o.recurrenceIdLocal && o.recurrenceIdLocal < at) ids.add(o.recurrenceIdLocal);
  return ids.size;
}

/** "This and following": the series' rule as the new series starts it, with what is left of a COUNT. */
export function followingRule(rrule: string, used: number): RuleForm {
  const f = parseRule(rrule);
  return f.mode === "simple" && f.end === "count" ? { ...f, count: Math.max(1, f.count - used) } : f;
}

/**
 * The rule to send with a split: none when the editor left it as it was, so the server keeps the
 * end condition (UNTIL, or the remaining COUNT) itself; otherwise the rule as edited.
 */
export function splitRrule(edited: RuleForm, initial: RuleForm): string | undefined {
  const rrule = buildRule(edited);
  return rrule === buildRule(initial) ? undefined : rrule;
}

export function buildRule(f: RuleForm): string {
  if (f.mode === "custom") return f.custom.trim().replace(/^RRULE:/i, "");
  const parts = [`FREQ=${f.freq}`];
  if (f.interval > 1) parts.push(`INTERVAL=${f.interval}`);
  if (f.freq === "WEEKLY" && f.byday.length) parts.push(`BYDAY=${WEEKDAYS.filter((d) => f.byday.includes(d)).join(",")}`);
  if (f.end === "until" && f.untilDate) parts.push(`UNTIL=${f.untilDate.replaceAll("-", "")}T235959`);
  if (f.end === "count") parts.push(`COUNT=${Math.max(1, f.count)}`);
  return parts.join(";");
}

/** Weekday of a YYYY-MM-DD date, as an RRULE code. */
export function weekdayOf(date: string): Weekday {
  const d = new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  return WEEKDAYS[(d + 6) % 7]!;
}

/** Short weekday names in the UI language, Monday first. */
export function weekdayNames(language: string): Record<Weekday, string> {
  const fmt = new Intl.DateTimeFormat(language, { weekday: "short", timeZone: "UTC" });
  // 1 January 2024 was a Monday.
  return Object.fromEntries(WEEKDAYS.map((w, i) => [w, fmt.format(new Date(Date.UTC(2024, 0, 1 + i)))])) as Record<Weekday, string>;
}

/** A UTC instant as wall time in a timezone, "YYYY-MM-DDTHH:mm:ss". */
export function toLocal(iso: string, timezone: string): string {
  const d = new TZDate(iso, timezone);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

type TFn = TFunction;

/** "Every week on Mon, Wed, Fri at 14:00, 24 times". */
export function describeRule(rrule: string, dtstartLocal: string, t: TFn, language: string): string {
  const f = parseRule(rrule);
  const { time } = splitLocal(dtstartLocal);
  if (f.mode === "custom") return t("series.summary.custom", { rule: rrule, time });
  const names = weekdayNames(language);
  const every = t(`series.summary.every.${f.freq}`, { count: f.interval });
  const days = f.byday.length ? ` ${t("series.summary.on", { days: f.byday.map((d) => names[d]).join(", ") })}` : "";
  const end =
    f.end === "count" ? t("series.summary.times", { count: f.count })
    : f.end === "until" ? t("series.summary.until", { date: new Intl.DateTimeFormat(language, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${f.untilDate}T12:00:00Z`)) })
    : t("series.summary.forever");
  return `${every}${days} ${t("series.summary.at", { time })}, ${end}`;
}
