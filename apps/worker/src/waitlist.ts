import type { Task } from "graphile-worker";
import { type Db, sql, withTenant } from "@event-manager/db";
import { registration } from "@event-manager/domain";
import type { InternalHandler } from "./handlers.js";

// Waitlist (docs/registration.md, milestone 5). Places freed by attendees and staff are offered
// in the same transaction that frees them. Two things happen later, here:
//   - an offer's deadline: one job per offer, keyed by the registration and scheduled for the
//     deadline, ends it if it is still unclaimed and offers the places to the next in line;
//   - more capacity (capacity.changed with a higher limit): the line is promoted.
// Promotion also ends any overdue offers it finds, so a late or lost job is caught up the next
// time places move on that occurrence.

export const OFFER_EXPIRY_TASK = "registration.offer-expiry";

export const queueWaitlistWork: InternalHandler = {
  name: "waitlist",
  types: ["registration.offered.v1", "capacity.changed.v1"],
  async handle(tx, event, log) {
    if (event.type === "registration.offered.v1") {
      const d = event.data as { registrationId?: unknown; expiresAt?: unknown };
      if (typeof d.registrationId !== "string" || typeof d.expiresAt !== "string") return;
      await sql`select graphile_worker.add_job(
        ${OFFER_EXPIRY_TASK},
        json_build_object('tenantId', ${event.tenantId}::text, 'registrationId', ${d.registrationId}::text),
        job_key := ${`offer:${d.registrationId}`},
        run_at := ${new Date(d.expiresAt)},
        max_attempts := 10)`.execute(tx);
      log.info("offer expiry queued", { registrationId: d.registrationId, expiresAt: d.expiresAt });
      return;
    }
    const d = event.data as { occurrenceId?: unknown; bookableLimit?: unknown; previousBookableLimit?: unknown };
    if (typeof d.occurrenceId !== "string") return;
    const now = d.bookableLimit, before = d.previousBookableLimit;
    const grew = now === null ? before !== null : typeof now === "number" && typeof before === "number" && now > before;
    if (!grew) return;
    const p = await registration.promoteWaitlist(tx, event.tenantId, d.occurrenceId);
    if (p.offered.length || p.expired.length) log.info("waitlist promoted", { occurrenceId: d.occurrenceId, offered: p.offered.length, expired: p.expired.length });
  },
};

interface Payload {
  tenantId: string;
  registrationId: string;
}
const isPayload = (p: unknown): p is Payload =>
  typeof p === "object" && p !== null && typeof (p as Payload).tenantId === "string" && typeof (p as Payload).registrationId === "string";

export function offerExpiryTask(db: Db, clock: () => Date = () => new Date()): Task {
  return async (payload, helpers) => {
    if (!isPayload(payload)) throw new Error(`Invalid ${OFFER_EXPIRY_TASK} payload`);
    const { tenantId, registrationId } = payload;
    await withTenant(db, { tenantId }, async (tx) => {
      const again = await registration.expireOffer(tx, tenantId, registrationId, clock());
      // Ran early (the queue may run a job a little ahead of time): try again at the deadline.
      if (again) {
        await sql`select graphile_worker.add_job(${OFFER_EXPIRY_TASK},
          json_build_object('tenantId', ${tenantId}::text, 'registrationId', ${registrationId}::text),
          job_key := ${`offer:${registrationId}`}, run_at := ${again}, max_attempts := 10)`.execute(tx);
      }
    });
    helpers.logger.info(`registration ${registrationId}: offer expiry checked`);
  };
}
