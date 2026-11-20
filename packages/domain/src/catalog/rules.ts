import { newId, type Tx } from "@event-manager/db";
import { emit } from "../outbox/index.js";
import * as rules from "../rules/index.js";
import { type ActorContext, DomainError } from "../shared/index.js";
import { assertCan, diffFields, recordAudit } from "../tenancy/index.js";
import { assertUsableGroups } from "./groups.js";
import { assertUsableLocation } from "./locations.js";
import { previewGroupTargets, previewOccurrences, previewTargets, resolutionContext, resolveEventSoon } from "./resolve.js";
import { notFound, versionConflict } from "./shared.js";
import { assertUsableTags } from "./tags.js";

// Occurrence rules on an event (docs/mvp.md, "Occurrence rules"). Every change is previewed
// first (the same comparison answers dryRun), then saved, audited on the event, and the
// event's occurrences resolved again: inline for small events, by the worker for large ones.

export type Rule = rules.Rule;

export interface RuleInput {
  name: string;
  priority?: number;
  active?: boolean;
  conditions?: Partial<rules.Conditions>;
  effects: rules.EffectInput[];
}

export type RulePatch = Partial<RuleInput>;

export interface RuleChangeResult {
  /** Null for the preview of a rule that does not exist yet, and after a delete. */
  rule: Rule | null;
  preview: rules.RulePreview;
  /** "queued": the worker resolves the event's occurrences shortly. "none": no value changes. */
  resolution: "done" | "queued" | "none";
}

export interface RuleChangeOptions {
  dryRun?: boolean;
}

export const listRules = (tx: Tx, eventId: string): Promise<Rule[]> => rules.listRules(tx, eventId);
export const getRule = (tx: Tx, id: string): Promise<Rule> => rules.getRule(tx, id);

/**
 * Locks the event row for the whole rule change: resolvers (resolutionContext) and schedule
 * changes (lockScheduleEvent) take it FOR SHARE, so the preview sees every occurrence and rule
 * the save will apply to, and "resolution: none" stays true once saved (#41, #42).
 */
async function writableEvent(tx: Tx, eventId: string) {
  const event = await tx.selectFrom("catalog.event").select(["id", "status"]).where("id", "=", eventId).forUpdate().executeTakeFirst();
  if (!event) throw notFound("Event");
  if (event.status === "archived") throw new DomainError("conflict", "The event is archived");
}

function normalize(input: RuleInput): Omit<rules.RuleDef, "id"> {
  const name = input.name?.trim() ?? "";
  if (name.length < 1 || name.length > 200) throw new DomainError("validation_failed", "Name the rule (at most 200 characters)", { field: "name" });
  const priority = input.priority ?? 0;
  if (!Number.isInteger(priority) || priority < -1000 || priority > 1000) throw new DomainError("validation_failed", "Priority is -1000 to 1000", { field: "priority" });
  return {
    name,
    priority,
    active: input.active ?? true,
    conditions: rules.normalizeConditions(input.conditions),
    effects: rules.normalizeEffects(input.effects ?? []),
  };
}

/**
 * Locations and tags the effects point at must exist and be in use; ones the rule already had may
 * since be archived. Offers must be the event's own, and active unless the rule already had them.
 */
async function checkRefs(tx: Tx, eventId: string, effects: readonly rules.Effect[], before?: readonly rules.Effect[]) {
  const now = rules.effectRefs(effects);
  const had = before ? rules.effectRefs(before) : { locations: [] as string[], tags: [] as string[], offers: [] as string[], groups: [] as string[] };
  for (const id of now.locations.filter((x) => !had.locations.includes(x))) await assertUsableLocation(tx, id, "effects");
  await assertUsableTags(tx, now.tags.filter((x) => !had.tags.includes(x)), "effects");
  const added = now.offers.filter((x) => !had.offers.includes(x));
  if (added.length) {
    const found = await tx.selectFrom("offers.offer").select(["id", "status"]).where("event_id", "=", eventId).where("id", "in", added).execute();
    const missing = added.find((id) => !found.some((o) => o.id === id && o.status === "active"));
    if (missing) throw new DomainError("validation_failed", "The offer is not an active offer of this event", { field: "effects", offerId: missing });
  }
  // Group prices name active user groups; groups the rule already had may since be archived.
  await assertUsableGroups(tx, now.groups.filter((x) => !had.groups.includes(x)), [], "effects");
}

/** Price and availability effects are offer settings: changing them takes offers.write as well (docs/ticketing.md, "Permissions"). */
function assertCanTargets(ctx: ActorContext, ...effects: (readonly rules.Effect[] | undefined)[]) {
  if (effects.some((list) => list?.some((e) => e.targetRef !== null))) assertCan(ctx, "offers.write");
}

async function preview(tx: Tx, eventId: string, change: (existing: rules.Rule[]) => rules.RuleDef[], ruleId: string) {
  const c = await resolutionContext(tx, eventId);
  return rules.previewRules({
    defaults: c.defaults,
    targets: previewTargets(c),
    groupTargets: previewGroupTargets(c),
    occurrences: await previewOccurrences(tx, eventId, c.timezone, c.offers.length > 0),
    before: c.rules,
    after: change(c.rules),
    ruleId,
  });
}

async function finish(
  tx: Tx, ctx: ActorContext, eventId: string, ruleId: string, change: "created" | "updated" | "deleted", p: rules.RulePreview, audit: Record<string, unknown>,
): Promise<RuleChangeResult["resolution"]> {
  const resolution = p.counts.changed === 0 ? "none" : await resolveEventSoon(tx, eventId);
  await recordAudit(tx, ctx, { action: `rule.${change}`, entityType: "event", entityId: eventId, diff: { ruleId, ...audit, changedOccurrences: p.counts.changed } });
  await emit(tx, ctx.tenantId, {
    type: "rule.changed.v1",
    subject: `rule/${ruleId}`,
    data: { id: ruleId, eventId, change, changedOccurrences: p.counts.changed, resolution },
  });
  return resolution;
}

const summary = (d: Omit<rules.RuleDef, "id">) => ({ name: d.name, priority: d.priority, active: d.active, conditions: d.conditions, effects: d.effects });

export async function createRule(tx: Tx, ctx: ActorContext, eventId: string, input: RuleInput, opts: RuleChangeOptions = {}): Promise<RuleChangeResult> {
  assertCan(ctx, "content.write");
  await writableEvent(tx, eventId);
  const def = normalize(input);
  assertCanTargets(ctx, def.effects);
  await checkRefs(tx, eventId, def.effects);
  // A new rule's id sorts after every existing one, so it loses equal-priority ties, as it will once saved.
  const id = newId();
  const p = await preview(tx, eventId, (existing) => [...existing, { ...def, id }], id);
  if (opts.dryRun) return { rule: null, preview: p, resolution: "none" };

  await rules.insertRule(tx, ctx.tenantId, eventId, id, def);
  const resolution = await finish(tx, ctx, eventId, id, "created", p, summary(def));
  return { rule: await rules.getRule(tx, id), preview: p, resolution };
}

export async function updateRule(tx: Tx, ctx: ActorContext, id: string, expectedVersion: number, patch: RulePatch, opts: RuleChangeOptions = {}): Promise<RuleChangeResult> {
  assertCan(ctx, "content.write");
  const before = await rules.getRule(tx, id);
  if (before.version !== expectedVersion) throw versionConflict("Rule", before.version);
  await writableEvent(tx, before.eventId);
  const def = normalize({
    name: patch.name ?? before.name,
    priority: patch.priority ?? before.priority,
    active: patch.active ?? before.active,
    conditions: patch.conditions ? { ...before.conditions, ...patch.conditions } : before.conditions,
    effects: patch.effects ?? before.effects,
  });
  assertCanTargets(ctx, def.effects, before.effects);
  await checkRefs(tx, before.eventId, def.effects, before.effects);
  const p = await preview(tx, before.eventId, (existing) => existing.map((r) => (r.id === id ? { ...def, id } : r)), id);
  if (opts.dryRun) return { rule: { ...before, ...def }, preview: p, resolution: "none" };

  if (!(await rules.updateRule(tx, ctx.tenantId, id, expectedVersion, def))) throw versionConflict("Rule", before.version);
  const resolution = await finish(tx, ctx, before.eventId, id, "updated", p, { name: def.name, ...diffFields(summary(before), summary(def)) });
  return { rule: await rules.getRule(tx, id), preview: p, resolution };
}

export async function deleteRule(tx: Tx, ctx: ActorContext, id: string, expectedVersion: number, opts: RuleChangeOptions = {}): Promise<RuleChangeResult> {
  assertCan(ctx, "content.write");
  const before = await rules.getRule(tx, id);
  if (before.version !== expectedVersion) throw versionConflict("Rule", before.version);
  await writableEvent(tx, before.eventId);
  assertCanTargets(ctx, before.effects);
  const p = await preview(tx, before.eventId, (existing) => existing.filter((r) => r.id !== id), id);
  if (opts.dryRun) return { rule: before, preview: p, resolution: "none" };

  if (!(await rules.deleteRule(tx, id, expectedVersion))) throw versionConflict("Rule", before.version);
  const resolution = await finish(tx, ctx, before.eventId, id, "deleted", p, summary(before));
  return { rule: null, preview: p, resolution };
}
