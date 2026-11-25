import type { Task } from "graphile-worker";
import QRCode from "qrcode";
import { type Db, sql, type Tx, withTenant } from "@event-manager/db";
import { integrations, registration } from "@event-manager/domain";
import type { InternalHandler } from "./handlers.js";
import { sendThroughHubSpot } from "./hubspot/send.js";
import type { HubSpotDeps } from "./hubspot/setup.js";
import { sendOrGiveUp } from "./identity/mailer.js";
import { formatWhen, type RegistrationEmailDeps, registrationEmail } from "./registration-email.js";

// Reminder before the event (docs/registration.md, "Closed event", step 6): when the event
// has a reminder set, each confirmed attendee gets one email that many minutes before their
// occurrence starts, with the QR code and a cancel link.
//
// One job per registration, keyed by it and scheduled for the reminder time. Anything that
// can move that time queues it again with the same key, which replaces the scheduled job:
// a new registration, a new time for the occurrence, the event (re)published, or a change
// of the reminder setting. The job checks the time again when it runs, so a stale job just
// reschedules itself or does nothing.
//
// When the event sends through HubSpot (docs/hubspot.md, "When emails go out"), this reminder is
// the welcome: the event's HubSpot welcome email, linking to the manage page with the QR code.
// The platform sends its own when HubSpot will not take it, and records why.

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

/** Pure: the custom properties of the HubSpot welcome. */
export function welcomeProperties(m: registration.RegistrationMessage, manageToken: string): Record<string, string> {
  const e = m.target.event;
  const locale = m.registration.locale;
  const title = e.translations[locale]?.title ?? e.translations[m.account.defaultLocale]?.title ?? Object.values(e.translations)[0]?.title ?? e.slug;
  const l = m.target.location;
  return {
    manage_token: manageToken,
    event_title: title,
    event_date: formatWhen(locale, e.timezone, m.target.occurrence.startUtc, m.target.occurrence.endUtc),
    event_place: l ? [l.name, l.venue && l.venue !== l.name ? l.venue : null, l.address].filter(Boolean).join(", ") : "",
    guest_name: m.registration.name ?? "",
  };
}

export function reminderTask(db: Db, deps: RegistrationEmailDeps, clock: () => Date = () => new Date(), hubspot: HubSpotDeps | null = null): Task {
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
      const [manage, admission, channel, statusId] = await Promise.all([
        registration.manageToken(tx, tenantId, message.registration),
        registration.admissionToken(tx, tenantId, message.registration),
        integrations.eventChannel(tx, message.target.event.id),
        registration.reminderStatusId(tx, registrationId),
      ]);
      return { message, manage, admission, channel, statusId };
    });
    if (!prepared) {
      helpers.logger.info(`registration ${registrationId}: no reminder now`);
      return;
    }
    const mine = await withTenant(db, { tenantId }, (tx) => registration.markReminded(tx, registrationId, now));
    if (!mine) return;
    const release = () => withTenant(db, { tenantId }, (tx) => registration.unmarkReminded(tx, registrationId, now));

    // The event sends through HubSpot: its welcome email first.
    let fallbackReason: string | null = null;
    if (prepared.channel === "hubspot") {
      if (!hubspot) fallbackReason = "HubSpot is not configured on this platform";
      else {
        let r;
        try {
          r = await sendThroughHubSpot(db, tenantId, hubspot, {
            kind: "welcome", eventId: prepared.message.target.event.id, email: prepared.message.registration.email!, name: prepared.message.registration.name,
            sendId: `welcome-${registrationId}`, customProperties: welcomeProperties(prepared.message, prepared.manage), statusId: prepared.statusId,
            lastAttempt: helpers.job.attempts >= helpers.job.max_attempts,
            saveStatusId: (statusId) => withTenant(db, { tenantId }, (tx) => registration.recordReminderStatus(tx, registrationId, statusId)),
          });
        } catch (e) {
          await release();
          throw e;
        }
        if (r.sent) {
          await withTenant(db, { tenantId }, (tx) => registration.recordReminderChannel(tx, registrationId, "hubspot", null));
          helpers.logger.info(`registration ${registrationId}: welcome sent through HubSpot`);
          return;
        }
        if (r.pending) {
          // Neither sent nor refused: released, and a reconnect queues it again.
          await release();
          await withTenant(db, { tenantId }, (tx) => registration.recordReminderChannel(tx, registrationId, null, r.reason));
          helpers.logger.warn(`registration ${registrationId}: welcome left unresolved (${r.reason})`);
          return;
        }
        fallbackReason = r.reason;
      }
    }

    const qrPng = prepared.admission ? (await QRCode.toBuffer(prepared.admission, { type: "png", width: 400, margin: 1, errorCorrectionLevel: "M" })).toString("base64") : null;
    const mail = registrationEmail({ kind: "reminder", message: prepared.message, manageUrl: `${base}/m/${prepared.manage}`, qrPng });
    // Claimed above, so two runs never both send; released again if sending fails, so a retry
    // sends. A permanent rejection is released too, but not retried.
    let sent;
    try {
      sent = await sendOrGiveUp(deps.mailer, { to: prepared.message.registration.email, ...mail }, (l) => helpers.logger.error(l), `registration ${registrationId}: reminder`);
    } catch (e) {
      await release();
      throw e;
    }
    if (!sent) {
      await release();
      return;
    }
    if (prepared.channel === "hubspot") await withTenant(db, { tenantId }, (tx) => registration.recordReminderChannel(tx, registrationId, "platform", fallbackReason));
    helpers.logger.info(`registration ${registrationId}: reminder sent`);
  };
}
