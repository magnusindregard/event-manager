import { type Db, newId, sql, type Tx, withoutTenant, type Role } from "@event-manager/db";
import { emit } from "../outbox/index.js";
import { type ActorContext, DomainError } from "../shared/index.js";
import { recordAudit } from "./audit.js";
import { assertCan, ENABLED_ROLES } from "./permissions.js";

export interface VerifiedIdentity {
  issuer: string;
  subject: string;
  email: string;
  name: string | null;
}

/** Upserts the staff user after the API verified the IdP token, and accepts pending invitations. */
export async function login(db: Db, identity: VerifiedIdentity): Promise<string> {
  return withoutTenant(db, async (tx) => {
    const res = await sql<{ id: string }>`
      select tenancy.login(${newId()}::uuid, ${identity.issuer}, ${identity.subject}, ${identity.email}, ${identity.name}) as id`.execute(tx);
    return res.rows[0]!.id;
  });
}

export interface AccountSummary {
  accountId: string;
  slug: string;
  name: string;
  roles: Role[];
}

export async function myAccounts(db: Db, userId: string): Promise<AccountSummary[]> {
  return withoutTenant(db, async (tx) => {
    const res = await sql<{ account_id: string; slug: string; name: string; roles: string }>`
      select account_id, slug, name, roles::text[] as roles from tenancy.my_accounts(${userId}::uuid)`.execute(tx);
    return res.rows.map((r) => ({ accountId: r.account_id, slug: r.slug, name: r.name, roles: r.roles as unknown as Role[] }));
  });
}

/** Roles of a user in the transaction's tenant. Authorization lives here, not in the IdP (ADR 0005). */
export async function rolesInTenant(tx: Tx, userId: string): Promise<Role[]> {
  const rows = await tx.selectFrom("tenancy.membership").select("role").where("user_id", "=", userId).execute();
  return rows.map((r) => r.role).filter((r) => ENABLED_ROLES.includes(r));
}

export interface Member {
  userId: string;
  email: string;
  name: string | null;
  roles: Role[];
}

export interface Invitation {
  id: string;
  email: string;
  role: Role;
  createdAt: Date;
}

export async function listMembers(tx: Tx): Promise<Member[]> {
  const rows = await tx
    .selectFrom("tenancy.membership as m")
    .innerJoin("tenancy.user as u", "u.id", "m.user_id")
    .select(["u.id", "u.email", "u.name", "m.role"])
    .orderBy("u.email")
    .execute();
  const byUser = new Map<string, Member>();
  for (const r of rows) {
    const m = byUser.get(r.id) ?? { userId: r.id, email: r.email, name: r.name, roles: [] };
    m.roles.push(r.role);
    byUser.set(r.id, m);
  }
  return [...byUser.values()];
}

export async function listInvitations(tx: Tx): Promise<Invitation[]> {
  const rows = await tx
    .selectFrom("tenancy.invitation")
    .select(["id", "email", "role", "created_at"])
    .where("accepted_at", "is", null)
    .orderBy("created_at", "desc")
    .execute();
  return rows.map((r) => ({ id: r.id, email: r.email, role: r.role, createdAt: r.created_at }));
}

export async function inviteMember(tx: Tx, ctx: ActorContext, email: string, role: Role): Promise<Invitation> {
  assertCan(ctx, "members.manage");
  if (!ENABLED_ROLES.includes(role)) throw new DomainError("validation_failed", `Role ${role} is not enabled`, { field: "role" });
  const row = await tx
    .insertInto("tenancy.invitation")
    .values({ id: newId(), tenant_id: ctx.tenantId, email: email.toLowerCase(), role, invited_by: ctx.userId })
    .onConflict((oc) => oc.columns(["tenant_id", "email", "role"]).doNothing())
    .returning(["id", "email", "role", "created_at"])
    .executeTakeFirst();
  if (!row) throw new DomainError("conflict", "Already invited");
  await recordAudit(tx, ctx, { action: "member.invited", entityType: "invitation", entityId: row.id, diff: { email: row.email, role } });
  await emit(tx, ctx.tenantId, { type: "member.invited.v1", subject: `invitation/${row.id}`, data: { id: row.id, role } });
  return { id: row.id, email: row.email, role: row.role, createdAt: row.created_at };
}

export async function removeMember(tx: Tx, ctx: ActorContext, userId: string): Promise<void> {
  assertCan(ctx, "members.manage");
  if (userId === ctx.userId) throw new DomainError("conflict", "You cannot remove yourself");
  const owners = await tx.selectFrom("tenancy.membership").select("user_id").where("role", "=", "owner").execute();
  if (owners.length === 1 && owners[0]!.user_id === userId) throw new DomainError("conflict", "An account needs at least one owner");
  const res = await tx.deleteFrom("tenancy.membership").where("user_id", "=", userId).executeTakeFirst();
  if (!res.numDeletedRows) throw new DomainError("not_found", "Member not found");
  await recordAudit(tx, ctx, { action: "member.removed", entityType: "user", entityId: userId });
  await emit(tx, ctx.tenantId, { type: "member.removed.v1", subject: `user/${userId}`, data: { userId } });
}
