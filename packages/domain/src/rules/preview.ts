import type { EffectiveField, LocalDateTime } from "@event-manager/db";
import { effectType } from "./effects.js";
import { type FieldValues, FIELDS, matches, ordered, type Resolved, resolve, type RuleDef, sameResolved } from "./engine.js";

// Rule preview (docs/mvp.md, "Rule editor with live preview"): resolve an event's
// occurrences with the rules before and after a change and report the difference. Pure, so
// a dry run is just this function; the same comparison powers the result of a real save.

export interface PreviewOccurrence {
  id: string;
  startUtc: Date;
  startLocal: LocalDateTime;
  overrides: Partial<FieldValues>;
}

export interface FieldChange {
  field: EffectiveField;
  from: Resolved;
  to: Resolved;
}

export interface RulePreview {
  counts: {
    /** Occurrences meeting the rule's conditions. */
    matched: number;
    /** Occurrences whose effective values change. */
    changed: number;
    /** Matched occurrences where an override keeps a field the rule sets. */
    overridden: number;
    /** Occurrences where the rule ties with another rule of the same priority. */
    conflicts: number;
  };
  /** At most 200 items; counts are exact. */
  changes: { occurrenceId: string; startUtc: Date; fields: FieldChange[] }[];
  conflicts: { occurrenceId: string; startUtc: Date; field: EffectiveField; ruleIds: string[] }[];
}

export interface PreviewInput {
  defaults: FieldValues;
  occurrences: readonly PreviewOccurrence[];
  before: readonly RuleDef[];
  after: readonly RuleDef[];
  /** The rule being created, edited or deleted. */
  ruleId: string;
}

const LIST_CAP = 200;

export function previewRules(input: PreviewInput): RulePreview {
  const before = ordered(input.before);
  const after = ordered(input.after);
  const rule = input.after.find((r) => r.id === input.ruleId) ?? input.before.find((r) => r.id === input.ruleId);
  const ruleFields = new Set((rule?.effects ?? []).map((e) => effectType(e.type).field));
  const out: RulePreview = { counts: { matched: 0, changed: 0, overridden: 0, conflicts: 0 }, changes: [], conflicts: [] };

  for (const o of input.occurrences) {
    const base = { defaults: input.defaults, overrides: o.overrides, startLocal: o.startLocal };
    if (rule && matches(rule.conditions, o.startLocal)) {
      out.counts.matched++;
      if ([...ruleFields].some((f) => f in o.overrides)) out.counts.overridden++;
    }
    const a = resolve(base, before).values;
    const b = resolve(base, after);
    const fields = FIELDS.filter((f) => !sameResolved(a[f], b.values[f])).map((f) => ({ field: f, from: a[f], to: b.values[f] }));
    if (fields.length) {
      out.counts.changed++;
      if (out.changes.length < LIST_CAP) out.changes.push({ occurrenceId: o.id, startUtc: o.startUtc, fields });
    }
    const ties = b.ties.filter((t) => t.ruleIds.includes(input.ruleId));
    if (ties.length) {
      out.counts.conflicts++;
      for (const t of ties) if (out.conflicts.length < LIST_CAP) out.conflicts.push({ occurrenceId: o.id, startUtc: o.startUtc, field: t.field, ruleIds: t.ruleIds });
    }
  }
  return out;
}
