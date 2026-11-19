import { type ActorContext, DomainError } from "../shared/index.js";
import type { Role } from "@event-manager/db";

/**
 * Guest data is kept apart from content (docs/registration.md, open question 1):
 *   registrations.read / write  names, emails, plain answers, the guest list and door list
 *   registrations.sensitive     sensitive answers (dietary needs, free text marked sensitive)
 * Editors work on content only; event managers have content and guest data.
 * offers.write covers offers, prices and price rules (docs/ticketing.md, "Permissions").
 */
export type Permission =
  | "account.write" | "members.manage" | "content.write" | "content.read" | "audit.read"
  | "registrations.read" | "registrations.write" | "registrations.sensitive" | "offers.write";

// Full role model from ADR 0005. Box office, door staff and finance arrive with ticketing and the validator.
export const ENABLED_ROLES: readonly Role[] = ["owner", "event_manager", "editor"];

const grants: Record<Role, readonly Permission[]> = {
  owner: ["account.write", "members.manage", "content.write", "content.read", "audit.read", "registrations.read", "registrations.write", "registrations.sensitive", "offers.write"],
  event_manager: ["content.write", "content.read", "audit.read", "registrations.read", "registrations.write", "registrations.sensitive", "offers.write"],
  editor: ["content.write", "content.read", "audit.read"],
  box_office: ["content.read", "registrations.read", "registrations.write"],
  door_staff: ["content.read", "registrations.read"],
  finance: ["content.read", "audit.read"],
};

/** The permissions a set of roles grants, e.g. for the admin to show or hide guest data. */
export function permissionsOf(roles: readonly string[]): Permission[] {
  return [...new Set(roles.flatMap((r) => grants[r as Role] ?? []))];
}

export function can(ctx: Pick<ActorContext, "roles">, permission: Permission): boolean {
  return ctx.roles.some((r) => grants[r as Role]?.includes(permission));
}

export function assertCan(ctx: Pick<ActorContext, "roles">, permission: Permission): void {
  if (!can(ctx, permission)) throw new DomainError("forbidden", `Missing permission ${permission}`);
}
