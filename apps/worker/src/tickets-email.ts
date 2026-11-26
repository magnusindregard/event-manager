import type { Task } from "graphile-worker";
import QRCode from "qrcode";
import { type Db, sql, type Tx, withTenant } from "@event-manager/db";
import { sales } from "@event-manager/domain";
import type { InternalHandler } from "./handlers.js";
import { type Mail, sendOrGiveUp } from "./identity/mailer.js";
import { esc, formatWhen, type RegistrationEmailDeps } from "./registration-email.js";

// The tickets email (docs/ticketing.md, "Sales channel", decision 1): when a channel has
// sendTickets on and the buyer gave an email, the platform emails the tickets on confirm, one
// QR code and ticket page link per ticket. Otherwise the channel delivers them itself from the
// confirm response. One job per outbox event; the job key makes a redelivered event send once.
// The email shows the tickets that are valid when the job runs.

export const TICKETS_EMAIL_TASK = "sales.tickets_email";
/** More tickets than this get links only: an email with dozens of inline images gets clipped. */
const MAX_QR = 10;

export const queueTicketsEmail: InternalHandler = {
  name: "tickets-email",
  types: ["reservation.confirmed.v1"],
  async handle(tx, event, log) {
    const id = (event.data as { reservationId?: unknown }).reservationId;
    if (typeof id !== "string") return;
    // Most channels deliver tickets themselves; skip the job for them.
    const due = await tx.selectFrom("sales.reservation as r").innerJoin("offers.sales_channel as c", "c.id", "r.channel_id")
      .select("r.id").where("r.id", "=", id).where("c.send_tickets", "=", true).where("r.buyer_email", "is not", null).executeTakeFirst();
    if (!due) return;
    // Paid in the hosted checkout: the tickets go once the payment is captured (payments.ts).
    const paid = await tx.selectFrom("payments.payment").select("id").where("reservation_id", "=", id).executeTakeFirst();
    if (paid) return;
    await queueTicketsEmailJob(tx, event.tenantId, id, event.id);
    log.info("tickets email queued", { reservationId: id });
  },
};

/** Queues the tickets email for a reservation; the job key makes a redelivered event send once. */
export async function queueTicketsEmailJob(tx: Tx, tenantId: string, reservationId: string, eventId: string): Promise<void> {
  await sql`select graphile_worker.add_job(
    ${TICKETS_EMAIL_TASK},
    json_build_object('tenantId', ${tenantId}::text, 'reservationId', ${reservationId}::text),
    job_key := ${`ticketmail:${eventId}`},
    max_attempts := 10)`.execute(tx);
}

interface Payload {
  tenantId: string;
  reservationId: string;
}
const isPayload = (p: unknown): p is Payload =>
  typeof p === "object" && p !== null && typeof (p as Payload).tenantId === "string" && typeof (p as Payload).reservationId === "string";

export interface TicketsEmailInput {
  message: sales.TicketsMessage;
  /** Per ticket, in order: its page URL and, for the first MAX_QR, a PNG of its QR code (base64). */
  links: { url: string; qrPng: string | null }[];
}

/** Pure: subject, text and HTML for the tickets email. */
export function ticketsEmail(i: TicketsEmailInput): Omit<Mail, "to"> {
  const { message: m } = i;
  const nb = m.locale.startsWith("n");
  const titles = [...new Set(m.tickets.map((t) => t.title))];
  const count = m.tickets.length;
  const subject = nb ? `Billetter: ${titles.join(", ")}` : `Your tickets: ${titles.join(", ")}`;
  const lead = nb
    ? `Her er ${count === 1 ? "billetten din" : `de ${count} billettene dine`}${m.externalOrderRef ? ` for ordre ${m.externalOrderRef}` : ""}. Vis QR-koden i døren.`
    : `Here ${count === 1 ? "is your ticket" : `are your ${count} tickets`}${m.externalOrderRef ? ` for order ${m.externalOrderRef}` : ""}. Show the QR code at the door.`;
  const party = (n: number) => (n === 1 ? "" : nb ? ` (${n} personer)` : ` (${n} people)`);
  const blocks = m.tickets.map((t, n) => {
    const when = formatWhen(m.locale, t.target.event.timezone, t.target.occurrence.startUtc, t.target.occurrence.endUtc);
    const where = t.target.location ? [t.target.location.name, t.target.location.address].filter(Boolean).join(", ") : null;
    return { heading: `${t.lineName}${party(t.partySize)}`, details: [when, ...(where ? [where] : [])], ...i.links[n]!, n };
  });
  const open = nb ? "Åpne billetten:" : "Open the ticket:";

  const text = [
    lead, "",
    ...blocks.flatMap((b) => [b.heading, ...b.details, `${open} ${b.url}`, ""]),
    `— ${m.accountName}`,
  ].join("\n");

  const html = `<!doctype html><html lang="${esc(m.locale)}"><body style="margin:0;background:#f4f4f5;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#18181b">
<div style="max-width:560px;margin:0 auto;padding:24px">
<p style="color:#52525b;font-size:14px;margin:0 0 16px">${esc(m.accountName)}</p>
<p style="margin:0 0 16px">${esc(lead)}</p>
${blocks.map((b) => `<div style="background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:24px;margin:0 0 16px">
<h2 style="font-size:18px;line-height:1.3;margin:0 0 8px">${esc(b.heading)}</h2>
<p style="margin:0 0 16px;line-height:1.6">${b.details.map(esc).join("<br>")}</p>
${b.qrPng ? `<img src="cid:qr${b.n}" width="200" height="200" alt="${nb ? "QR-kode for inngang" : "QR code for admission"}" style="display:block;margin:0 0 16px">` : ""}
<p style="margin:0"><a href="${esc(b.url)}" style="color:#18181b;font-weight:600">${esc(open)}</a></p>
</div>`).join("\n")}
</div></body></html>`;

  const attachments = blocks.filter((b) => b.qrPng).map((b) => ({ name: `qr${b.n}.png`, contentType: "image/png", content: b.qrPng!, contentId: `qr${b.n}` }));
  return { subject, text, html, ...(attachments.length ? { attachments } : {}) };
}

export function ticketsEmailTask(db: Db, deps: RegistrationEmailDeps): Task {
  const base = deps.attendeeUrl.replace(/\/+$/, "");
  return async (payload, helpers) => {
    if (!isPayload(payload)) throw new Error(`Invalid ${TICKETS_EMAIL_TASK} payload`);
    const message = await withTenant(db, { tenantId: payload.tenantId }, (tx) => sales.ticketsMessage(tx, payload.reservationId));
    if (!message) {
      helpers.logger.info(`reservation ${payload.reservationId}: no tickets email (not sent by the channel, no email, or nothing valid)`);
      return;
    }
    const links = await Promise.all(message.tickets.map(async (t, n) => ({
      url: `${base}/t/${t.ticketToken}`,
      qrPng: n < MAX_QR ? (await QRCode.toBuffer(t.admissionToken, { type: "png", width: 400, margin: 1, errorCorrectionLevel: "M" })).toString("base64") : null,
    })));
    const mail = ticketsEmail({ message, links });
    const what = `reservation ${payload.reservationId}: tickets email`;
    if (!(await sendOrGiveUp(deps.mailer, { to: message.email, ...mail }, (l) => helpers.logger.error(l), what))) return;
    helpers.logger.info(`${what} sent`);
  };
}
