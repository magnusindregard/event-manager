import type { Task } from "graphile-worker";
import QRCode from "qrcode";
import { type Db, sql, type Tx, withTenant } from "@event-manager/db";
import { catalog, registration } from "@event-manager/domain";
import type { InternalHandler } from "./handlers.js";
import { type RegistrationEmailDeps, registrationEmail } from "./registration-email.js";

// Notices to attendees when their occurrence moves or is cancelled (docs/registration.md,
// "Changes to occurrences with registrations"). Moved: time changed (occurrence.changed.v1
// with startUtc, endUtc or reattached) or place changed (occurrence.relocated.v1 from the
// resolver, whatever caused it). Cancelled: the occurrence or the whole event.
//
// One job per registration with a job key and a short delay: several changes in a row, such
// as a new time and a new place in one edit, or a correction right after a mistake, coalesce
// into one email that shows the occurrence as it is when the job runs.

export const OCCURRENCE_NOTICE_TASK = "registration.occurrence_notice";
const DEBOUNCE_SECONDS = 60;
const TIME_FIELDS = ["startUtc", "endUtc", "reattached"];

async function enqueue(tx: Tx, tenantId: string, registrationIds: readonly string[]) {
  for (const id of registrationIds) {
    await sql`select graphile_worker.add_job(
      ${OCCURRENCE_NOTICE_TASK},
      json_build_object('tenantId', ${tenantId}::text, 'registrationId', ${id}::text),
      job_key := ${`occnotice:${id}`},
      run_at := now() + make_interval(secs => ${DEBOUNCE_SECONDS}),
      max_attempts := 10)`.execute(tx);
  }
}

export const queueOccurrenceNotices: InternalHandler = {
  name: "occurrence-notices",
  types: ["occurrence.changed.v1", "occurrence.relocated.v1", "occurrence.cancelled.v1", "event.cancelled.v1"],
  async handle(tx, event, log) {
    const data = event.data as { id?: unknown; changed?: unknown };
    if (typeof data.id !== "string") return;
    if (event.type === "occurrence.changed.v1" && !(Array.isArray(data.changed) && data.changed.some((c) => TIME_FIELDS.includes(c)))) return;
    const occurrenceIds = event.type === "event.cancelled.v1" ? await catalog.upcomingOccurrenceIds(tx, data.id) : [data.id];
    const ids = await registration.activeRegistrationIds(tx, occurrenceIds);
    await enqueue(tx, event.tenantId, ids);
    if (ids.length) log.info("occurrence notices queued", { cause: event.type, subject: event.subject, registrations: ids.length });
  },
};

interface Payload {
  tenantId: string;
  registrationId: string;
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
      const [manage, admission] = await Promise.all([
        registration.manageToken(tx, payload.tenantId, message.registration),
        cancelled ? Promise.resolve(null) : registration.admissionToken(tx, payload.tenantId, message.registration),
      ]);
      return { message, manage, admission, kind: cancelled ? ("occurrenceCancelled" as const) : ("moved" as const) };
    });
    if (!prepared) {
      helpers.logger.info(`registration ${payload.registrationId}: no occurrence notice (cancelled or over)`);
      return;
    }
    const qrPng = prepared.admission ? (await QRCode.toBuffer(prepared.admission, { type: "png", width: 400, margin: 1, errorCorrectionLevel: "M" })).toString("base64") : null;
    const mail = registrationEmail({ kind: prepared.kind, message: prepared.message, manageUrl: `${base}/m/${prepared.manage}`, qrPng });
    await deps.mailer.send({ to: prepared.message.registration.email, ...mail });
    helpers.logger.info(`registration ${payload.registrationId}: ${prepared.kind} notice sent`);
  };
}
