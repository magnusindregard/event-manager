import { type SigninKind, sql, type Tx } from "@event-manager/db";

// State changes for Entra provisioning of invitations (ADR 0012). The worker calls Graph
// outside any transaction and records each outcome in its own short transaction, so a
// failure stays visible to owners while the job retries.

export interface InvitationToProvision {
  id: string;
  email: string;
  signinKind: SigninKind;
  provisioned: boolean;
  provisionedKind: "work" | "local" | null;
  entraObjectId: string | null;
  emailSent: boolean;
  accepted: boolean;
  account: { name: string; defaultLocale: string };
  invitedBy: string | null;
}

export async function loadInvitationToProvision(tx: Tx, id: string): Promise<InvitationToProvision | undefined> {
  const row = await tx
    .selectFrom("tenancy.invitation as i")
    .innerJoin("tenancy.account as a", "a.id", "i.tenant_id")
    .leftJoin("tenancy.user as u", "u.id", "i.invited_by")
    .select([
      "i.id", "i.email", "i.signin_kind", "i.provision_status", "i.provisioned_kind", "i.entra_object_id", "i.email_sent_at", "i.accepted_at",
      "a.name as account_name", "a.default_locale", "u.name as inviter_name", "u.email as inviter_email",
    ])
    .where("i.id", "=", id)
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    id: row.id,
    email: row.email,
    signinKind: row.signin_kind,
    provisioned: row.provision_status === "provisioned",
    provisionedKind: row.provisioned_kind,
    entraObjectId: row.entra_object_id,
    emailSent: row.email_sent_at !== null,
    accepted: row.accepted_at !== null,
    account: { name: row.account_name, defaultLocale: row.default_locale },
    invitedBy: row.inviter_name ?? row.inviter_email ?? null,
  };
}

export async function markInvitationProvisioned(tx: Tx, id: string, kind: "work" | "local", objectId: string): Promise<void> {
  await tx
    .updateTable("tenancy.invitation")
    .set({
      provision_status: "provisioned",
      provisioned_kind: kind,
      entra_object_id: objectId,
      provision_error: null,
      provisioned_at: sql<Date>`now()`,
      provision_attempts: sql<number>`provision_attempts + 1`,
    })
    .where("id", "=", id)
    .execute();
}

export async function markInvitationFailed(tx: Tx, id: string, error: string): Promise<void> {
  await tx
    .updateTable("tenancy.invitation")
    .set({ provision_status: "failed", provision_error: error.slice(0, 1000), provision_attempts: sql<number>`provision_attempts + 1` })
    .where("id", "=", id)
    .execute();
}

export async function markInvitationEmailed(tx: Tx, id: string): Promise<void> {
  await tx.updateTable("tenancy.invitation").set({ email_sent_at: sql<Date>`now()` }).where("id", "=", id).execute();
}
