import { type ActorContext, DomainError } from "../shared/index.js";
import type { Role } from "@event-manager/db";

/**
 * registrations.*: names and emails of attendees. Separate from content.* so the guest-data
 * permission (docs/registration.md, open question 1) can be narrowed without touching content.
 */
export type Permission = "account.write" | "members.manage" | "content.write" | "content.read" | "audit.read" | "registrations.read" | "registrations.write";

// Full role model from ADR 0005; the MVP enables owner and editor.
export const ENABLED_ROLES: readonly Role[] = ["owner", "editor"];

const grants: Record<Role, readonly Permission[]> = {
  owner: ["account.write", "members.manage", "content.write", "content.read", "audit.read", "registrations.read", "registrations.write"],
  editor: ["content.write", "content.read", "audit.read", "registrations.read", "registrations.write"],
  event_manager: ["content.write", "content.read", "audit.read", "registrations.read", "registrations.write"],
  box_office: ["content.read", "registrations.read", "registrations.write"],
  door_staff: ["content.read", "registrations.read"],
  finance: ["content.read", "audit.read"],
};

export function can(ctx: Pick<ActorContext, "roles">, permission: Permission): boolean {
  return ctx.roles.some((r) => grants[r as Role]?.includes(permission));
}

export function assertCan(ctx: Pick<ActorContext, "roles">, permission: Permission): void {
  if (!can(ctx, permission)) throw new DomainError("forbidden", `Missing permission ${permission}`);
}
