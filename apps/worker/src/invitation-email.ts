import type { Task } from "graphile-worker";
import { type Db, sql, withTenant } from "@event-manager/db";
import { registration } from "@event-manager/domain";
import type { InternalHandler } from "./handlers.js";
import type { Mail } from "./identity/mailer.js";
import { esc, formatWhen, type RegistrationEmailDeps } from "./registration-email.js";

// Guest invitations and reminders (docs/registration.md, "Email"). Staff ask for a batch;
// the domain logs one send per guest and emits invitation.sends_requested.v1, and this
// queues one job per send. The job checks the guest still needs the email (no answer yet,
// event still published), sends it with Postmark metadata so delivery reports find the send,
// and records it. A send that was sent already is never sent again.

export const INVITATION_EMAIL_TASK = "registration.invitation_email";

export const queueInvitationEmails: InternalHandler = {
  name: "invitation-email",
  types: ["invitation.sends_requested.v1"],
  async handle(tx, event, log) {
    const ids = (event.data as { sendIds?: unknown }).sendIds;
    if (!Array.isArray(ids)) return;
    for (const id of ids) {
      if (typeof id !== "string") continue;
      await sql`select graphile_worker.add_job(
        ${INVITATION_EMAIL_TASK},
        json_build_object('tenantId', ${event.tenantId}::text, 'sendId', ${id}::text),
        job_key := ${`invsend:${id}`},
        max_attempts := 8)`.execute(tx);
    }
    log.info("invitation emails queued", { eventId: (event.data as { eventId?: unknown }).eventId, count: ids.length });
  },
};

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

export function invitationEmailTask(db: Db, deps: RegistrationEmailDeps): Task {
  const base = deps.attendeeUrl.replace(/\/+$/, "");
  return async (payload, helpers) => {
    if (!isPayload(payload)) throw new Error(`Invalid ${INVITATION_EMAIL_TASK} payload`);
    const { tenantId, sendId } = payload;
    const message = await withTenant(db, { tenantId }, async (tx) => {
      const m = await registration.loadInvitationMessage(tx, tenantId, sendId);
      if (!m) return null;
      if (!registration.shouldSend(m)) {
        if (!m.send.sentAt) await registration.recordNotSent(tx, sendId, m.event.status !== "published" ? "event_not_published" : `guest_${m.invitation.status}`);
        return null;
      }
      return m;
    });
    if (!message) {
      helpers.logger.info(`invitation send ${sendId}: not sent (gone, answered or sent already)`);
      return;
    }
    const mail = invitationEmail(message, `${base}/i/${message.token}`);
    let sent;
    try {
      sent = await deps.mailer.send({ to: message.invitation.email, ...mail, metadata: { tenantId, sendId } });
    } catch (e) {
      // Out of retries: mark the send failed, so the guest list shows it and staff can send again.
      if (helpers.job.attempts >= helpers.job.max_attempts) {
        await withTenant(db, { tenantId }, (tx) => registration.recordNotSent(tx, sendId, `mail_error: ${e instanceof Error ? e.message : String(e)}`));
      }
      throw e;
    }
    await withTenant(db, { tenantId }, (tx) => registration.recordSent(tx, tenantId, sendId, sent.messageId));
    helpers.logger.info(`invitation send ${sendId}: ${message.send.kind} sent`);
  };
}
