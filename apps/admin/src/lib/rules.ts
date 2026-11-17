import type { TFunction } from "i18next";
import type { Rule, RuleCreate } from "../api.js";

// Occurrence rules in the admin. The server resolves and previews rules; this file only
// matches conditions for the occurrence filter (so "save as rule" selects exactly what the
// filter shows) and describes rules in words. matches() mirrors the domain's rules engine.

export type Conditions = Rule["conditions"];
/** An effect as sent to the API. */
export type Effect = RuleCreate["effects"][number];
type StoredEffect = Rule["effects"][number];

export const NO_CONDITIONS: Conditions = { dateFrom: null, dateTo: null, weekdays: null, startTimeFrom: null, startTimeTo: null };

/** ISO weekdays, 1 = Monday. */
export const ISO_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

export function isoWeekdayNames(language: string, style: "short" | "long" = "short"): Record<number, string> {
  const fmt = new Intl.DateTimeFormat(language, { weekday: style, timeZone: "UTC" });
  // 1 January 2024 was a Monday.
  return Object.fromEntries(ISO_WEEKDAYS.map((d) => [d, fmt.format(new Date(Date.UTC(2024, 0, d)))]));
}

const isoWeekday = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
};

/** Whether an occurrence starting at this local time ("YYYY-MM-DDTHH:mm:ss") meets the conditions. */
export function matches(c: Conditions, startLocal: string): boolean {
  const date = startLocal.slice(0, 10);
  if (c.dateFrom && date < c.dateFrom) return false;
  if (c.dateTo && date > c.dateTo) return false;
  if (c.weekdays && !c.weekdays.includes(isoWeekday(date))) return false;
  const time = startLocal.slice(11, 16);
  const from = c.startTimeFrom;
  const to = c.startTimeTo;
  if (from && to) return from < to ? time >= from && time < to : time >= from || time < to;
  if (from && time < from) return false;
  if (to && time >= to) return false;
  return true;
}

export const hasConditions = (c: Conditions) => Object.values(c).some((v) => v !== null);

const dateFmt = (language: string) => new Intl.DateTimeFormat(language, { dateStyle: "medium", timeZone: "UTC" });
const formatDate = (d: string, language: string) => dateFmt(language).format(new Date(`${d}T12:00:00Z`));

/** "1 Jun 2027 – 31 Aug 2027 · Wed · from 18:00", or "All occurrences". */
export function describeConditions(c: Conditions, t: TFunction, language: string): string {
  const parts: string[] = [];
  if (c.dateFrom && c.dateTo) parts.push(`${formatDate(c.dateFrom, language)} – ${formatDate(c.dateTo, language)}`);
  else if (c.dateFrom) parts.push(t("rules.summary.fromDate", { date: formatDate(c.dateFrom, language) }));
  else if (c.dateTo) parts.push(t("rules.summary.toDate", { date: formatDate(c.dateTo, language) }));
  if (c.weekdays) {
    const names = isoWeekdayNames(language);
    parts.push(c.weekdays.map((d) => names[d]).join(", "));
  }
  if (c.startTimeFrom && c.startTimeTo) parts.push(t("rules.summary.between", { from: c.startTimeFrom, to: c.startTimeTo }));
  else if (c.startTimeFrom) parts.push(t("rules.summary.fromTime", { time: c.startTimeFrom }));
  else if (c.startTimeTo) parts.push(t("rules.summary.beforeTime", { time: c.startTimeTo }));
  return parts.length ? parts.join(" · ") : t("rules.summary.all");
}

/** "Location: Rooftop · Tags: + Late opening · Ticket link". */
export function describeEffects(effects: StoredEffect[], t: TFunction, names: { location(id: string): string; tag(id: string): string }): string {
  return effects
    .map((e) => {
      if (e.type === "location") return `${t("rules.effect.location")}: ${names.location(e.value)}`;
      if (e.type === "externalUrl") return `${t("rules.effect.externalUrl")}: ${e.value.replace(/^https?:\/\//, "")}`;
      if (e.type === "capacity") return `${t("rules.effect.capacity")}: ${e.value}`;
      if (e.type === "overbooking") return `${t("rules.effect.overbooking")}: ${e.value} %`;
      const add = (e.value.add ?? []).map((x) => `+ ${names.tag(x)}`);
      const remove = (e.value.remove ?? []).map((x) => `− ${names.tag(x)}`);
      return `${t("rules.effect.tags")}: ${[...add, ...remove].join(", ")}`;
    })
    .join(" · ");
}
