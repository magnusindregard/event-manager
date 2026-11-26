export type ErrorCode =
  | "not_found"
  | "version_conflict"
  | "forbidden"
  | "validation_failed"
  | "conflict"
  // Registration (docs/registration.md); stable codes the attendee pages translate.
  | "registration_closed"
  | "full"
  | "already_registered"
  | "invitation_required"
  // Waitlist: the offer was not claimed in time, or there is none to claim.
  | "offer_expired"
  | "no_offer"
  // Reservations (docs/ticketing.md, "Reservations API"); stable codes for sales channels.
  | "sold_out"
  | "not_on_sale"
  | "offer_unavailable"
  | "channel_not_allowed"
  | "no_sku"
  | "quantity_out_of_range"
  | "expired"
  | "extend_limit"
  | "expired_sold_out"
  | "already_cancelled"
  | "already_confirmed"
  | "schedule_changed"
  | "occurrence_started"
  // User groups (docs/user-groups.md).
  | "unknown_group"
  | "group_required"
  | "group_not_allowed";

const statusFor: Record<ErrorCode, number> = {
  not_found: 404,
  version_conflict: 412,
  forbidden: 403,
  validation_failed: 422,
  conflict: 409,
  registration_closed: 409,
  full: 409,
  already_registered: 409,
  invitation_required: 403,
  offer_expired: 409,
  no_offer: 409,
  sold_out: 409,
  not_on_sale: 409,
  offer_unavailable: 409,
  channel_not_allowed: 403,
  no_sku: 409,
  quantity_out_of_range: 422,
  expired: 409,
  extend_limit: 409,
  expired_sold_out: 409,
  already_cancelled: 409,
  occurrence_started: 409,
  already_confirmed: 409,
  schedule_changed: 409,
  unknown_group: 422,
  group_required: 403,
  group_not_allowed: 403,
};

/** Domain errors carry a stable reason code that the API maps to RFC 9457 problem details. */
export class DomainError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DomainError";
    this.status = statusFor[code];
  }
}

/** Who is acting. Staff have a userId; integrations (later) have a clientId. */
export interface ActorContext {
  tenantId: string;
  userId: string | null;
  clientId: string | null;
  roles: readonly string[];
}

export { configureMasterKeys, decryptJson, encryptJson, type MasterKeys, parseMasterKeys, rewrapDataKey } from "./secrets.js";
