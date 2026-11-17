import type { Task } from "graphile-worker";
import QRCode from "qrcode";
import { type Db, sql, type Tx, withTenant } from "@event-manager/db";
import { registration } from "@event-manager/domain";
import type { InternalHandler } from "./handlers.js";
import { type RegistrationEmailDeps, registrationEmail } from "./registration-email.js";

// Reminder before the event (docs/registration.md, "Closed event", step 6): when the event
// has a reminder set, each confirmed attendee gets one email that many minutes before their
// occurrence starts, with the QR code and a cancel link.
//
// One job per registration, keyed by it and scheduled for the reminder time. Anything that
// can move that time queues it again with the same key, which replaces the scheduled job:
// a new registration, a new time for the occurrence, the event (re)published, or a change
// of the reminder setting. The job checks the time again when it runs, so a stale job just
// reschedules itself or does nothing.

export const REMINDER_TASK = "registration.reminder";
// Jobs that run up to this early still send (the queue may run them a little ahead of time).
const EARLY_MS = 60_000;
const TIME_FIELDS = ["startUtc", "endUtc", "reattached"];

async function enqueue(tx: Tx, tenantId: string, plans: { id: string; runAt: Date }[]) {
  for (const p of plans) {
    await sql`select graphile_worker.add_job(
      ${REMINDER_TASK},
      json_build_object('tenantId', ${tenantId}::text, 'registrationId', ${p.id}::text),
      job_key := ${`reminder:${p.id}`},
      run_at := ${p.runAt},
      max_attempts := 10)`.execute(tx);
  }
}

export const queueReminders: InternalHandler = {
  name: "reminders",
  types: ["registration.confirmed.v1", "occurrence.changed.v1", "event.changed.v1", "event.published.v1"],
  async handle(tx, event, log) {
    const data = event.data as { registrationId?: unknown; id?: unknown; changed?: unknown };
    let ids: string[] = [];
    if (event.type === "registration.confirmed.v1") {
      if (typeof data.registrationId === "string") ids = [data.registrationId];
    } else if (event.type === "occurrence.changed.v1") {
      if (typeof data.id === "string" && Array.isArray(data.changed) && data.changed.some((c) => TIME_FIELDS.includes(c))) {
        ids = await registration.activeRegistrationIds(tx, [data.id]);
      }
    } else if (typeof data.id === "string") {
      // event.changed.v1 only when the reminder setting changed; event.published.v1 always.
      const relevant = event.type === "event.published.v1" || (Array.isArray(data.changed) && data.changed.includes("registration.reminderMinBefore"));
      if (relevant) ids = await registration.unremindedRegistrationIds(tx, data.id);
    }
    const plans = await registration.reminderTimes(tx, ids);
    await enqueue(tx, event.tenantId, plans);
    if (plans.length) log.info("reminders queued", { cause: event.type, subject: event.subject, count: plans.length });
  },
};

interface Payload {
  tenantId: string;
  registrationId: string;
}
const isPayload = (p: unknown): p is Payload =>
  typeof p === "object" && p !== null && typeof (p as Payload).tenantId === "string" && typeof (p as Payload).registrationId === "string";

export function reminderTask(db: Db, deps: RegistrationEmailDeps, clock: () => Date = () => new Date()): Task {
  const base = deps.attendeeUrl.replace(/\/+$/, "");
  return async (payload, helpers) => {
    if (!isPayload(payload)) throw new Error(`Invalid ${REMINDER_TASK} payload`);
    const { tenantId, registrationId } = payload;
    const now = clock();
    const prepared = await withTenant(db, { tenantId }, async (tx) => {
      const message = await registration.loadMessage(tx, registrationId);
      if (!message) return null;
      const at = registration.reminderTime(message.registration, message.target, now);
      if (!at) return null;
      if (at.getTime() - now.getTime() > EARLY_MS) {
        // The occurrence moved later, or the setting changed: try again at the new time.
        await enqueue(tx, tenantId, [{ id: registrationId, runAt: at }]);
        return null;
      }
      const [manage, admission] = await Promise.all([
        registration.manageToken(tx, tenantId, message.registration),
        registration.admissionToken(tx, tenantId, message.registration),
      ]);
      return { message, manage, admission };
    });
    if (!prepared) {
      helpers.logger.info(`registration ${registrationId}: no reminder now`);
      return;
    }
    const qrPng = prepared.admission ? (await QRCode.toBuffer(prepared.admission, { type: "png", width: 400, margin: 1, errorCorrectionLevel: "M" })).toString("base64") : null;
    const mail = registrationEmail({ kind: "reminder", message: prepared.message, manageUrl: `${base}/m/${prepared.manage}`, qrPng });
    // Claimed first, so two runs never both send; released again if sending fails, so the retry sends.
    const mine = await withTenant(db, { tenantId }, (tx) => registration.markReminded(tx, registrationId, now));
    if (!mine) return;
    try {
      await deps.mailer.send({ to: prepared.message.registration.email, ...mail });
    } catch (e) {
      await withTenant(db, { tenantId }, (tx) => registration.unmarkReminded(tx, registrationId, now));
      throw e;
    }
    helpers.logger.info(`registration ${registrationId}: reminder sent`);
  };
}
