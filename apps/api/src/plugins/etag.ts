import type { FastifyReply, FastifyRequest } from "fastify";
import { HttpProblem } from "./problem.js";

// ETags for optimistic concurrency on admin edits (ADR 0007). The ETag is the row version.

export const etagFor = (version: number) => `"${version}"`;

export function setEtag(reply: FastifyReply, version: number): void {
  reply.header("etag", etagFor(version));
}

/** Reads If-Match as an expected version. Missing → 428, malformed → 400. */
export function expectedVersion(req: FastifyRequest): number {
  const raw = req.headers["if-match"];
  if (!raw) {
    throw new HttpProblem(428, "precondition_required", "If-Match header with the resource ETag is required");
  }
  const m = /^(?:W\/)?"(\d+)"$/.exec(raw.trim());
  if (!m) throw new HttpProblem(400, "invalid_if_match", "If-Match must be an ETag from a previous response");
  return Number(m[1]);
}
