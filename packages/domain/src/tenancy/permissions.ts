import { type ActorContext, DomainError } from "../shared/index.js";
import type { Role } from "@event-manager/db";

export type Permission = "account.write" | "members.manage" | "content.write" | "content.read" | "audit.read";

// Full role model from ADR 0005; the MVP enables owner and editor.
export const ENABLED_ROLES: readonly Role[] = ["owner", "editor"];

const grants: Record<Role, readonly Permission[]> = {
  owner: ["account.write", "members.manage", "content.write", "content.read", "audit.read"],
  editor: ["content.write", "content.read", "audit.read"],
  event_manager: ["content.write", "content.read", "audit.read"],
  box_office: ["content.read"],
  door_staff: ["content.read"],
  finance: ["content.read", "audit.read"],
};

export function can(ctx: Pick<ActorContext, "roles">, permission: Permission): boolean {
  return ctx.roles.some((r) => grants[r as Role]?.includes(permission));
}

export function assertCan(ctx: Pick<ActorContext, "roles">, permission: Permission): void {
  if (!can(ctx, permission)) throw new DomainError("forbidden", `Missing permission ${permission}`);
}
