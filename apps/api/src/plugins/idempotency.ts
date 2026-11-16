import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { sql, type Tx } from "@event-manager/db";
import { HttpProblem } from "./problem.js";

// Idempotency-Key for retriable POSTs (ADR 0007). The response is stored per tenant and key
// for 24 hours in the same transaction as the change, so a retry after a lost response
// gets the original result instead of a duplicate.

const TTL = "24 hours";

export interface Stored {
  status: number;
  body: unknown;
  replayed: boolean;
}

export async function idempotent(
  tx: Tx,
  req: FastifyRequest,
  tenantId: string,
  status: number,
  fn: () => Promise<unknown>,
): Promise<Stored> {
  const raw = req.headers["idempotency-key"];
  if (raw === undefined) return { status, body: await fn(), replayed: false };
  if (typeof raw !== "string" || raw.length < 1 || raw.length > 255) {
    throw new HttpProblem(400, "invalid_idempotency_key", "Idempotency-Key must be 1–255 characters");
  }
  const requestHash = createHash("sha256").update(`${req.method} ${req.routeOptions.url}\n${JSON.stringify(req.params)}\n${JSON.stringify(req.body)}`).digest("hex");

  const prior = await tx
    .selectFrom("tenancy.idempotency_key")
    .select(["request_hash", "status_code", "response"])
    .where("key", "=", raw)
    .where("created_at", ">", sql<Date>`now() - ${TTL}::interval`)
    .executeTakeFirst();
  if (prior) {
    if (prior.request_hash !== requestHash) {
      throw new HttpProblem(422, "idempotency_key_reused", "This Idempotency-Key was used for a different request");
    }
    return { status: prior.status_code, body: prior.response, replayed: true };
  }

  const body = await fn();
  // A concurrent request with the same key fails on the primary key and rolls back.
  await tx
    .insertInto("tenancy.idempotency_key")
    .values({ tenant_id: tenantId, key: raw, request_hash: requestHash, status_code: status, response: JSON.stringify(body) })
    .onConflict((oc) =>
      oc.columns(["tenant_id", "key"]).doUpdateSet((eb) => ({
        request_hash: eb.ref("excluded.request_hash"),
        status_code: eb.ref("excluded.status_code"),
        response: eb.ref("excluded.response"),
        created_at: sql<Date>`now()`,
      })).where("tenancy.idempotency_key.created_at", "<=", sql<Date>`now() - ${TTL}::interval`),
    )
    .executeTakeFirst()
    .then((r) => {
      if (!r.numInsertedOrUpdatedRows) throw new HttpProblem(409, "idempotency_key_in_use", "A request with this Idempotency-Key is in progress");
    });
  return { status, body, replayed: false };
}
