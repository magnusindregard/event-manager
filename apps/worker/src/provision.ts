import type { Task } from "graphile-worker";
import { type Db, sql, withTenant } from "@event-manager/db";
import { tenancy } from "@event-manager/domain";
import type { InternalHandler } from "./handlers.js";
import { DirectoryError, type IdentityDirectory } from "./identity/directory.js";
import { invitationEmail, type Mailer } from "./identity/mailer.js";

export interface ProvisionDeps {
  directory: IdentityDirectory;
  mailer: Mailer;
  /** Where invitees land after signing in, e.g. https://<front door host>/ */
  adminUrl: string;
}

export const PROVISION_TASK = "invitation.provision";

/**
 * member.invited.v1 → a dedicated job per invitation. The job key coalesces duplicates, and
 * the job runs outside the dispatch transaction because it calls external services.
 */
export const enqueueProvisioning: InternalHandler = {
  name: "enqueue-provisioning",
  types: ["member.invited.v1"],
  async handle(tx, event) {
    const id = (event.data as { id?: string }).id;
    if (!id) return;
    await sql`select graphile_worker.add_job(
      ${PROVISION_TASK},
      json_build_object('invitationId', ${id}::text, 'tenantId', ${event.tenantId}::text),
      job_key := ${`invitation:${id}`},
      max_attempts := 10)`.execute(tx);
  },
};

interface Payload {
  invitationId: string;
  tenantId: string;
}
const isPayload = (p: unknown): p is Payload =>
  typeof p === "object" && p !== null && typeof (p as Payload).invitationId === "string" && typeof (p as Payload).tenantId === "string";

/**
 * Creates the invitee's Entra identity (guest for work accounts, local OTP account otherwise)
 * and sends our invitation email. Idempotent: an existing identity is reused, and each step
 * is recorded, so a retry continues where the last attempt stopped.
 */
export function provisionTask(db: Db, deps: ProvisionDeps): Task {
  return async (payload, helpers) => {
    if (!isPayload(payload)) throw new Error("Invalid invitation.provision payload");
    const scope = { tenantId: payload.tenantId };
    const inv = await withTenant(db, scope, (tx) => tenancy.loadInvitationToProvision(tx, payload.invitationId));
    if (!inv || inv.accepted) return;
    if (inv.provisioned && inv.emailSent) return;

    // Guests that skip the redeem link redeem just in time on their first sign-in at adminUrl.
    let kind: "work" | "local" = inv.provisionedKind ?? (inv.signinKind === "auto" ? "local" : inv.signinKind);
    let redeemUrl: string | null = null;
    if (!inv.provisioned) {
      try {
        if (inv.signinKind === "auto") kind = await deps.directory.realm(inv.email);
        const existing = await deps.directory.findUserByEmail(inv.email);
        let objectId: string;
        if (existing) {
          objectId = existing.id;
        } else if (kind === "work") {
          const guest = await deps.directory.inviteGuest(inv.email, deps.adminUrl);
          objectId = guest.id;
          redeemUrl = guest.redeemUrl;
        } else {
          objectId = (await deps.directory.createLocalUser(inv.email)).id;
        }
        await withTenant(db, scope, (tx) => tenancy.markInvitationProvisioned(tx, inv.id, kind, objectId));
        helpers.logger.info(`provisioned invitation ${inv.id} as ${kind}${existing ? " (existing identity)" : ""}`);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        await withTenant(db, scope, (tx) => tenancy.markInvitationFailed(tx, inv.id, message));
        // Non-retryable Graph errors (400/403) still retry a few times; owners can retry later too.
        if (e instanceof DirectoryError && !e.retryable) helpers.logger.error(`provisioning ${inv.id} failed: ${message}`);
        throw e;
      }
    }

    const mail = invitationEmail({ locale: inv.account.defaultLocale, accountName: inv.account.name, invitedBy: inv.invitedBy, adminUrl: deps.adminUrl, kind, redeemUrl });
    await deps.mailer.send({ to: inv.email, ...mail });
    await withTenant(db, scope, (tx) => tenancy.markInvitationEmailed(tx, inv.id));
  };
}
