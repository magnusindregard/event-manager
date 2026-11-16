import type { FastifyError, FastifyInstance, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import { DomainError } from "@event-manager/domain";
import { AuthError } from "../auth.js";

const TYPE_BASE = "https://docs.event-manager.dev/problems/";

/** HTTP-level problem (missing header, precondition required) with a stable code. */
export class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function sendProblem(
  reply: FastifyReply,
  status: number,
  code: string,
  title: string,
  extra: Record<string, unknown> = {},
) {
  return reply
    .status(status)
    .type("application/problem+json")
    .send({ type: `${TYPE_BASE}${code}`, title, status, code, instance: reply.request.url, ...extra });
}

/** RFC 9457 problem details with stable reason codes for every error (ADR 0007). */
export const problemPlugin = fp(async (app: FastifyInstance) => {
  app.setNotFoundHandler((req, reply) => sendProblem(reply, 404, "route_not_found", `No route ${req.method} ${req.url}`));

  app.setErrorHandler((err: FastifyError | DomainError | HttpProblem | AuthError, req, reply) => {
    if (err instanceof DomainError) {
      return sendProblem(reply, err.status, err.code, err.message, err.details ? { details: err.details } : {});
    }
    if (err instanceof HttpProblem) {
      return sendProblem(reply, err.status, err.code, err.message);
    }
    if (err instanceof AuthError) {
      return sendProblem(reply, 401, "unauthenticated", "Authentication required", { detail: err.message });
    }
    if (!("validation" in err) && !("statusCode" in err)) {
      req.log.error({ err }, "unhandled error");
      return sendProblem(reply, 500, "internal_error", "Internal server error");
    }
    if (err.validation) {
      return sendProblem(reply, 400, "invalid_request", "Request validation failed", {
        errors: err.validation.map((v) => ({ path: `${err.validationContext ?? ""}${v.instancePath}`, message: v.message ?? "invalid" })),
      });
    }
    if (err.statusCode && err.statusCode < 500) {
      return sendProblem(reply, err.statusCode, err.code?.toLowerCase() ?? "bad_request", err.message);
    }
    req.log.error({ err }, "unhandled error");
    return sendProblem(reply, 500, "internal_error", "Internal server error");
  });
});
