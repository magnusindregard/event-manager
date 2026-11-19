import type { Task } from "graphile-worker";
import QRCode from "qrcode";
import { type Db, sql, type Tx, withTenant } from "@event-manager/db";
import { catalog, registration } from "@event-manager/domain";
import type { InternalHandler } from "./handlers.js";
import { sendOrGiveUp } from "./identity/mailer.js";
import { type RegistrationEmailDeps, registrationEmail } from "./registration-email.js";

// Notices to attendees when their occurrence moves, is cancelled or is restored
// (docs/registration.md, "Changes to occurrences with registrations").
// - Moved: time changed (occurrence.changed.v1 with startUtc, endUtc or reattached), place
//   changed (occurrence.relocated.v1 from the resolver, whatever caused it), or the address or
//   name of the location they show changed (location.changed.v1).
// - Cancelled: the occurrence or the whole event.
// - Restored: a cancelled occurrence set back to scheduled (occurrence.changed.v1 with status),
//   or a cancelled event published again (event.published.v1 from cancelled). A first publish
//   says nothing.
//
// One job per registration with a job key and a short delay: several changes in a row, such
// as a new time and a new place in one edit, or a correction right after a mistake, coalesce
// into one email that shows the occurrence as it is when the job runs. The job carries why it
// was queued, so a cancellation withdrawn before its email went out sends nothing at all.

export const OCCURRENCE_NOTICE_TASK = "registration.occurrence_notice";
const DEBOUNCE_SECONDS = 60;
const TIME_FIELDS = ["startUtc", "endUtc", "reattached"];
/** Location fields an attendee sees in the notice (name, venue, address). */
const SHOWN_LOCATION_FIELDS = ["name", "address", "parentId"];

type Reason = "changed" | "cancelled" | "restored";
/** changed: the occurrence also moved before a cancellation that is still waiting to be sent. */
type Pending = { reason: Reason; changed?: boolean };

/**
 * What a waiting job should say after another change, or null to drop it: the attendee last
 * heard of the state before the waiting job, so a cancellation and its restoration cancel out.
 * alsoChanged: the same edit also moved the occurrence (a restoration or cancellation with a new
 * time), which attendees must hear about even when the status change itself cancels out.
 */
export function mergeNotice(prev: Pending | null, next: Reason, alsoChanged = false): Pending | null {
  if (next === "cancelled") {
    const changed = alsoChanged || (!!prev && (prev.reason === "changed" || !!prev.changed));
    if (prev?.reason === "restored" && !changed) return null; // they were told it is cancelled; it is again
    return changed ? { reason: "cancelled", changed: true } : { reason: "cancelled" };
  }
  if (next === "restored") {
    if (prev?.reason === "cancelled") return prev.changed || alsoChanged ? { reason: "changed" } : null;
    return { reason: "restored" }; // the notice shows the current details, a new time included
  }
  if (!prev) return { reason: "changed" };
  return prev.reason === "changed" ? prev : { ...prev, changed: true };
}

async function enqueue(tx: Tx, tenantId: string, registrationIds: readonly string[], reason: Reason, alsoChanged: boolean) {
  for (const id of registrationIds) {
    const key = `occnotice:${id}`;
    // A job already running is not merged into: it has read or sent its state.
    const waiting = await sql<{ payload: Pending }>`
      select payload from graphile_worker._private_jobs where key = ${key} and locked_at is null`.execute(tx);
    const p = waiting.rows[0]?.payload;
    const merged = mergeNotice(p && typeof p.reason === "string" ? { reason: p.reason, changed: p.changed } : p ? { reason: "changed" } : null, reason, alsoChanged);
    if (!merged) {
      await sql`select graphile_worker.remove_job(${key})`.execute(tx);
      continue;
    }
    await sql`select graphile_worker.add_job(
      ${OCCURRENCE_NOTICE_TASK},
      json_build_object('tenantId', ${tenantId}::text, 'registrationId', ${id}::text, 'reason', ${merged.reason}::text, 'changed', ${merged.changed ?? false}::boolean),
      job_key := ${key},
      run_at := now() + make_interval(secs => ${DEBOUNCE_SECONDS}),
      max_attempts := 10)`.execute(tx);
  }
}

/** Which occurrences an outbox event concerns, and why; null when attendees need not hear of it. */
async function affected(tx: Tx, type: string, data: { id: string; changed?: unknown; previousStatus?: unknown; change?: unknown }) {
  const changed = Array.isArray(data.changed) ? (data.changed as unknown[]) : [];
  const moved = changed.some((c) => TIME_FIELDS.includes(c as string));
  switch (type) {
    case "occurrence.cancelled.v1":
      return { reason: "cancelled" as const, occurrenceIds: [data.id], alsoChanged: moved };
    case "event.cancelled.v1":
      return { reason: "cancelled" as const, occurrenceIds: await catalog.unendedOccurrenceIds(tx, data.id) };
    case "occurrence.changed.v1":
      // Cancelling emits occurrence.cancelled.v1, so a status change here is a restoration.
      // The same edit can also give it a new time, which must not be lost if the restoration
      // cancels out a cancellation notice that has not been sent.
      if (changed.includes("status")) return { reason: "restored" as const, occurrenceIds: [data.id], alsoChanged: moved };
      if (moved) return { reason: "changed" as const, occurrenceIds: [data.id] };
      return null;
    case "occurrence.relocated.v1":
      return { reason: "changed" as const, occurrenceIds: [data.id] };
    case "event.published.v1":
      if (data.previousStatus !== "cancelled") return null;
      return { reason: "restored" as const, occurrenceIds: await catalog.unendedOccurrenceIds(tx, data.id, { scheduledOnly: true }) };
    case "location.changed.v1":
      if (data.change !== "updated" || !changed.some((c) => SHOWN_LOCATION_FIELDS.includes(c as string))) return null;
      return { reason: "changed" as const, occurrenceIds: await catalog.unendedOccurrenceIdsAt(tx, data.id) };
    default:
      return null;
  }
}

export const queueOccurrenceNotices: InternalHandler = {
  name: "occurrence-notices",
  types: ["occurrence.changed.v1", "occurrence.relocated.v1", "occurrence.cancelled.v1", "event.cancelled.v1", "event.published.v1", "location.changed.v1"],
  async handle(tx, event, log) {
    const data = event.data as { id?: unknown; changed?: unknown; previousStatus?: unknown; change?: unknown };
    if (typeof data.id !== "string") return;
    const a = await affected(tx, event.type, { ...data, id: data.id });
    if (!a) return;
    const ids = await registration.activeRegistrationIds(tx, a.occurrenceIds);
    await enqueue(tx, event.tenantId, ids, a.reason, "alsoChanged" in a && !!a.alsoChanged);
    if (ids.length) log.info("occurrence notices queued", { cause: event.type, subject: event.subject, reason: a.reason, registrations: ids.length });
  },
};

interface Payload {
  tenantId: string;
  registrationId: string;
  /** Missing in jobs queued before restorations were told: treated as "changed". */
  reason?: Reason;
  changed?: boolean;
}
const isPayload = (p: unknown): p is Payload =>
  typeof p === "object" && p !== null && typeof (p as Payload).tenantId === "string" && typeof (p as Payload).registrationId === "string";

export function occurrenceNoticeTask(db: Db, deps: RegistrationEmailDeps): Task {
  const base = deps.attendeeUrl.replace(/\/+$/, "");
  return async (payload, helpers) => {
    if (!isPayload(payload)) throw new Error(`Invalid ${OCCURRENCE_NOTICE_TASK} payload`);
    const now = new Date();
    const prepared = await withTenant(db, { tenantId: payload.tenantId }, async (tx) => {
      const message = await registration.loadMessage(tx, payload.registrationId);
      // Cancelled by the attendee meanwhile, or the occurrence is over: nothing to say.
      if (!message || message.registration.status !== "confirmed" || message.target.occurrence.endUtc <= now) return null;
      const cancelled = message.target.occurrence.status === "cancelled" || message.target.event.status === "cancelled";
      const reason = payload.reason ?? "changed";
      // The state the attendee hears is the state now; the reason only picks the wording.
      const kind = cancelled
        ? reason === "restored" ? null : ("occurrenceCancelled" as const) // restored, then cancelled again: that job replaced this one
        : reason === "restored" ? ("restored" as const)
        : reason === "cancelled" && !payload.changed ? null // cancellation withdrawn; nothing else changed
        : ("moved" as const);
      if (!kind) return null;
      const [manage, admission] = await Promise.all([
        registration.manageToken(tx, payload.tenantId, message.registration),
        cancelled ? Promise.resolve(null) : registration.admissionToken(tx, payload.tenantId, message.registration),
      ]);
      return { message, manage, admission, kind };
    });
    if (!prepared) {
      helpers.logger.info(`registration ${payload.registrationId}: no occurrence notice (cancelled, over or nothing to say)`);
      return;
    }
    const qrPng = prepared.admission ? (await QRCode.toBuffer(prepared.admission, { type: "png", width: 400, margin: 1, errorCorrectionLevel: "M" })).toString("base64") : null;
    const mail = registrationEmail({ kind: prepared.kind, message: prepared.message, manageUrl: `${base}/m/${prepared.manage}`, qrPng });
    const what = `registration ${payload.registrationId}: ${prepared.kind} notice`;
    if (!(await sendOrGiveUp(deps.mailer, { to: prepared.message.registration.email, ...mail }, (l) => helpers.logger.error(l), what))) return;
    helpers.logger.info(`${what} sent`);
  };
}
