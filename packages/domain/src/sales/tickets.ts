import { sql, type TicketStatus, type Tx } from "@event-manager/db";
import * as admission from "../admission/index.js";
import * as catalog from "../catalog/index.js";
import * as registration from "../registration/index.js";
import { getAccount } from "../tenancy/index.js";
import { expireReservation } from "./reservations.js";

// Tickets (docs/ticketing.md, "Ticket and admission"): one per unit of a confirmed line, each
// with its own admission. The ticket page (/t/{token} on the attendee app) shows the QR code;
// both links are signed tokens with the ticket's token version, so cancelling or reissuing a
// ticket later invalidates them.

export interface TicketPage {
  ticket: { id: string; status: TicketStatus; partySize: number };
  /** The QR code's payload; null unless the ticket is valid. */
  admissionToken: string | null;
  line: { name: string; offerCode: string; unitPrice: number; currency: string };
  offerName: string;
  /** In the page's locale, falling back to the account default. */
  title: string;
  locale: string;
  locales: string[];
  accountName: string;
  target: catalog.RegistrationTarget;
}

/** The tenant a ticket link claims; open its transaction, then call ticketPage. */
export const ticketTenant = (token: string): string | null => registration.tokenTenant(token);

/** The ticket behind a ticket link, or null for a forged, reissued or foreign token. */
export async function ticketPage(tx: Tx, token: string, locale?: string): Promise<TicketPage | null> {
  const claims = await registration.verifyToken(tx, token, "ticket");
  if (!claims) return null;
  const t = await tx
    .selectFrom("sales.ticket as t")
    .innerJoin("sales.reservation_line as l", "l.id", "t.line_id")
    .innerJoin("sales.reservation as r", "r.id", "t.reservation_id")
    .select(["t.id", "t.status", "t.token_version", "t.occurrence_id", "t.offer_id", "l.line_name", "l.offer_code", "l.unit_price", "l.currency", "r.locale"])
    .where("t.id", "=", claims.subjectId)
    .executeTakeFirst();
  if (!t || t.token_version !== claims.tokenVersion) return null;
  const [account, target, admissions, translations] = await Promise.all([
    getAccount(tx),
    catalog.getRegistrationTarget(tx, t.occurrence_id),
    admission.ticketAdmissions(tx, [t.id]),
    tx.selectFrom("offers.offer_translation").select(["locale", "name"]).where("offer_id", "=", t.offer_id).execute(),
  ]);
  const loc = locale && account.locales.includes(locale) ? locale : account.locales.includes(t.locale) ? t.locale : account.defaultLocale;
  const a = admissions.get(t.id)!;
  const pick = <T>(m: Record<string, T>, k: (v: T) => string) => (m[loc] ? k(m[loc]!) : m[account.defaultLocale] ? k(m[account.defaultLocale]!) : null);
  const offerNames = Object.fromEntries(translations.map((x) => [x.locale, x.name]));
  return {
    ticket: { id: t.id, status: t.status, partySize: a.partySize },
    admissionToken: t.status === "valid" && a.status === "valid" ? await registration.issueToken(tx, claims.tenantId, "admission", a.id, t.token_version) : null,
    line: { name: t.line_name, offerCode: t.offer_code, unitPrice: t.unit_price, currency: t.currency },
    offerName: offerNames[loc] ?? offerNames[account.defaultLocale] ?? t.offer_code,
    title: pick(target.event.translations, (x) => x.title) ?? target.event.slug,
    locale: loc,
    locales: account.locales,
    accountName: account.name,
    target,
  };
}

/** Accounts with held reservations past their expiry; runs without a tenant (SECURITY DEFINER lookup). */
export async function overdueReservationTenants(tx: Tx, now: Date = new Date()): Promise<string[]> {
  const r = await sql<{ id: string }>`select sales.overdue_reservation_tenants(${now}) as id`.execute(tx);
  return r.rows.map((x) => x.id);
}

/** Expires a tenant's overdue reservations, oldest first. Returns how many it looked at; a full batch means more may be due. */
export async function sweepReservations(tx: Tx, tenantId: string, now: Date = new Date(), limit = 500): Promise<number> {
  const rows = await tx.selectFrom("sales.reservation").select("id").where("status", "=", "held").where("expires_at", "<=", now).orderBy("expires_at").limit(limit).execute();
  for (const r of rows) await expireReservation(tx, tenantId, r.id, now);
  return rows.length;
}
