import type { EffectiveField, LocalDateTime, ValueSource } from "@event-manager/db";
import { DomainError } from "../shared/index.js";
import { type EffectRefs, effectType } from "./effects.js";

// The rule engine, pure (docs/implementation-plan.md, "Rules"). Matching happens on an
// occurrence's local start in the event's timezone. Resolution per occurrence and field:
// override → highest-priority active matching rule with an effect on the field (equal
// priority: the older rule wins and the tie is reported) → event default.

/** Conditions on an occurrence's local start; null means "any". */
export interface Conditions {
  /** Inclusive local dates, "YYYY-MM-DD". */
  dateFrom: string | null;
  dateTo: string | null;
  /** ISO weekdays, 1 = Monday. */
  weekdays: number[] | null;
  /** Start-time window [from, to) as "HH:mm". from > to wraps midnight. */
  startTimeFrom: string | null;
  startTimeTo: string | null;
}

export interface Effect {
  type: string;
  targetRef: string | null;
  value: unknown;
}

export type EffectInput = Omit<Effect, "targetRef"> & { targetRef?: string | null };

export interface RuleDef {
  id: string;
  name: string;
  priority: number;
  active: boolean;
  conditions: Conditions;
  effects: Effect[];
}

export interface Resolved<T = unknown> {
  value: T;
  source: ValueSource;
  ruleId: string | null;
}

export type FieldValues = Record<EffectiveField, unknown>;
export type ResolvedFields = Record<EffectiveField, Resolved>;
export const FIELDS: readonly EffectiveField[] = ["location", "tags", "externalUrl", "capacity", "overbooking"];

/** Two or more rules of the same priority set the same field on one occurrence. */
export interface Tie {
  field: EffectiveField;
  /** The winner first. */
  ruleIds: string[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:00)?$/;
const invalid = (field: string, message: string) => new DomainError("validation_failed", message, { field });

/** ISO weekday (1 = Monday) of a local date. */
export function isoWeekday(date: string): number {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/** Whether an occurrence starting at this local time meets the conditions. */
export function matches(c: Conditions, startLocal: LocalDateTime): boolean {
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

export function normalizeConditions(input: Partial<Conditions> | undefined): Conditions {
  const c = input ?? {};
  const date = (field: "dateFrom" | "dateTo") => {
    const v = c[field] ?? null;
    if (v !== null && (!DATE_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v)) {
      throw invalid(`conditions.${field}`, "Use a date, YYYY-MM-DD");
    }
    return v;
  };
  const time = (field: "startTimeFrom" | "startTimeTo") => {
    const v = c[field] ?? null;
    if (v !== null && !TIME_RE.test(v)) throw invalid(`conditions.${field}`, "Use a time, HH:mm");
    return v === null ? null : v.slice(0, 5);
  };
  const out: Conditions = {
    dateFrom: date("dateFrom"),
    dateTo: date("dateTo"),
    weekdays: c.weekdays && c.weekdays.length ? [...new Set(c.weekdays)].sort() : null,
    startTimeFrom: time("startTimeFrom"),
    startTimeTo: time("startTimeTo"),
  };
  if (out.weekdays?.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) throw invalid("conditions.weekdays", "Weekdays are 1 (Monday) to 7 (Sunday)");
  if (out.dateFrom && out.dateTo && out.dateFrom > out.dateTo) throw invalid("conditions.dateTo", "The end date is before the start date");
  if (out.startTimeFrom && out.startTimeFrom === out.startTimeTo) throw invalid("conditions.startTimeTo", "The window is empty");
  return out;
}

/** Validates effects with their type handlers and returns them in canonical form. */
export function normalizeEffects(input: readonly EffectInput[]): Effect[] {
  if (input.length === 0) throw invalid("effects", "Add at least one effect");
  const seen = new Set<string>();
  return input.map((e, i) => {
    const t = effectType(e.type);
    const targetRef = e.targetRef ?? null;
    if (t.targeted !== (targetRef !== null)) throw invalid(`effects.${i}.targetRef`, t.targeted ? "This effect needs a targetRef" : "This effect takes no targetRef");
    const key = `${e.type}\u0000${targetRef ?? ""}`;
    if (seen.has(key)) throw invalid(`effects.${i}`, `The rule already has a ${e.type} effect`);
    seen.add(key);
    return { type: e.type, targetRef, value: t.validate(e.value, `effects.${i}.value`) };
  });
}

/** Catalog entities the effects point at, for the caller to check. */
export function effectRefs(effects: readonly Effect[]): Required<EffectRefs> {
  const out = { locations: new Set<string>(), tags: new Set<string>() };
  for (const e of effects) {
    const r = effectType(e.type).refs(e.value);
    r.locations?.forEach((x) => out.locations.add(x));
    r.tags?.forEach((x) => out.tags.add(x));
  }
  return { locations: [...out.locations], tags: [...out.tags] };
}

/** Active rules in resolution order: priority high to low, then oldest (lowest UUIDv7) first. */
export function ordered<R extends RuleDef>(rules: readonly R[]): R[] {
  return rules.filter((r) => r.active).sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export interface ResolveInput {
  defaults: FieldValues;
  /** Fields set on the occurrence itself; absent means inherit. */
  overrides: Partial<FieldValues>;
  startLocal: LocalDateTime;
}

/**
 * Resolves one occurrence. `rules` must already be ordered (see ordered()), so the caller
 * sorts once per event instead of once per occurrence.
 */
export function resolve(input: ResolveInput, rules: readonly RuleDef[]): { values: ResolvedFields; ties: Tie[] } {
  const matching = rules.filter((r) => matches(r.conditions, input.startLocal));
  const values = {} as ResolvedFields;
  const ties: Tie[] = [];
  for (const field of FIELDS) {
    if (field in input.overrides) {
      values[field] = { value: input.overrides[field], source: "override", ruleId: null };
      continue;
    }
    const setting = matching.filter((r) => r.effects.some((e) => effectType(e.type).field === field));
    const winner = setting[0];
    if (!winner) {
      values[field] = { value: input.defaults[field], source: "default", ruleId: null };
      continue;
    }
    const tied = setting.filter((r) => r.priority === winner.priority);
    if (tied.length > 1) ties.push({ field, ruleIds: tied.map((r) => r.id) });
    const effect = winner.effects.find((e) => effectType(e.type).field === field)!;
    values[field] = { value: effectType(effect.type).apply(effect.value, input.defaults[field]), source: "rule", ruleId: winner.id };
  }
  return { values, ties };
}

export const sameResolved = (a: Resolved, b: Resolved) =>
  a.source === b.source && a.ruleId === b.ruleId && JSON.stringify(a.value) === JSON.stringify(b.value);
