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
  | "no_offer";

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
