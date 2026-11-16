export type ErrorCode =
  | "not_found"
  | "version_conflict"
  | "forbidden"
  | "validation_failed"
  | "conflict";

const statusFor: Record<ErrorCode, number> = {
  not_found: 404,
  version_conflict: 412,
  forbidden: 403,
  validation_failed: 422,
  conflict: 409,
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
