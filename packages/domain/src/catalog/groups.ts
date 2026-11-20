import { newId, sql, type Tx } from "@event-manager/db";
import { emit } from "../outbox/index.js";
import { type ActorContext, DomainError } from "../shared/index.js";
import { assertCan, diffFields, recordAudit } from "../tenancy/index.js";
import type { Labels } from "./tags.js";

// User groups per account (docs/user-groups.md). They mirror the groups the client's frontend
// already has (Member, Sponsor); the platform does not authenticate buyers, the channel
// connector says which group a buyer is in. Groups are archived, never deleted, and a group an
// event or offer is restricted to cannot be archived: that would quietly open it to everyone.

export interface UserGroup {
  id: string;
  code: string;
  names: Labels;
  sortOrder: number;
  archived: boolean;
  /** Events and offers (not archived) restricted to this group. */
  usedBy: number;
  version: number;
  updatedAt: Date;
}

export interface UserGroupInput {
  code: string;
  names: Labels;
  sortOrder?: number;
}

export interface UserGroupPatch {
  names?: Labels;
  sortOrder?: number;
  archived?: boolean;
}

/** The short form other read models use. */
export interface GroupRef {
  id: string;
  code: string;
  names: Labels;
}

export const MAX_GROUPS = 50;
const CODE_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const invalid = (field: string, message: string) => new DomainError("validation_failed", message, { field });

function validateNames(v: Labels | undefined) {
  const entries = Object.entries(v ?? {});
  if (entries.length === 0 || entries.length > 20) throw invalid("names", "Name the group in at least one language");
  for (const [locale, name] of entries) {
    if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(locale)) throw invalid("names", `Unknown language tag "${locale}"`);
    if (typeof name !== "string" || !name.trim() || name.trim().length > 200) throw invalid("names", "Each name has 1–200 characters");
  }
}

function cleanNames(v: Labels): Labels {
  return Object.fromEntries(Object.entries(v).map(([k, n]) => [k, n.trim()]));
}

function validateSortOrder(v: number | undefined) {
  if (v !== undefined && (!Number.isInteger(v) || v < -10000 || v > 10000)) throw invalid("sortOrder", "Must be a whole number, -10000–10000");
}

async function select(tx: Tx, id?: string): Promise<UserGroup[]> {
  let q = tx
    .selectFrom("catalog.user_group as g")
    .select(["g.id", "g.code", "g.names", "g.sort_order", "g.archived_at", "g.version", "g.updated_at"])
    .select(() => usedBySql.as("used_by"))
    .orderBy("g.sort_order")
    .orderBy("g.code");
  if (id) q = q.where("g.id", "=", id);
  const rows = await q.execute();
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    names: r.names,
    sortOrder: r.sort_order,
    archived: r.archived_at !== null,
    usedBy: Number(r.used_by),
    version: r.version,
    updatedAt: r.updated_at,
  }));
}

const usedBySql = sql<number>`(
  (SELECT count(*) FROM catalog.event_access_group ea JOIN catalog.event e ON e.id = ea.event_id WHERE ea.group_id = g.id AND e.status <> 'archived')
  + (SELECT count(*) FROM offers.offer_access_group oa JOIN offers.offer o ON o.id = oa.offer_id WHERE oa.group_id = g.id AND o.status <> 'archived')
)`;

export const listUserGroups = (tx: Tx): Promise<UserGroup[]> => select(tx);

export async function getUserGroup(tx: Tx, id: string): Promise<UserGroup> {
  const [g] = await select(tx, id);
  if (!g) throw new DomainError("not_found", "User group not found");
  return g;
}

export async function createUserGroup(tx: Tx, ctx: ActorContext, input: UserGroupInput): Promise<UserGroup> {
  assertCan(ctx, "account.write");
  if (!CODE_RE.test(input.code ?? "")) throw invalid("code", "Use lowercase letters, digits, - and _");
  validateNames(input.names);
  validateSortOrder(input.sortOrder);
  // Serialize creates per account so the limit holds.
  await tx.selectFrom("tenancy.account").select("id").where("id", "=", ctx.tenantId).forUpdate().executeTakeFirstOrThrow();
  const { n } = await tx.selectFrom("catalog.user_group").select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow();
  if (Number(n) >= MAX_GROUPS) throw new DomainError("conflict", `An account has at most ${MAX_GROUPS} user groups`);
  const id = newId();
  try {
    await tx
      .insertInto("catalog.user_group")
      .values({ id, tenant_id: ctx.tenantId, code: input.code, names: JSON.stringify(cleanNames(input.names)), sort_order: input.sortOrder ?? 0 })
      .execute();
  } catch (e) {
    if (typeof e === "object" && e !== null && (e as { code?: string }).code === "23505") throw new DomainError("conflict", "Another user group uses this code", { field: "code" });
    throw e;
  }
  await recordAudit(tx, ctx, { action: "user_group.created", entityType: "account", entityId: ctx.tenantId, diff: { id, code: input.code } });
  await emit(tx, ctx.tenantId, { type: "user_group.changed.v1", subject: `user-group/${id}`, data: { id, code: input.code, change: "created" } });
  return getUserGroup(tx, id);
}

export async function updateUserGroup(tx: Tx, ctx: ActorContext, id: string, expectedVersion: number, patch: UserGroupPatch): Promise<UserGroup> {
  assertCan(ctx, "account.write");
  // Lock the group so no event or offer starts using it while it is archived (they take it for share).
  const locked = await tx.selectFrom("catalog.user_group").select("id").where("id", "=", id).forUpdate().executeTakeFirst();
  if (!locked) throw new DomainError("not_found", "User group not found");
  const before = await getUserGroup(tx, id);
  if (before.version !== expectedVersion) throw new DomainError("version_conflict", "User group was changed by someone else", { currentVersion: before.version });
  if (patch.names !== undefined) validateNames(patch.names);
  validateSortOrder(patch.sortOrder);
  if (patch.archived === true && !before.archived && before.usedBy > 0) {
    throw new DomainError("conflict", `${before.usedBy} events and ticket types are restricted to this group. Remove it from them first`, { field: "archived", usedBy: before.usedBy });
  }
  await tx
    .updateTable("catalog.user_group")
    .set({
      ...(patch.names ? { names: JSON.stringify(cleanNames(patch.names)) } : {}),
      sort_order: patch.sortOrder,
      ...(patch.archived === undefined ? {} : { archived_at: patch.archived ? (before.archived ? undefined : sql<Date>`now()`) : null }),
      version: sql<number>`version + 1`,
    })
    .where("id", "=", id)
    .execute();
  const after = await getUserGroup(tx, id);
  const diff = diffFields(before as unknown as Record<string, unknown>, { names: after.names, sortOrder: after.sortOrder, archived: after.archived });
  const change = after.archived !== before.archived ? (after.archived ? "archived" : "restored") : "updated";
  await recordAudit(tx, ctx, { action: change === "archived" ? "user_group.archived" : "user_group.updated", entityType: "account", entityId: ctx.tenantId, diff: { id, code: before.code, ...diff } });
  await emit(tx, ctx.tenantId, { type: "user_group.changed.v1", subject: `user-group/${id}`, data: { id, code: before.code, change } });
  return after;
}

/**
 * Checks a list of group ids for an access restriction: known, active (unless the entity already
 * had them) and unique. Locks them for share so none can be archived under the restriction.
 */
export async function assertUsableGroups(tx: Tx, ids: string[], keep: string[] = [], field = "accessGroupIds"): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const rows = await tx.selectFrom("catalog.user_group").select(["id", "archived_at"]).where("id", "in", unique).orderBy("id").forShare().execute();
  if (rows.length !== unique.length) throw invalid(field, "Unknown user group");
  if (rows.some((r) => r.archived_at && !keep.includes(r.id))) throw invalid(field, "The user group is archived");
  return unique.sort();
}

/** An active group by its code, as a connector or a public caller names it. */
export async function groupByCode(tx: Tx, code: string): Promise<GroupRef | null> {
  const g = await tx.selectFrom("catalog.user_group").select(["id", "code", "names"]).where("code", "=", code).where("archived_at", "is", null).executeTakeFirst();
  return g ? { id: g.id, code: g.code, names: g.names } : null;
}

/** Groups per event, in display order (active and archived alike: the restriction holds either way). */
export async function eventAccessGroups(tx: Tx, eventIds: string[]): Promise<Map<string, GroupRef[]>> {
  const out = new Map<string, GroupRef[]>();
  if (eventIds.length === 0) return out;
  const rows = await tx
    .selectFrom("catalog.event_access_group as ea")
    .innerJoin("catalog.user_group as g", "g.id", "ea.group_id")
    .select(["ea.event_id", "g.id", "g.code", "g.names"])
    .where("ea.event_id", "in", eventIds)
    .orderBy("g.sort_order")
    .orderBy("g.code")
    .execute();
  for (const r of rows) {
    const list = out.get(r.event_id) ?? [];
    list.push({ id: r.id, code: r.code, names: r.names });
    out.set(r.event_id, list);
  }
  return out;
}

/** Replaces an event's access list. The caller has locked the event. */
export async function writeEventAccess(tx: Tx, tenantId: string, eventId: string, groupIds: string[]): Promise<void> {
  await tx.deleteFrom("catalog.event_access_group").where("event_id", "=", eventId).execute();
  if (groupIds.length) {
    await tx.insertInto("catalog.event_access_group").values(groupIds.map((group_id) => ({ tenant_id: tenantId, event_id: eventId, group_id }))).execute();
  }
}

/** Whether a buyer in `groupId` (null: no group) may pass an access list. */
export function admits(list: { id: string }[], groupId: string | null): boolean {
  return list.length === 0 || (groupId !== null && list.some((g) => g.id === groupId));
}

/** The name for a locale, falling back to the account's default locale and then any. */
export function groupName(names: Labels, locale: string, fallback: string): string {
  return names[locale] ?? names[fallback] ?? Object.values(names)[0] ?? "";
}
