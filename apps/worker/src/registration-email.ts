import type { Task } from "graphile-worker";
import QRCode from "qrcode";
import { type Db, sql, withTenant } from "@event-manager/db";
import { registration } from "@event-manager/domain";
import type { InternalHandler } from "./handlers.js";
import type { Mail, Mailer } from "./identity/mailer.js";

// Registration emails (docs/registration.md, "Email"): confirmation with the QR code,
// change confirmation and cancellation confirmation, in the attendee's locale. One job per
// outbox event; the job key makes a redelivered event send once. The email always shows the
// registration as it is when the job runs, so a quick change and cancel do not send stale
// details. The account's own template (logo and colours) comes with account email settings.

export const REGISTRATION_EMAIL_TASK = "registration.email";

export interface RegistrationEmailDeps {
  mailer: Mailer;
  /** Base URL of the hosted attendee pages, e.g. https://attend.example.com */
  attendeeUrl: string;
}

export type EmailKind = "confirmed" | "changed" | "cancelled";
/** Notices about the occurrence itself, and the reminder before it (reminder.ts). */
export type NoticeKind = "moved" | "occurrenceCancelled" | "restored" | "reminder";
const KINDS: Record<string, EmailKind> = {
  "registration.confirmed.v1": "confirmed",
  "registration.changed.v1": "changed",
  "registration.cancelled.v1": "cancelled",
};

export const queueRegistrationEmail: InternalHandler = {
  name: "registration-email",
  types: Object.keys(KINDS),
  async handle(tx, event, log) {
    const id = (event.data as { registrationId?: unknown }).registrationId;
    const kind = KINDS[event.type];
    if (typeof id !== "string" || !kind) return;
    // A change of locale only is not worth an email.
    const changed = (event.data as { changed?: unknown }).changed;
    if (kind === "changed" && Array.isArray(changed) && changed.every((c) => c === "locale")) return;
    await sql`select graphile_worker.add_job(
      ${REGISTRATION_EMAIL_TASK},
      json_build_object('tenantId', ${event.tenantId}::text, 'registrationId', ${id}::text, 'kind', ${kind}::text),
      job_key := ${`regmail:${event.id}`},
      max_attempts := 10)`.execute(tx);
    log.info("registration email queued", { registrationId: id, kind });
  },
};

interface Payload {
  tenantId: string;
  registrationId: string;
  kind: EmailKind;
}
const isPayload = (p: unknown): p is Payload =>
  typeof p === "object" && p !== null && typeof (p as Payload).tenantId === "string" && typeof (p as Payload).registrationId === "string" &&
  ["confirmed", "changed", "cancelled"].includes((p as Payload).kind);

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ESC[c]!);

export function formatWhen(locale: string, timezone: string, start: Date, end: Date): string {
  const lang = locale.startsWith("n") ? "nb-NO" : locale;
  const date = new Intl.DateTimeFormat(lang, { timeZone: timezone, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(start);
  const time = (d: Date) => new Intl.DateTimeFormat(lang, { timeZone: timezone, hour: "2-digit", minute: "2-digit" }).format(d);
  return `${date}, ${time(start)}–${time(end)}`;
}

export interface EmailInput {
  kind: EmailKind | NoticeKind;
  message: registration.RegistrationMessage;
  manageUrl: string;
  /** PNG of the admission QR code, base64; null when there is none (cancelled). */
  qrPng: string | null;
}

/** Pure: subject, text and HTML for one registration email. */
export function registrationEmail(i: EmailInput): Omit<Mail, "to"> {
  const { registration: reg, target, account } = i.message;
  const locale = reg.locale;
  const nb = locale.startsWith("n");
  const t = target.event.translations[locale] ?? target.event.translations[account.defaultLocale] ?? Object.values(target.event.translations)[0];
  const title = t?.title ?? target.event.slug;
  const when = formatWhen(locale, target.event.timezone, target.occurrence.startUtc, target.occurrence.endUtc);
  const where = target.location ? [target.location.name, target.location.venue && target.location.venue !== target.location.name ? target.location.venue : null, target.location.address].filter(Boolean).join(", ") : null;
  const party = nb ? (reg.partySize === 1 ? "1 person" : `${reg.partySize} personer`) : reg.partySize === 1 ? "1 person" : `${reg.partySize} people`;

  const copy = {
    confirmed: {
      subject: nb ? `Påmeldt: ${title}` : `Registered: ${title}`,
      lead: nb ? `Hei ${reg.name}, du er påmeldt ${title}.` : `Hi ${reg.name}, you are registered for ${title}.`,
      qr: nb ? "Vis QR-koden i døren." : "Show the QR code at the door.",
      link: nb ? "Se, endre eller avbestill påmeldingen:" : "See, change or cancel your registration:",
    },
    changed: {
      subject: nb ? `Endret påmelding: ${title}` : `Registration changed: ${title}`,
      lead: nb ? `Hei ${reg.name}, påmeldingen din til ${title} er endret.` : `Hi ${reg.name}, your registration for ${title} has been changed.`,
      qr: nb ? "QR-koden gjelder fortsatt. Vis den i døren." : "Your QR code still applies. Show it at the door.",
      link: nb ? "Se, endre eller avbestill påmeldingen:" : "See, change or cancel your registration:",
    },
    moved: {
      subject: nb ? `Ny tid eller nytt sted: ${title}` : `New time or place: ${title}`,
      lead: nb ? `Hei ${reg.name}, ${title} har fått ny tid eller nytt sted. Du er fortsatt påmeldt. Her er de nye detaljene:` : `Hi ${reg.name}, ${title} has a new time or place. You are still registered. Here are the new details:`,
      qr: nb ? "QR-koden gjelder fortsatt. Vis den i døren." : "Your QR code still applies. Show it at the door.",
      link: nb ? "Passer det ikke lenger? Avbestill eller se påmeldingen her:" : "No longer suits you? Cancel or see your registration here:",
    },
    restored: {
      subject: nb ? `Blir likevel ikke avlyst: ${title}` : `Going ahead after all: ${title}`,
      lead: nb
        ? `Hei ${reg.name}, ${title} blir likevel ikke avlyst. Du er fortsatt påmeldt. Her er detaljene:`
        : `Hi ${reg.name}, ${title} is going ahead after all. You are still registered. Here are the details:`,
      qr: nb ? "QR-koden gjelder fortsatt. Vis den i døren." : "Your QR code still applies. Show it at the door.",
      link: nb ? "Kan du ikke komme? Avbestill her, så får noen andre plassen:" : "Can't make it? Cancel here so someone else can have your place:",
    },
    reminder: {
      subject: nb ? `Påminnelse: ${title}` : `Reminder: ${title}`,
      lead: nb ? `Hei ${reg.name}, dette er en påminnelse om at du er påmeldt ${title}.` : `Hi ${reg.name}, this is a reminder that you are registered for ${title}.`,
      qr: nb ? "Vis QR-koden i døren." : "Show the QR code at the door.",
      link: nb ? "Kan du ikke komme likevel? Avbestill her, så får noen andre plassen:" : "Can't make it after all? Cancel here so someone else can have your place:",
    },
    occurrenceCancelled: {
      subject: nb ? `Avlyst: ${title}` : `Cancelled: ${title}`,
      lead: nb ? `Hei ${reg.name}, vi må dessverre avlyse ${title}. Du trenger ikke gjøre noe.` : `Hi ${reg.name}, unfortunately ${title} has been cancelled. You do not need to do anything.`,
      qr: "",
      link: nb ? "Påmeldingen din:" : "Your registration:",
    },
    cancelled: {
      subject: nb ? `Avbestilt: ${title}` : `Cancelled: ${title}`,
      lead: nb ? `Hei ${reg.name}, påmeldingen din til ${title} er avbestilt.` : `Hi ${reg.name}, your registration for ${title} has been cancelled.`,
      qr: "",
      link: nb ? "Detaljer:" : "Details:",
    },
  }[i.kind];

  const details = [when, ...(where ? [where] : []), party];
  const text = [
    copy.lead,
    "",
    ...details,
    "",
    ...(i.qrPng ? [copy.qr, ""] : []),
    copy.link,
    i.manageUrl,
    "",
    `— ${account.name}`,
  ].join("\n");

  const html = `<!doctype html><html lang="${esc(locale)}"><body style="margin:0;background:#f4f4f5;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#18181b">
<div style="max-width:560px;margin:0 auto;padding:24px">
<p style="color:#52525b;font-size:14px;margin:0 0 16px">${esc(account.name)}</p>
<div style="background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:24px">
<h1 style="font-size:22px;line-height:1.3;margin:0 0 12px">${esc(title)}</h1>
<p style="margin:0 0 16px">${esc(copy.lead)}</p>
<p style="margin:0 0 16px;line-height:1.6">${details.map(esc).join("<br>")}</p>
${i.qrPng ? `<p style="margin:0 0 8px">${esc(copy.qr)}</p><img src="cid:qr" width="200" height="200" alt="${nb ? "QR-kode for inngang" : "QR code for admission"}" style="display:block;margin:0 0 16px">` : ""}
<p style="margin:0 0 8px">${esc(copy.link)}</p>
<p style="margin:0"><a href="${esc(i.manageUrl)}" style="color:#18181b;font-weight:600">${esc(i.manageUrl)}</a></p>
</div></div></body></html>`;

  return {
    subject: copy.subject,
    text,
    html,
    ...(i.qrPng ? { attachments: [{ name: "qr.png", contentType: "image/png", content: i.qrPng, contentId: "qr" }] } : {}),
  };
}

export function registrationEmailTask(db: Db, deps: RegistrationEmailDeps): Task {
  const base = deps.attendeeUrl.replace(/\/+$/, "");
  return async (payload, helpers) => {
    if (!isPayload(payload)) throw new Error(`Invalid ${REGISTRATION_EMAIL_TASK} payload`);
    const prepared = await withTenant(db, { tenantId: payload.tenantId }, async (tx) => {
      const message = await registration.loadMessage(tx, payload.registrationId);
      if (!message) return null;
      // A confirmation or change for a registration that was cancelled meanwhile: the cancellation email says it.
      if (payload.kind !== "cancelled" && message.registration.status === "cancelled") return null;
      const [manage, admission] = await Promise.all([
        registration.manageToken(tx, payload.tenantId, message.registration),
        payload.kind === "cancelled" ? Promise.resolve(null) : registration.admissionToken(tx, payload.tenantId, message.registration),
      ]);
      return { message, manage, admission };
    });
    if (!prepared) {
      helpers.logger.info(`registration ${payload.registrationId}: no ${payload.kind} email (gone or cancelled)`);
      return;
    }
    const qrPng = prepared.admission ? (await QRCode.toBuffer(prepared.admission, { type: "png", width: 400, margin: 1, errorCorrectionLevel: "M" })).toString("base64") : null;
    const mail = registrationEmail({ kind: payload.kind, message: prepared.message, manageUrl: `${base}/m/${prepared.manage}`, qrPng });
    await deps.mailer.send({ to: prepared.message.registration.email, ...mail });
    helpers.logger.info(`registration ${payload.registrationId}: ${payload.kind} email sent`);
  };
}
