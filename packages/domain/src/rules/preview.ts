import type { EffectiveField, LocalDateTime, TargetedField } from "@event-manager/db";
import { effectType } from "./effects.js";
import {
  type FieldValues, FIELDS, groupKey, groupRuleTargets, matches, ordered, type Resolved, resolve, resolveGroupPrices, resolveTargets, type RuleDef, sameResolved,
  TARGETED_FIELDS, type TargetValues,
} from "./engine.js";

// Rule preview (docs/mvp.md, "Rule editor with live preview"): resolve an event's
// occurrences with the rules before and after a change and report the difference. Pure, so
// a dry run is just this function; the same comparison powers the result of a real save.
// Targeted fields (an offer's price and availability) are compared per target.

export interface PreviewOccurrence {
  id: string;
  startUtc: Date;
  startLocal: LocalDateTime;
  overrides: Partial<FieldValues>;
  /** Overrides of targeted fields, per target (offer id). */
  targetOverrides?: Record<string, Partial<TargetValues>>;
  /** Group overrides, per groupKey(offer, group). */
  groupOverrides?: Record<string, number>;
}

export interface FieldChange {
  field: EffectiveField | TargetedField;
  /** The offer of a price or offerAvailable change; null otherwise. */
  targetRef: string | null;
  /** The user group of a group price change; null otherwise. A group without a price of its own shows the general price. */
  group: string | null;
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
  conflicts: { occurrenceId: string; startUtc: Date; field: EffectiveField | TargetedField; targetRef: string | null; group: string | null; ruleIds: string[] }[];
}

export interface PreviewInput {
  defaults: FieldValues;
  /** Targets of targeted fields (the event's offers) with their defaults. */
  targets?: readonly { ref: string; defaults: TargetValues }[];
  /** The offers' own group prices (docs/user-groups.md). */
  groupTargets?: readonly { ref: string; group: string; groupDefault: number }[];
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
  const ruleEffects = (rule?.effects ?? []).map((e) => ({ field: effectType(e.type).field, targetRef: e.targetRef, targetGroup: e.targetGroup }));
  const targets = input.targets ?? [];
  const groupDefaults = new Map((input.groupTargets ?? []).map((g) => [groupKey(g.ref, g.group), g.groupDefault]));
  const rulePairs = groupRuleTargets([...input.before, ...input.after]);
  const out: RulePreview = { counts: { matched: 0, changed: 0, overridden: 0, conflicts: 0 }, changes: [], conflicts: [] };

  for (const o of input.occurrences) {
    const base = { defaults: input.defaults, overrides: o.overrides, startLocal: o.startLocal };
    if (rule && matches(rule.conditions, o.startLocal)) {
      out.counts.matched++;
      const overridden = ruleEffects.some((e) =>
        e.targetRef === null ? e.field in o.overrides
          : e.targetGroup ? (o.groupOverrides?.[groupKey(e.targetRef, e.targetGroup)] !== undefined)
          : e.field in (o.targetOverrides?.[e.targetRef] ?? {}));
      if (overridden) out.counts.overridden++;
    }
    const a = resolve(base, before).values;
    const b = resolve(base, after);
    const fields: FieldChange[] = FIELDS.filter((f) => !sameResolved(a[f], b.values[f])).map((f) => ({ field: f, targetRef: null, group: null, from: a[f], to: b.values[f] }));
    const ties = b.ties.filter((t) => t.ruleIds.includes(input.ruleId));

    if (targets.length) {
      const inputs = targets.map((t) => ({ ref: t.ref, defaults: t.defaults, overrides: o.targetOverrides?.[t.ref] ?? {} }));
      const ta = resolveTargets(inputs, o.startLocal, before).values;
      const tb = resolveTargets(inputs, o.startLocal, after);
      for (const t of targets) {
        for (const f of TARGETED_FIELDS) {
          const from = ta.get(t.ref)![f];
          const to = tb.values.get(t.ref)![f];
          if (!sameResolved(from, to)) fields.push({ field: f, targetRef: t.ref, group: null, from, to });
        }
      }
      ties.push(...tb.ties.filter((t) => t.ruleIds.includes(input.ruleId)));

      // Group prices: every pair that has a group price, a group override or a group effect in either rule set.
      const pairs = new Map<string, { ref: string; group: string }>();
      for (const g of input.groupTargets ?? []) pairs.set(groupKey(g.ref, g.group), g);
      for (const p of rulePairs) pairs.set(groupKey(p.ref, p.group), p);
      for (const k of Object.keys(o.groupOverrides ?? {})) {
        const [ref, group] = k.split("|") as [string, string];
        pairs.set(k, { ref, group });
      }
      if (pairs.size) {
        const gInputs = [...pairs.entries()].filter(([, p]) => ta.has(p.ref)).map(([k, p]) => ({
          ref: p.ref, group: p.group, groupDefault: groupDefaults.get(k) ?? null, override: o.groupOverrides?.[k],
        }));
        const ga = resolveGroupPrices(gInputs, o.startLocal, before).values;
        const gb = resolveGroupPrices(gInputs, o.startLocal, after);
        for (const g of gInputs) {
          const k = groupKey(g.ref, g.group);
          // Without a price of its own the group pays the general price.
          const from = ga.get(k) ?? ta.get(g.ref)!.price;
          const to = gb.values.get(k) ?? tb.values.get(g.ref)!.price;
          if (!sameResolved(from, to)) fields.push({ field: "price", targetRef: g.ref, group: g.group, from, to });
        }
        ties.push(...gb.ties.filter((t) => t.ruleIds.includes(input.ruleId)));
      }
    }

    if (fields.length) {
      out.counts.changed++;
      if (out.changes.length < LIST_CAP) out.changes.push({ occurrenceId: o.id, startUtc: o.startUtc, fields });
    }
    if (ties.length) {
      out.counts.conflicts++;
      for (const t of ties) {
        if (out.conflicts.length < LIST_CAP) out.conflicts.push({ occurrenceId: o.id, startUtc: o.startUtc, field: t.field, targetRef: t.targetRef, group: t.group ?? null, ruleIds: t.ruleIds });
      }
    }
  }
  return out;
}
