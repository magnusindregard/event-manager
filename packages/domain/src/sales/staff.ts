import type { ReservationStatus, TicketCancelledBy, TicketStatus, Tx } from "@event-manager/db";
import * as catalog from "../catalog/index.js";
import * as inventory from "../inventory/index.js";
import { type ActorContext, DomainError } from "../shared/index.js";
import { assertCan, getAccount } from "../tenancy/index.js";
import { effectiveStatus, getReservationView, type Reservation } from "./reservations.js";

// Occurrence → Sales (docs/ticketing.md, "Admin interface"): held and sold per offer, the
// reservations with their channel's order references and buyers, and their tickets at this
// occurrence, so staff can cancel them. Reading needs sales.read (buyers are personal data).

export interface OfferSales {
  offerId: string;
  code: string;
  name: string;
  /** Units in held reservations that have not expired. */
  held: number;
  /** Valid tickets. */
  sold: number;
  cancelled: number;
  /** Places the valid tickets take (sold × places per unit). */
  places: number;
  /** Sum of the valid tickets' unit prices, minor units VAT included. */
  revenue: number;
}

export interface SalesTicket {
  id: string;
  lineId: string;
  offerId: string;
  status: TicketStatus;
  partySize: number;
  cancelledAt: Date | null;
  cancelledBy: TicketCancelledBy | null;
  externalRefundRef: string | null;
}

export interface SalesReservation {
  id: string;
  channel: { id: string; code: string; name: string };
  status: ReservationStatus;
  externalRef: string | null;
  externalOrderRef: string | null;
  buyer: { name: string | null; email: string | null; locale: string | null } | null;
  anonymisedAt: Date | null;
  /** Lines at this occurrence only; a reservation may span occurrences. */
  lines: { id: string; lineNo: number; offerId: string; offerCode: string; name: string; quantity: number; unitPrice: number; amount: number }[];
  tickets: SalesTicket[];
  /** Of the lines at this occurrence. */
  total: { amount: number; currency: string };
  /** Whether the reservation has lines at other occurrences too. */
  otherOccurrences: boolean;
  expiresAt: Date;
  confirmedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
}

export interface OccurrenceSales {
  occurrenceId: string;
  pool: inventory.Pool | null;
  offers: OfferSales[];
  reservations: SalesReservation[];
  currency: string;
}

const LIMIT = 2000;

function groupBy<T>(xs: readonly T[], key: (x: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const list = out.get(k);
    if (list) list.push(x);
    else out.set(k, [x]);
  }
  return out;
}

/** Staff: an occurrence's sales, newest reservations first (at most 2,000). */
export async function occurrenceSales(tx: Tx, ctx: ActorContext, occurrenceId: string, now: Date = new Date(), limit = LIMIT): Promise<OccurrenceSales> {
  assertCan(ctx, "sales.read");
  const occ = await tx.selectFrom("catalog.occurrence").select(["id", "event_id"]).where("id", "=", occurrenceId).executeTakeFirst();
  if (!occ) throw new DomainError("not_found", "Occurrence not found");

  const reservations = await tx.selectFrom("sales.reservation as r")
    .innerJoin("offers.sales_channel as c", "c.id", "r.channel_id")
    .select([
      "r.id", "r.status", "r.expires_at", "r.external_ref", "r.external_order_ref", "r.buyer_name", "r.buyer_email", "r.buyer_locale", "r.anonymised_at",
      "r.confirmed_at", "r.cancelled_at", "r.created_at", "c.id as channel_id", "c.code as channel_code", "c.name as channel_name",
    ])
    .where("r.id", "in", (eb) => eb.selectFrom("sales.reservation_line").select("reservation_id").where("occurrence_id", "=", occurrenceId))
    .orderBy("r.created_at", "desc").orderBy("r.id", "desc").limit(limit)
    .execute();
  const ids = reservations.map((r) => r.id);
  const [lines, tickets, others, offerRows, pool, heldRows] = await Promise.all([
    ids.length
      ? tx.selectFrom("sales.reservation_line").select(["id", "reservation_id", "line_no", "offer_id", "offer_code", "line_name", "quantity", "unit_price", "currency", "places_per_unit"])
        .where("occurrence_id", "=", occurrenceId).where("reservation_id", "in", ids).orderBy("line_no").execute()
      : Promise.resolve([]),
    tx.selectFrom("sales.ticket as t").innerJoin("sales.reservation_line as l", "l.id", "t.line_id")
      .select(["t.id", "t.reservation_id", "t.line_id", "t.offer_id", "t.status", "t.cancelled_at", "t.cancelled_by", "t.external_refund_ref", "l.places_per_unit", "l.unit_price"])
      .where("t.occurrence_id", "=", occurrenceId).orderBy("l.line_no").orderBy("t.created_at").orderBy("t.id").execute(),
    ids.length
      ? tx.selectFrom("sales.reservation_line").select("reservation_id").distinct().where("reservation_id", "in", ids).where("occurrence_id", "<>", occurrenceId).execute()
      : Promise.resolve([]),
    tx.selectFrom("offers.offer as o")
      .leftJoin("offers.offer_translation as t", (j) => j.onRef("t.offer_id", "=", "o.id"))
      .select(["o.id", "o.code", "o.status", "o.sort_order", "t.locale", "t.name"])
      .where("o.event_id", "=", occ.event_id).orderBy("o.sort_order").orderBy("o.code").execute(),
    inventory.getPool(tx, occurrenceId),
    // Held units per offer over every live hold here, not only the reservations listed below.
    tx.selectFrom("sales.reservation_line as l").innerJoin("sales.reservation as r", "r.id", "l.reservation_id")
      .select(["l.offer_id", (eb) => eb.fn.sum<number>("l.quantity").as("held")])
      .where("l.occurrence_id", "=", occurrenceId).where("r.status", "=", "held").where("r.expires_at", ">", now)
      .groupBy("l.offer_id").execute(),
  ]);

  const account = await getAccount(tx);
  const offers = new Map<string, OfferSales & { status: string; names: Map<string, string> }>();
  for (const o of offerRows) {
    let x = offers.get(o.id);
    if (!x) offers.set(o.id, x = { offerId: o.id, code: o.code, name: o.code, held: 0, sold: 0, cancelled: 0, places: 0, revenue: 0, status: o.status, names: new Map() });
    if (o.locale && o.name) x.names.set(o.locale, o.name);
  }
  for (const x of offers.values()) x.name = x.names.get(account.defaultLocale) ?? [...x.names.values()][0] ?? x.code;

  const status = new Map(reservations.map((r) => [r.id, effectiveStatus({ status: r.status, expiresAt: r.expires_at }, now)]));
  for (const h of heldRows) offers.get(h.offer_id)!.held = Number(h.held);
  for (const t of tickets) {
    const x = offers.get(t.offer_id)!;
    if (t.status === "valid") {
      x.sold++;
      x.places += t.places_per_unit;
      x.revenue += t.unit_price;
    } else x.cancelled++;
  }

  const linesOf = groupBy(lines, (l) => l.reservation_id);
  const ticketsOf = groupBy(tickets, (t) => t.reservation_id);
  const spans = new Set(others.map((o) => o.reservation_id));
  return {
    occurrenceId,
    pool,
    currency: catalog.CURRENCY,
    // Archived offers only when they sold or hold something here.
    offers: [...offers.values()].filter((o) => o.status === "active" || o.held || o.sold || o.cancelled)
      .map(({ status: _s, names: _n, ...o }) => o),
    reservations: reservations.map((r) => {
      const ls = linesOf.get(r.id) ?? [];
      return {
        id: r.id,
        channel: { id: r.channel_id, code: r.channel_code, name: r.channel_name },
        status: status.get(r.id)!,
        externalRef: r.external_ref,
        externalOrderRef: r.external_order_ref,
        buyer: r.buyer_name || r.buyer_email || r.buyer_locale ? { name: r.buyer_name, email: r.buyer_email, locale: r.buyer_locale } : null,
        anonymisedAt: r.anonymised_at,
        lines: ls.map((l) => ({ id: l.id, lineNo: l.line_no, offerId: l.offer_id, offerCode: l.offer_code, name: l.line_name, quantity: l.quantity, unitPrice: l.unit_price, amount: l.unit_price * l.quantity })),
        tickets: (ticketsOf.get(r.id) ?? []).map((t) => ({
          id: t.id, lineId: t.line_id, offerId: t.offer_id, status: t.status, partySize: t.places_per_unit,
          cancelledAt: t.cancelled_at, cancelledBy: t.cancelled_by, externalRefundRef: t.external_refund_ref,
        })),
        total: { amount: ls.reduce((s, l) => s + l.unit_price * l.quantity, 0), currency: ls[0]?.currency ?? catalog.CURRENCY },
        otherOccurrences: spans.has(r.id),
        expiresAt: r.expires_at,
        confirmedAt: r.confirmed_at,
        cancelledAt: r.cancelled_at,
        createdAt: r.created_at,
      };
    }),
  };
}

/** Staff: one reservation as the channel sees it, unsigned. */
export async function getReservationAsStaff(tx: Tx, ctx: ActorContext, id: string, now: Date = new Date()): Promise<Reservation> {
  assertCan(ctx, "sales.read");
  return getReservationView(tx, ctx.tenantId, id, now);
}
