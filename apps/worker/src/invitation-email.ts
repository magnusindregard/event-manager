import type { Task } from "graphile-worker";
import { type Db, sql, type Tx, withTenant } from "@event-manager/db";
import { integrations, registration } from "@event-manager/domain";
import type { InternalHandler } from "./handlers.js";
import { sendThroughHubSpot } from "./hubspot/send.js";
import type { HubSpotDeps } from "./hubspot/setup.js";
import { isPermanentMailError, type Mail } from "./identity/mailer.js";
import { esc, formatWhen, type RegistrationEmailDeps } from "./registration-email.js";

// Guest invitations and reminders (docs/registration.md, "Email"). Staff ask for a batch;
// the domain logs one send per guest and emits invitation.sends_requested.v1, and this
// queues one job per send. The job checks the guest still needs the email (no answer yet,
// event still published), sends it with Postmark metadata so delivery reports find the send,
// and records it. A send that was sent already is never sent again.
//
// When the event sends through HubSpot (docs/hubspot.md, milestone 5), the job sends the
// event's HubSpot email to the guest instead, and the platform's own email only if HubSpot will
// not take it (a plus address, unsubscribed, refused), with the reason on the send. HubSpot sends
// are spread out at a steady rate, to stay within HubSpot's limits.

/** HubSpot sends queued per second. */
const HUBSPOT_SENDS_PER_SECOND = 5;
/** A send HubSpot is still working on is read again this much later, for at most two days. */
const RECHECK_SECONDS = 600;
const RECHECK_FOR_MS = 2 * 86_400_000;

/** Queues one send's job. Run from inside that job, it queues a fresh one (graphile-worker moves the key off a running job). */
async function queueSend(tx: Tx, tenantId: string, sendId: string, delaySeconds = 0) {
  await sql`select graphile_worker.add_job(
    ${INVITATION_EMAIL_TASK},
    json_build_object('tenantId', ${tenantId}::text, 'sendId', ${sendId}::text),
    run_at := now() + make_interval(secs => ${delaySeconds}),
    job_key := ${`invsend:${sendId}`},
    max_attempts := 8)`.execute(tx);
}

export const INVITATION_EMAIL_TASK = "registration.invitation_email";

export const queueInvitationEmails: InternalHandler = {
  name: "invitation-email",
  types: ["invitation.sends_requested.v1"],
  async handle(tx, event, log) {
    const ids = (event.data as { sendIds?: unknown }).sendIds;
    if (!Array.isArray(ids)) return;
    const eventId = (event.data as { eventId?: unknown }).eventId;
    const spread = typeof eventId === "string" && (await integrations.eventChannel(tx, eventId)) === "hubspot";
    let i = 0;
    for (const id of ids) {
      if (typeof id !== "string") continue;
      const delay = spread ? Math.floor(i++ / HUBSPOT_SENDS_PER_SECOND) : 0;
      await sql`select graphile_worker.add_job(
        ${INVITATION_EMAIL_TASK},
        json_build_object('tenantId', ${event.tenantId}::text, 'sendId', ${id}::text),
        run_at := now() + make_interval(secs => ${delay}),
        job_key := ${`invsend:${id}`},
        max_attempts := 8)`.execute(tx);
    }
    log.info("invitation emails queued", { eventId: (event.data as { eventId?: unknown }).eventId, count: ids.length });
  },
};

/** Pure: the custom properties every HubSpot invitation or reminder carries (docs/hubspot.md, "Template emails"). */
export function invitationProperties(m: registration.InvitationMessage): Record<string, string> {
  const t = m.event.translations[m.locale] ?? m.event.translations[m.account.defaultLocale] ?? Object.values(m.event.translations)[0];
  const nb = m.locale.startsWith("n");
  const one = m.occurrences.length === 1 ? m.occurrences[0]! : null;
  const l = one?.location;
  return {
    invitation_token: m.token,
    event_title: t?.title ?? m.event.slug,
    event_date: one
      ? formatWhen(m.locale, m.event.timezone, one.occurrence.startUtc, one.occurrence.endUtc)
      : m.occurrences.length > 1 ? (nb ? `${m.occurrences.length} tidspunkter å velge mellom` : `${m.occurrences.length} times to choose from`) : "",
    event_place: l ? [l.name, l.venue && l.venue !== l.name ? l.venue : null, l.address].filter(Boolean).join(", ") : "",
    guest_name: m.invitation.name ?? "",
  };
}

/** Pure: subject, text and HTML for an invitation or a reminder of one. */
export function invitationEmail(m: registration.InvitationMessage, url: string): Omit<Mail, "to"> {
  const locale = m.locale;
  const nb = locale.startsWith("n");
  const t = m.event.translations[locale] ?? m.event.translations[m.account.defaultLocale] ?? Object.values(m.event.translations)[0];
  const title = t?.title ?? m.event.slug;
  const name = m.invitation.name;
  const hi = name ? (nb ? `Hei ${name},` : `Hi ${name},`) : nb ? "Hei," : "Hi,";
  const reminder = m.send.kind === "reminder";
  const guest = registration.effectiveGuestAllowed(m.invitation, m.event.registration);
  const occ = m.occurrences;
  const one = occ.length === 1 ? occ[0]! : null;
  const where = (l: (typeof occ)[number]["location"]) =>
    l ? [l.name, l.venue && l.venue !== l.name ? l.venue : null, l.address].filter(Boolean).join(", ") : null;

  const subject = reminder ? (nb ? `Påminnelse: Invitasjon til ${title}` : `Reminder: You're invited to ${title}`) : nb ? `Invitasjon: ${title}` : `You're invited: ${title}`;
  const lead = reminder
    ? nb ? `Vi har ikke fått svar fra deg ennå. ${m.account.name} vil gjerne se deg på ${title}.` : `We haven't heard from you yet. ${m.account.name} would love to see you at ${title}.`
    : nb ? `${m.account.name} inviterer deg til ${title}.` : `${m.account.name} invites you to ${title}.`;
  const details = one
    ? [formatWhen(locale, m.event.timezone, one.occurrence.startUtc, one.occurrence.endUtc), ...(where(one.location) ? [where(one.location)!] : [])]
    : occ.length > 1
      ? [nb ? `Du velger tidspunkt når du svarer (${occ.length} å velge mellom).` : `You choose a time when you answer (${occ.length} to choose from).`]
      : [];
  const guestLine = guest ? (nb ? "Du kan ta med en gjest." : "You may bring a guest.") : null;
  const cta = nb ? "Svar på invitasjonen" : "Reply to the invitation";
  const linkLead = nb ? "Svar her, enten du kommer eller ikke. Lenken er personlig:" : "Reply here, whether you can come or not. The link is personal:";

  const text = [hi, "", lead, "", ...details, ...(guestLine ? ["", guestLine] : []), "", linkLead, url, "", `— ${m.account.name}`].join("\n");
  const html = `<!doctype html><html lang="${esc(locale)}"><body style="margin:0;background:#f4f4f5;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#18181b">
<div style="max-width:560px;margin:0 auto;padding:24px">
<p style="color:#52525b;font-size:14px;margin:0 0 16px">${esc(m.account.name)}</p>
<div style="background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:24px">
<h1 style="font-size:22px;line-height:1.3;margin:0 0 12px">${esc(title)}</h1>
<p style="margin:0 0 12px">${esc(hi)}</p>
<p style="margin:0 0 16px">${esc(lead)}</p>
${details.length ? `<p style="margin:0 0 16px;line-height:1.6">${details.map(esc).join("<br>")}</p>` : ""}
${guestLine ? `<p style="margin:0 0 16px">${esc(guestLine)}</p>` : ""}
<p style="margin:0 0 20px"><a href="${esc(url)}" style="display:inline-block;background:#18181b;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px">${esc(cta)}</a></p>
<p style="margin:0 0 4px;font-size:14px;color:#52525b">${esc(linkLead)}</p>
<p style="margin:0;font-size:14px;word-break:break-all"><a href="${esc(url)}" style="color:#18181b">${esc(url)}</a></p>
</div></div></body></html>`;
  return { subject, text, html };
}

interface Payload {
  tenantId: string;
  sendId: string;
}
const isPayload = (p: unknown): p is Payload =>
  typeof p === "object" && p !== null && typeof (p as Payload).tenantId === "string" && typeof (p as Payload).sendId === "string";

export function invitationEmailTask(db: Db, deps: RegistrationEmailDeps, hubspot: HubSpotDeps | null = null): Task {
  const base = deps.attendeeUrl.replace(/\/+$/, "");
  return async (payload, helpers) => {
    if (!isPayload(payload)) throw new Error(`Invalid ${INVITATION_EMAIL_TASK} payload`);
    const { tenantId, sendId } = payload;
    const loaded = await withTenant(db, { tenantId }, async (tx) => {
      const m = await registration.loadInvitationMessage(tx, tenantId, sendId);
      if (!m || m.send.sentAt) return null;
      // Whether the guest still needs the email decides a new email (the first send, or the
      // platform's fallback), never whether the result of one HubSpot has taken is read.
      // (A send HubSpot refused is the platform's to send, so the usual rules apply to it.)
      if (!registration.shouldSend(m) && !(m.send.providerStatusId && !m.send.providerRefusal)) {
        await registration.recordNotSent(tx, sendId, m.event.status !== "published" ? "event_not_published" : `guest_${m.invitation.status}`);
        return null;
      }
      return { m, channel: await integrations.eventChannel(tx, m.event.id) };
    });
    if (!loaded) {
      helpers.logger.info(`invitation send ${sendId}: not sent (gone, answered or sent already)`);
      return;
    }
    const message = loaded.m;
    const lastAttempt = helpers.job.attempts >= helpers.job.max_attempts;

    // The event sends through HubSpot: try that first.
    let fallbackReason: string | null = null;
    // A send HubSpot took already goes back to HubSpot for its result, whatever the event's
    // channel is now: only HubSpot's answer settles it, and the platform never sends a second email.
    // One HubSpot refused already (an earlier try of the platform's email failed): the platform's, on that answer.
    const refused = message.send.providerRefusal;
    const taken = message.send.providerStatusId && !refused ? { statusId: message.send.providerStatusId, portalId: message.send.providerPortalId } : null;
    if (refused) fallbackReason = refused;
    else if (loaded.channel === "hubspot" || taken) {
      const r = await sendThroughHubSpot(db, tenantId, hubspot, {
        kind: message.send.kind, eventId: message.event.id, email: message.invitation.email, name: message.invitation.name, sendId,
        customProperties: invitationProperties(message), taken, lastAttempt,
        saveStatusId: (statusId, portalId) => withTenant(db, { tenantId }, (tx) => registration.recordProviderStatus(tx, sendId, statusId, portalId)),
      });
      if (r.sent) {
        await withTenant(db, { tenantId }, (tx) => registration.recordSent(tx, tenantId, sendId, null, new Date(), { channel: "hubspot" }));
        helpers.logger.info(`invitation send ${sendId}: ${message.send.kind} sent through HubSpot`);
        return;
      }
      if (r.pending) {
        // Connected to the portal that took it: look again later, for a while. Otherwise (or after
        // that) it is unresolved: staff see it and may send again, and a reconnect of that portal resumes it.
        const recheck = r.recheck && Date.now() - message.send.requestedAt.getTime() < RECHECK_FOR_MS;
        await withTenant(db, { tenantId }, async (tx) => {
          await registration.recordSendUnresolved(tx, sendId, recheck ? r.reason : r.reason.replace(/\. Checked again later$/, ""), !recheck);
          if (recheck) await queueSend(tx, tenantId, sendId, RECHECK_SECONDS);
        });
        helpers.logger.warn(`invitation send ${sendId}: ${recheck ? "checked again later" : "left unresolved"} (${r.reason})`);
        return;
      }
      // HubSpot did not send it. Whether the guest still needs it is read again now, after the
      // call to HubSpot: they may have answered, or the event been unpublished, while it ran.
      const notDue = await withTenant(db, { tenantId }, async (tx) => {
        const fresh = await registration.loadInvitationMessage(tx, tenantId, sendId);
        if (!fresh || fresh.send.sentAt) return "gone";
        if (registration.shouldSend(fresh)) return null;
        const why = fresh.event.status !== "published" ? "event_not_published" : `guest_${fresh.invitation.status}`;
        await registration.recordNotSent(tx, sendId, `${why}: HubSpot did not send it (${r.reason})`);
        return why;
      });
      if (notDue) {
        helpers.logger.info(`invitation send ${sendId}: HubSpot did not send it, and it is no longer due (${notDue}; ${r.reason})`);
        return;
      }
      // Staff were told this one was unresolved and may have sent again: a late refusal is
      // recorded, not followed by the platform's own email.
      if (message.send.providerUnresolved) {
        await withTenant(db, { tenantId }, (tx) => registration.recordNotSent(tx, sendId, `hubspot_refused: ${r.reason}`));
        helpers.logger.info(`invitation send ${sendId}: HubSpot did not send it after all (${r.reason})`);
        return;
      }
      // Kept before the platform's email is tried: a retry of it then needs nothing from HubSpot.
      // (Counts as HubSpot's refusal only on a send HubSpot took, this run or an earlier one.)
      await withTenant(db, { tenantId }, (tx) => registration.recordProviderRefusal(tx, sendId, r.reason));
      fallbackReason = r.reason;
      helpers.logger.info(`invitation send ${sendId}: the platform sends it (${r.reason})`);
    }

    const mail = invitationEmail(message, `${base}/i/${message.token}`);
    let sent;
    try {
      sent = await deps.mailer.send({ to: message.invitation.email, ...mail, metadata: { tenantId, sendId } });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      // Refused for good (invalid recipient, account restriction): mark the send failed now
      // instead of retrying, so the guest list shows it and staff can fix it and send again.
      if (isPermanentMailError(e)) {
        await withTenant(db, { tenantId }, (tx) => registration.recordNotSent(tx, sendId, `mail_rejected: ${detail}`, fallbackReason));
        helpers.logger.error(`invitation send ${sendId}: rejected by the mail service, not retried: ${detail}`);
        return;
      }
      // Out of retries: the same, after the last attempt.
      if (lastAttempt) {
        await withTenant(db, { tenantId }, (tx) => registration.recordNotSent(tx, sendId, `mail_error: ${detail}`, fallbackReason));
      }
      throw e;
    }
    await withTenant(db, { tenantId }, (tx) => registration.recordSent(tx, tenantId, sendId, sent.messageId, new Date(), { channel: "platform", fallbackReason }));
    helpers.logger.info(`invitation send ${sendId}: ${message.send.kind} sent`);
  };
}
