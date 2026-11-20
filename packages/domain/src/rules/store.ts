import { type EffectiveField, newId, sql, type Tx, type ValueSource } from "@event-manager/db";
import { DomainError } from "../shared/index.js";
import type { Effect, Resolved, ResolvedFields, RuleDef } from "./engine.js";

// Storage for rules (rules.rule, rules.rule_effect) and materialized effective values
// (rules.effective_value). Validation and orchestration (audit, outbox, resolution) are
// the caller's; this only reads and writes rows.

export interface Rule extends RuleDef {
  eventId: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const columns = [
  "id", "event_id", "name", "priority", "active", "date_from", "date_to", "weekdays", "start_time_from", "start_time_to",
  "version", "created_at", "updated_at",
] as const;
type Row = {
  id: string; event_id: string; name: string; priority: number; active: boolean; date_from: string | null; date_to: string | null;
  weekdays: number[] | null; start_time_from: string | null; start_time_to: string | null; version: number; created_at: Date; updated_at: Date;
};

const hhmm = (t: string | null) => (t === null ? null : t.slice(0, 5));

async function hydrate(tx: Tx, rows: Row[]): Promise<Rule[]> {
  if (rows.length === 0) return [];
  const effects = await tx
    .selectFrom("rules.rule_effect")
    .select(["rule_id", "effect_type", "target_ref", "target_group", "value"])
    .where("rule_id", "in", rows.map((r) => r.id))
    .orderBy("effect_type")
    .execute();
  return rows.map((r) => ({
    id: r.id,
    eventId: r.event_id,
    name: r.name,
    priority: r.priority,
    active: r.active,
    conditions: {
      dateFrom: r.date_from,
      dateTo: r.date_to,
      weekdays: r.weekdays ? [...r.weekdays].sort() : null,
      startTimeFrom: hhmm(r.start_time_from),
      startTimeTo: hhmm(r.start_time_to),
    },
    effects: effects.filter((e) => e.rule_id === r.id).map((e) => ({ type: e.effect_type, targetRef: e.target_ref, ...(e.target_group ? { targetGroup: e.target_group } : {}), value: e.value })),
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

/** An event's rules, in resolution order (priority high to low, then oldest first). */
export async function listRules(tx: Tx, eventId: string): Promise<Rule[]> {
  const rows = await tx.selectFrom("rules.rule").select(columns).where("event_id", "=", eventId).orderBy("priority", "desc").orderBy("id").execute();
  return hydrate(tx, rows);
}

export async function findRule(tx: Tx, id: string): Promise<Rule | undefined> {
  const row = await tx.selectFrom("rules.rule").select(columns).where("id", "=", id).executeTakeFirst();
  return row ? (await hydrate(tx, [row]))[0] : undefined;
}

export async function getRule(tx: Tx, id: string): Promise<Rule> {
  const r = await findRule(tx, id);
  if (!r) throw new DomainError("not_found", "Rule not found");
  return r;
}

type Def = Omit<RuleDef, "id">;

const ruleColumns = (d: Def) => ({
  name: d.name,
  priority: d.priority,
  active: d.active,
  date_from: d.conditions.dateFrom,
  date_to: d.conditions.dateTo,
  weekdays: d.conditions.weekdays,
  start_time_from: d.conditions.startTimeFrom,
  start_time_to: d.conditions.startTimeTo,
});

async function writeEffects(tx: Tx, tenantId: string, ruleId: string, effects: readonly Effect[]) {
  await tx.deleteFrom("rules.rule_effect").where("rule_id", "=", ruleId).execute();
  await tx
    .insertInto("rules.rule_effect")
    .values(effects.map((e) => ({ id: newId(), tenant_id: tenantId, rule_id: ruleId, effect_type: e.type, target_ref: e.targetRef, target_group: e.targetGroup ?? null, value: JSON.stringify(e.value) })))
    .execute();
}

export async function insertRule(tx: Tx, tenantId: string, eventId: string, id: string, d: Def): Promise<void> {
  await tx.insertInto("rules.rule").values({ id, tenant_id: tenantId, event_id: eventId, ...ruleColumns(d) }).execute();
  await writeEffects(tx, tenantId, id, d.effects);
}

/** False if the rule is not at the expected version. */
export async function updateRule(tx: Tx, tenantId: string, id: string, expectedVersion: number, d: Def): Promise<boolean> {
  const res = await tx
    .updateTable("rules.rule")
    .set({ ...ruleColumns(d), version: sql<number>`version + 1` })
    .where("id", "=", id)
    .where("version", "=", expectedVersion)
    .executeTakeFirst();
  if (!res.numUpdatedRows) return false;
  await writeEffects(tx, tenantId, id, d.effects);
  return true;
}

export async function deleteRule(tx: Tx, id: string, expectedVersion: number): Promise<boolean> {
  const res = await tx.deleteFrom("rules.rule").where("id", "=", id).where("version", "=", expectedVersion).executeTakeFirst();
  return res.numDeletedRows > 0n;
}

export interface EffectiveRow {
  tenantId: string;
  occurrenceId: string;
  values: ResolvedFields;
}

const CHUNK = 1000;

/** Upserts effective values, every field of every given occurrence. */
export async function writeEffectiveValues(tx: Tx, rows: readonly EffectiveRow[]): Promise<void> {
  const flat = rows.flatMap((r) =>
    (Object.entries(r.values) as [EffectiveField, Resolved][]).map(([field, v]) => ({
      tenant_id: r.tenantId, occurrence_id: r.occurrenceId, field, value: JSON.stringify(v.value), source: v.source, rule_id: v.ruleId,
    })),
  );
  for (let i = 0; i < flat.length; i += CHUNK) {
    await tx
      .insertInto("rules.effective_value")
      .values(flat.slice(i, i + CHUNK))
      .onConflict((oc) =>
        oc.columns(["occurrence_id", "field"]).doUpdateSet((eb) => ({
          value: eb.ref("excluded.value"),
          source: eb.ref("excluded.source"),
          rule_id: eb.ref("excluded.rule_id"),
        })),
      )
      .execute();
  }
}

/** Materialized effective values for a set of occurrences. */
export async function loadEffectiveValues(tx: Tx, occurrenceIds: readonly string[]): Promise<Map<string, Partial<ResolvedFields>>> {
  const out = new Map<string, Partial<ResolvedFields>>();
  for (let i = 0; i < occurrenceIds.length; i += CHUNK) {
    const rows = await tx
      .selectFrom("rules.effective_value")
      .select(["occurrence_id", "field", "value", "source", "rule_id"])
      .where("occurrence_id", "in", occurrenceIds.slice(i, i + CHUNK))
      .execute();
    for (const r of rows) {
      const m = out.get(r.occurrence_id) ?? {};
      m[r.field] = { value: r.value, source: r.source as ValueSource, ruleId: r.rule_id };
      out.set(r.occurrence_id, m);
    }
  }
  return out;
}
