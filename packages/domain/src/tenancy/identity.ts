import { type Db, newId, type ProvisionStatus, sql, type SigninKind, type Tx, withoutTenant, type Role } from "@event-manager/db";
import { emit } from "../outbox/index.js";
import { type ActorContext, DomainError } from "../shared/index.js";
import { recordAudit } from "./audit.js";
import { assertCan, ENABLED_ROLES, type Permission, permissionsOf } from "./permissions.js";

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
  /** What the roles allow, so clients need not know the role model. */
  permissions: Permission[];
}

export async function myAccounts(db: Db, userId: string): Promise<AccountSummary[]> {
  return withoutTenant(db, async (tx) => {
    const res = await sql<{ account_id: string; slug: string; name: string; roles: string }>`
      select account_id, slug, name, roles::text[] as roles from tenancy.my_accounts(${userId}::uuid)`.execute(tx);
    return res.rows.map((r) => {
      const roles = r.roles as unknown as Role[];
      return { accountId: r.account_id, slug: r.slug, name: r.name, roles, permissions: permissionsOf(roles.filter((x) => ENABLED_ROLES.includes(x))) };
    });
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
  signinKind: SigninKind;
  provisioning: { status: ProvisionStatus; kind: "work" | "local" | null; error: string | null; attempts: number; emailSent: boolean };
}

const invitationColumns = [
  "id", "email", "role", "created_at", "signin_kind", "provision_status", "provisioned_kind",
  "provision_error", "provision_attempts", "email_sent_at",
] as const;

type InvitationRow = {
  id: string; email: string; role: Role; created_at: Date; signin_kind: SigninKind; provision_status: ProvisionStatus;
  provisioned_kind: "work" | "local" | null; provision_error: string | null; provision_attempts: number; email_sent_at: Date | null;
};

const toInvitation = (r: InvitationRow): Invitation => ({
  id: r.id,
  email: r.email,
  role: r.role,
  createdAt: r.created_at,
  signinKind: r.signin_kind,
  provisioning: {
    status: r.provision_status,
    kind: r.provisioned_kind,
    error: r.provision_error,
    attempts: r.provision_attempts,
    emailSent: r.email_sent_at !== null,
  },
});

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
    .select(invitationColumns)
    .where("accepted_at", "is", null)
    .orderBy("created_at", "desc")
    .execute();
  return rows.map(toInvitation);
}

/**
 * Invites someone by email. The worker then provisions their Entra identity and sends
 * the invitation email (ADR 0012); the membership is created on their first sign-in.
 */
export async function inviteMember(tx: Tx, ctx: ActorContext, email: string, role: Role, signinKind: SigninKind = "auto"): Promise<Invitation> {
  assertCan(ctx, "members.manage");
  if (!ENABLED_ROLES.includes(role)) throw new DomainError("validation_failed", `Role ${role} is not enabled`, { field: "role" });
  const row = await tx
    .insertInto("tenancy.invitation")
    .values({ id: newId(), tenant_id: ctx.tenantId, email: email.toLowerCase(), role, invited_by: ctx.userId, signin_kind: signinKind })
    .onConflict((oc) => oc.columns(["tenant_id", "email", "role"]).doNothing())
    .returning(invitationColumns)
    .executeTakeFirst();
  if (!row) throw new DomainError("conflict", "Already invited");
  await recordAudit(tx, ctx, { action: "member.invited", entityType: "invitation", entityId: row.id, diff: { email: row.email, role, signinKind } });
  await emit(tx, ctx.tenantId, { type: "member.invited.v1", subject: `invitation/${row.id}`, data: { id: row.id, role } });
  return toInvitation(row);
}

/** Owner action: try provisioning again after a failure (or to resend the email). */
export async function retryInvitation(tx: Tx, ctx: ActorContext, id: string): Promise<Invitation> {
  assertCan(ctx, "members.manage");
  const row = await tx
    .updateTable("tenancy.invitation")
    .set({ provision_status: "pending", provision_error: null, email_sent_at: null })
    .where("id", "=", id)
    .where("accepted_at", "is", null)
    .returning(invitationColumns)
    .executeTakeFirst();
  if (!row) throw new DomainError("not_found", "Pending invitation not found");
  await recordAudit(tx, ctx, { action: "member.invitation_retried", entityType: "invitation", entityId: id });
  await emit(tx, ctx.tenantId, { type: "member.invited.v1", subject: `invitation/${id}`, data: { id, role: row.role, retry: true } });
  return toInvitation(row);
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
