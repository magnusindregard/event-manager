import type { LocalDateTime } from "@event-manager/db";
import { localDate, type SeriesDef, type Slot, slotAt } from "./recurrence.js";

// Regeneration diff (docs/implementation-plan.md, "Regeneration"). Pure: given a series'
// rule before and after a change, its existing occurrences and the new slots, decide what
// to create, move, delete and flag. The caller applies the plan, or returns it as a preview.

export interface ExistingOccurrence {
  id: string;
  recurrenceIdLocal: LocalDateTime;
  startUtc: Date;
  endUtc: Date;
  detached: boolean;
  conflict: boolean;
}

export type ConflictReason = "moved" | "removed";

export interface RegenerationPlan {
  create: Slot[];
  /** Non-detached occurrences that move to their new slot (time and/or key). */
  move: { id: string; from: { startUtc: Date; endUtc: Date }; to: Slot }[];
  /** Detached occurrences whose slot key changes but which stay where they are. */
  rekey: { id: string; recurrenceIdLocal: LocalDateTime }[];
  delete: { id: string; startUtc: Date; endUtc: Date }[];
  /** Detached occurrences the change would have moved or removed: kept and flagged. */
  conflicts: { id: string; reason: ConflictReason; startUtc: Date; endUtc: Date }[];
  unchanged: number;
}

export interface PlanInput {
  /** The rule before the change; null when only extending (no rule change). */
  before: SeriesDef | null;
  after: SeriesDef;
  existing: readonly ExistingOccurrence[];
  /** Slots of `after` in the window, in start order. */
  slots: readonly Slot[];
  /** Occurrences starting before this are history and are never touched. */
  cutoff: Date;
}

const sameTime = (a: { startUtc: Date; endUtc: Date }, b: { startUtc: Date; endUtc: Date }) =>
  a.startUtc.getTime() === b.startUtc.getTime() && a.endUtc.getTime() === b.endUtc.getTime();

/**
 * Matches existing occurrences to slots: first on the exact slot key, then by local date
 * and order within the day, so changing 14:00 to 15:00 moves each occurrence instead of
 * replacing it (its ID stays). Slots on dates that no longer occur are removed.
 */
export function planRegeneration(input: PlanInput): RegenerationPlan {
  const plan: RegenerationPlan = { create: [], move: [], rekey: [], delete: [], conflicts: [], unchanged: 0 };
  const frozen = input.existing.filter((o) => o.startUtc < input.cutoff);
  const taken = new Set(frozen.map((o) => o.recurrenceIdLocal));
  const live = input.existing.filter((o) => o.startUtc >= input.cutoff);
  const slots = input.slots.filter((s) => s.startUtc >= input.cutoff && !taken.has(s.recurrenceIdLocal));

  const pairs: [ExistingOccurrence, Slot][] = [];
  const byKey = new Map(live.map((o) => [o.recurrenceIdLocal, o]));
  const unmatchedSlots: Slot[] = [];
  for (const s of slots) {
    const o = byKey.get(s.recurrenceIdLocal);
    if (o) {
      pairs.push([o, s]);
      byKey.delete(s.recurrenceIdLocal);
    } else unmatchedSlots.push(s);
  }

  const group = <T>(items: T[], key: (t: T) => LocalDateTime) => {
    const m = new Map<string, T[]>();
    for (const it of [...items].sort((a, b) => key(a).localeCompare(key(b)))) {
      const d = localDate(key(it));
      m.set(d, [...(m.get(d) ?? []), it]);
    }
    return m;
  };
  const restByDate = group([...byKey.values()], (o) => o.recurrenceIdLocal);
  const slotsByDate = group(unmatchedSlots, (s) => s.recurrenceIdLocal);
  const leftover: ExistingOccurrence[] = [];
  for (const [date, occs] of restByDate) {
    const ss = slotsByDate.get(date) ?? [];
    occs.forEach((o, i) => (ss[i] ? pairs.push([o, ss[i]]) : leftover.push(o)));
    slotsByDate.set(date, ss.slice(occs.length));
  }
  plan.create = [...slotsByDate.values()].flat().sort((a, b) => a.startUtc.getTime() - b.startUtc.getTime());

  for (const [o, s] of pairs) {
    const rekeyed = o.recurrenceIdLocal !== s.recurrenceIdLocal;
    if (!o.detached) {
      if (rekeyed || !sameTime(o, s)) plan.move.push({ id: o.id, from: { startUtc: o.startUtc, endUtc: o.endUtc }, to: s });
      else plan.unchanged++;
      continue;
    }
    if (rekeyed) plan.rekey.push({ id: o.id, recurrenceIdLocal: s.recurrenceIdLocal });
    // The series would have moved this slot; the hand-edited occurrence stays and is flagged.
    const was = input.before ? slotAt(input.before, o.recurrenceIdLocal) : s;
    if (!sameTime(was, s)) plan.conflicts.push({ id: o.id, reason: "moved", startUtc: o.startUtc, endUtc: o.endUtc });
    else if (!rekeyed) plan.unchanged++;
  }

  for (const o of leftover) {
    if (o.detached) plan.conflicts.push({ id: o.id, reason: "removed", startUtc: o.startUtc, endUtc: o.endUtc });
    else plan.delete.push({ id: o.id, startUtc: o.startUtc, endUtc: o.endUtc });
  }
  return plan;
}
