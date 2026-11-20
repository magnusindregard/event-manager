import { newId, type ReservationStatus, sql, type TicketCancelledBy, type TicketStatus, type Tx } from "@event-manager/db";
import * as admission from "../admission/index.js";
import * as catalog from "../catalog/index.js";
import * as inventory from "../inventory/index.js";
import * as offers from "../offers/index.js";
import { emit } from "../outbox/index.js";
import * as registration from "../registration/index.js";
import { type ActorContext, DomainError } from "../shared/index.js";
import { assertCan, getAccount, recordAudit } from "../tenancy/index.js";
import { lineName, lineSignatureText, reservationSignatureText, shortWhen, sign } from "./snapshot.js";

// Reservations (docs/ticketing.md, "Reservations API", milestone 3). A sales channel reserves
// places while the buyer pays, confirms once it has charged them, or cancels. Every line is
// priced and frozen at reserve time (the snapshot); confirm charges what the snapshot says.
//
// Places are held with one inventory hold per pool, all or none. Lock order everywhere: a key
// share on the occurrences, then the pools in id order, then the reservation (as registrations
// do, ADR 0003), so reservations spanning occurrences never deadlock with each other or with
// registrations and schedule changes. Expiry is checked on confirm, not only by the sweeper: a
// buyer who paid late still gets their tickets if the places are free.

/** Who is calling: a sales channel's key. */
export interface ChannelCaller {
  tenantId: string;
  channelId: string;
  /** Key for snapshot signatures: SHA-256 of the calling key's secret. Null: responses are unsigned. */
  signingKey: Buffer | null;
}

export interface ReserveLineInput {
  occurrenceId: string;
  offerId: string;
  quantity: number;
}

export interface BuyerInput {
  name?: string | null;
  email?: string | null;
  locale?: string | null;
}

export interface ReserveInput {
  lines: ReserveLineInput[];
  /** The channel's cart or quote id. */
  externalRef?: string | null;
  /** Language of the line names; the account's default if left out or not enabled. */
  locale?: string;
  /** Confirm in the same transaction (a POS walk-up sale); needs externalOrderRef. */
  confirm?: boolean;
  externalOrderRef?: string;
  buyer?: BuyerInput | null;
}

export interface ConfirmInput {
  externalOrderRef: string;
  buyer?: BuyerInput | null;
}

export interface CancelInput {
  /** Confirmed reservations: the tickets to cancel; all valid ones when left out. */
  ticketIds?: string[] | null;
  /** The channel's refund, for reconciliation. */
  externalRefundRef?: string | null;
}

export interface ReservationLine {
  id: string;
  lineNo: number;
  occurrenceId: string;
  offerId: string;
  offerCode: string;
  quantity: number;
  placesPerUnit: number;
  /** Minor units, VAT included. */
  unitPrice: number;
  /** unitPrice × quantity. */
  amount: number;
  currency: string;
  vatClassCode: string;
  vatRatePct: number;
  externalSku: string;
  name: string;
  occurrenceStartUtc: Date;
  timezone: string;
  locationName: string | null;
  signature: string | null;
}

export interface Ticket {
  id: string;
  lineId: string;
  occurrenceId: string;
  offerId: string;
  status: TicketStatus;
  admissionId: string;
  partySize: number;
  cancelledAt: Date | null;
  cancelledBy: TicketCancelledBy | null;
  externalRefundRef: string | null;
  /** For the ticket page (/t/{token}); null once cancelled. */
  ticketToken: string | null;
  /** The QR code's payload; null once cancelled. */
  admissionToken: string | null;
}

export interface Reservation {
  id: string;
  channelId: string;
  /** held past expiresAt reads as expired, also before the sweeper has run. */
  status: ReservationStatus;
  expiresAt: Date;
  /** The latest expiresAt that extend can reach. */
  extendLimitAt: Date;
  externalRef: string | null;
  externalOrderRef: string | null;
  locale: string;
  buyer: { name: string | null; email: string | null; locale: string | null } | null;
  lines: ReservationLine[];
  total: { amount: number; currency: string };
  tickets: Ticket[];
  confirmedAt: Date | null;
  cancelledAt: Date | null;
  /** When retention removed the buyer. */
  anonymisedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  signature: string | null;
}

export const MAX_HOLD_MINUTES = 60;
const MAX_LINES = 50;
const MIN = 60_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const invalid = (field: string, message: string) => new DomainError("validation_failed", message, { field });

const columns = [
  "id", "channel_id", "status", "expires_at", "external_ref", "external_order_ref", "locale", "buyer_name", "buyer_email", "buyer_locale",
  "confirmed_at", "cancelled_at", "anonymised_at", "version", "created_at", "updated_at",
] as const;
type Row = {
  id: string; channel_id: string; status: ReservationStatus; expires_at: Date; external_ref: string | null; external_order_ref: string | null; locale: string;
  buyer_name: string | null; buyer_email: string | null; buyer_locale: string | null; confirmed_at: Date | null; cancelled_at: Date | null;
  anonymised_at: Date | null; version: number; created_at: Date; updated_at: Date;
};

/** Pure: held past its expiry reads as expired. */
export const effectiveStatus = (r: { status: ReservationStatus; expiresAt: Date }, now: Date): ReservationStatus =>
  r.status === "held" && r.expiresAt <= now ? "expired" : r.status;

async function requireChannel(tx: Tx, caller: ChannelCaller): Promise<offers.SalesChannel> {
  const channel = await offers.activeChannel(tx, caller.channelId);
  if (!channel) throw new DomainError("forbidden", "The sales channel is inactive");
  return channel;
}

const ref = (field: string, v: string | null | undefined, required: boolean): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) {
    if (required) throw invalid(field, "Give the reference (at most 200 characters)");
    return null;
  }
  if (s.length > 200) throw invalid(field, "At most 200 characters");
  return s;
};

async function normalizeBuyer(tx: Tx, b: BuyerInput | null | undefined): Promise<{ name: string | null; email: string | null; locale: string | null } | null> {
  if (!b) return null;
  const name = b.name ? b.name.replace(/\s+/g, " ").trim() : "";
  if (name.length > 200) throw invalid("buyer.name", "At most 200 characters");
  const email = b.email ? b.email.trim().toLowerCase() : "";
  if (email && (email.length > 254 || !EMAIL_RE.test(email))) throw invalid("buyer.email", "Enter a valid email address");
  const locale = b.locale ? await registration.pickLocale(tx, b.locale) : null;
  if (!name && !email && !locale) return null;
  return { name: name || null, email: email || null, locale };
}

// ── Checking what is for sale ─────────────────────────────────────────────────

interface Sellable {
  offer: offers.Offer;
  target: catalog.RegistrationTarget;
  sku: string;
  unitPrice: number;
}

/**
 * Checks that the channel may sell the offer at the occurrence now, and prices it. Errors carry
 * the line index, so the shop can point at the line. Used on reserve and again on extend.
 */
async function sellable(
  tx: Tx, channelId: string, line: { occurrenceId: string; offerId: string }, index: number, now: Date,
  cache: { offers: Map<string, offers.Offer | null>; targets: Map<string, catalog.RegistrationTarget | null>; skus: Map<string, string> },
): Promise<Sellable> {
  const details = { line: index, occurrenceId: line.occurrenceId, offerId: line.offerId };
  if (!cache.offers.has(line.offerId)) cache.offers.set(line.offerId, await offers.getOffer(tx, line.offerId).catch(() => null));
  const offer = cache.offers.get(line.offerId);
  if (!offer) throw new DomainError("not_found", "Offer not found", details);
  if (!cache.targets.has(line.occurrenceId)) cache.targets.set(line.occurrenceId, await catalog.getRegistrationTarget(tx, line.occurrenceId).catch(() => null));
  const target = cache.targets.get(line.occurrenceId);
  if (!target) throw new DomainError("not_found", "Occurrence not found", details);
  if (target.event.id !== offer.eventId) throw new DomainError("offer_unavailable", "The offer is not sold at this occurrence", details);
  if (offer.status !== "active") throw new DomainError("offer_unavailable", "The offer is no longer sold", details);
  if (!offer.channelIds.includes(channelId)) throw new DomainError("channel_not_allowed", "The offer is not sold in this channel", details);
  const sku = cache.skus.get(offer.vatClassId);
  if (!sku) throw new DomainError("no_sku", "The channel has no SKU for the offer's VAT class", details);
  const e = target.event;
  if (e.admissionMode !== "tickets" || e.status !== "published" || target.occurrence.status !== "scheduled" || !target.pool) {
    throw new DomainError("not_on_sale", "The occurrence is not on sale", details);
  }
  const price = (await offers.loadEffectivePrices(tx, [target.occurrence.id])).get(target.occurrence.id)?.get(offer.id);
  if (!price || !price.available.value) throw new DomainError("offer_unavailable", "The offer is not sold at this occurrence", details);
  const w = offers.salesWindow(target.occurrence.startUtc, offer);
  if (!offers.windowOpen(w, now)) {
    throw new DomainError("not_on_sale", "The offer is not on sale now", { ...details, opensAt: w.opensAt?.toISOString() ?? null, closesAt: w.closesAt.toISOString() });
  }
  return { offer, target, sku, unitPrice: price.price.value };
}

async function skusOf(tx: Tx, channelId: string): Promise<Map<string, string>> {
  const rows = await tx.selectFrom("offers.sku_mapping").select(["vat_class_id", "external_sku"]).where("channel_id", "=", channelId).execute();
  return new Map(rows.map((r) => [r.vat_class_id, r.external_sku]));
}

const newCache = async (tx: Tx, channelId: string) => ({
  offers: new Map<string, offers.Offer | null>(), targets: new Map<string, catalog.RegistrationTarget | null>(), skus: await skusOf(tx, channelId),
});

// ── Locking ───────────────────────────────────────────────────────────────────

/** Key share on the occurrences, then their pools for update in id order. Returns the pools by occurrence. */
async function lockOccurrences(tx: Tx, occurrenceIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(occurrenceIds)].sort();
  if (!ids.length) return new Map();
  await tx.selectFrom("catalog.occurrence").select("id").where("id", "in", ids).orderBy("id").forKeyShare().execute();
  const pools = await tx.selectFrom("inventory.capacity_pool").select(["id", "occurrence_id"]).where("occurrence_id", "in", ids).orderBy("id").forUpdate().execute();
  return new Map(pools.map((p) => [p.occurrence_id, p.id]));
}

interface HoldRow { occurrence_id: string; hold_id: string; places: number }

/** Locks a reservation after its occurrences and pools. Channel callers see only their own. */
async function lockReservation(tx: Tx, id: string, channelId: string | null): Promise<{ row: Row; holds: HoldRow[] }> {
  const holds = await tx.selectFrom("sales.reservation_hold").select(["occurrence_id", "hold_id", "places"]).where("reservation_id", "=", id).execute();
  const pools = await lockOccurrences(tx, holds.map((h) => h.occurrence_id));
  const row = await tx.selectFrom("sales.reservation").select(columns).where("id", "=", id).forUpdate().executeTakeFirst();
  if (!row || (channelId !== null && row.channel_id !== channelId)) throw new DomainError("not_found", "Reservation not found");
  // Pool id order, as the pools were locked.
  holds.sort((a, b) => (pools.get(a.occurrence_id) ?? "").localeCompare(pools.get(b.occurrence_id) ?? ""));
  return { row, holds };
}

// ── Reserve ───────────────────────────────────────────────────────────────────

/**
 * Holds places for all lines or none, prices them and freezes the snapshot. With confirm, it
 * also confirms in the same transaction. Throws sold_out (with the occurrence and places left),
 * not_on_sale, offer_unavailable, channel_not_allowed, no_sku or quantity_out_of_range.
 */
export async function reserve(tx: Tx, caller: ChannelCaller, input: ReserveInput, now: Date = new Date()): Promise<Reservation> {
  const channel = await requireChannel(tx, caller);
  const lines = input.lines ?? [];
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > MAX_LINES) throw invalid("lines", `Give 1–${MAX_LINES} lines`);
  const seen = new Set<string>();
  lines.forEach((l, i) => {
    const k = `${l.occurrenceId}|${l.offerId}`;
    if (seen.has(k)) throw invalid(`lines.${i}`, "Each offer appears once per occurrence; raise the quantity instead");
    seen.add(k);
    if (!Number.isInteger(l.quantity) || l.quantity < 1) throw invalid(`lines.${i}.quantity`, "Must be a whole number of at least 1");
  });
  const externalRef = ref("externalRef", input.externalRef, false);
  const externalOrderRef = input.confirm ? ref("externalOrderRef", input.externalOrderRef, true) : null;
  const locale = await registration.pickLocale(tx, input.locale);
  const account = await getAccount(tx);

  // Lock first, then read what to freeze: hand edits and regeneration lock occurrences for
  // update, so one committed before this is seen below and one started after waits for us.
  const pools = await lockOccurrences(tx, lines.map((l) => l.occurrenceId));
  const cache = await newCache(tx, channel.id);
  const priced = [];
  for (const [i, l] of lines.entries()) {
    const s = await sellable(tx, channel.id, l, i, now, cache);
    if (l.quantity < s.offer.minPerReservation || l.quantity > s.offer.maxPerReservation) {
      throw new DomainError("quantity_out_of_range", `Buy ${s.offer.minPerReservation}–${s.offer.maxPerReservation} of this offer`, {
        line: i, occurrenceId: l.occurrenceId, offerId: l.offerId, min: s.offer.minPerReservation, max: s.offer.maxPerReservation,
      });
    }
    priced.push({ ...s, input: l, index: i });
  }
  const vat = new Map((await offers.listVatClasses(tx)).map((v) => [v.id, v]));

  const id = newId();
  const expiresAt = new Date(now.getTime() + channel.holdMinutes * MIN);
  await tx.insertInto("sales.reservation").values({ id, tenant_id: caller.tenantId, channel_id: channel.id, status: "held", expires_at: expiresAt, external_ref: externalRef, locale, created_at: now }).execute();

  // Places per occurrence, held per pool in id order, all or none.
  const places = new Map<string, number>();
  for (const p of priced) places.set(p.input.occurrenceId, (places.get(p.input.occurrenceId) ?? 0) + p.input.quantity * p.offer.placesPerUnit);
  for (const occurrenceId of [...places.keys()].sort((a, b) => pools.get(a)!.localeCompare(pools.get(b)!))) {
    const n = places.get(occurrenceId)!;
    const holdId = await inventory.placeHold(tx, caller.tenantId, occurrenceId, n, expiresAt);
    if (!holdId) {
      const pool = await inventory.getPool(tx, occurrenceId);
      throw new DomainError("sold_out", "There are not enough places left", {
        occurrenceId, placesLeft: pool?.available ?? 0, places: n, lines: priced.filter((p) => p.input.occurrenceId === occurrenceId).map((p) => p.index),
      });
    }
    await tx.insertInto("sales.reservation_hold").values({ tenant_id: caller.tenantId, reservation_id: id, occurrence_id: occurrenceId, hold_id: holdId, places: n }).execute();
  }
  // A held occurrence keeps its frozen time when its series is regenerated, as registered and
  // sold ones do. It stays detached after the reservation ends; staff can reattach it.
  for (const occurrenceId of places.keys()) await catalog.detachForRegistrations(tx, occurrenceId);

  const title = (t: catalog.RegistrationTarget) => t.event.translations[locale]?.title ?? t.event.translations[account.defaultLocale]?.title ?? t.event.slug;
  const offerName = (o: offers.Offer) => o.translations[locale]?.name ?? o.translations[account.defaultLocale]?.name ?? o.code;
  await tx.insertInto("sales.reservation_line").values(priced.map((p, i) => {
    const v = vat.get(p.offer.vatClassId)!;
    const tz = p.target.event.timezone;
    const location = p.target.location?.name ?? null;
    return {
      id: newId(), tenant_id: caller.tenantId, reservation_id: id, line_no: i + 1, occurrence_id: p.input.occurrenceId, offer_id: p.offer.id,
      quantity: p.input.quantity, places_per_unit: p.offer.placesPerUnit, offer_code: p.offer.code, unit_price: p.unitPrice, currency: catalog.CURRENCY,
      vat_class_code: v.code, vat_rate_pct: v.ratePct, external_sku: p.sku,
      line_name: lineName(offerName(p.offer), title(p.target), shortWhen(locale, tz, p.target.occurrence.startUtc), location),
      occurrence_start_utc: p.target.occurrence.startUtc, timezone: tz, location_name: location,
    };
  })).execute();

  const total = priced.reduce((s, p) => s + p.unitPrice * p.input.quantity, 0);
  await emit(tx, caller.tenantId, {
    type: "reservation.held.v1", subject: `reservation/${id}`,
    data: {
      reservationId: id, channelId: channel.id, expiresAt: expiresAt.toISOString(), total: { amount: total, currency: catalog.CURRENCY },
      lines: priced.map((p) => ({ occurrenceId: p.input.occurrenceId, offerId: p.offer.id, quantity: p.input.quantity, unitPrice: p.unitPrice })),
    },
  });
  if (input.confirm) return confirm(tx, caller, id, { externalOrderRef: externalOrderRef!, buyer: input.buyer }, now);
  return view(tx, caller, id, now);
}

// ── Read ──────────────────────────────────────────────────────────────────────

/** The reservation as it is now. Channel callers see only their own channel's reservations. */
export async function getReservation(tx: Tx, caller: ChannelCaller, id: string, now: Date = new Date()): Promise<Reservation> {
  await requireChannel(tx, caller);
  return view(tx, caller, id, now);
}

/** Staff: the reservation without signatures. Callers check sales.read. */
export const getReservationView = (tx: Tx, tenantId: string, id: string, now: Date = new Date()): Promise<Reservation> =>
  view(tx, { tenantId, channelId: null, signingKey: null }, id, now);

/** Who reads: a channel (its own reservations, signed for its key) or staff (any, unsigned). */
type Reader = { tenantId: string; channelId: string | null; signingKey: Buffer | null };

async function view(tx: Tx, caller: Reader, id: string, now: Date): Promise<Reservation> {
  const r = await tx.selectFrom("sales.reservation").select(columns).where("id", "=", id).executeTakeFirst();
  if (!r || (caller.channelId !== null && r.channel_id !== caller.channelId)) throw new DomainError("not_found", "Reservation not found");
  const [lineRows, ticketRows] = await Promise.all([
    tx.selectFrom("sales.reservation_line").selectAll().where("reservation_id", "=", id).orderBy("line_no").execute(),
    tx.selectFrom("sales.ticket").select(["id", "line_id", "occurrence_id", "offer_id", "status", "token_version", "cancelled_at", "cancelled_by", "external_refund_ref"]).where("reservation_id", "=", id).orderBy("created_at").orderBy("id").execute(),
  ]);
  const admissions = await admission.ticketAdmissions(tx, ticketRows.map((t) => t.id));
  const lineNo = new Map(lineRows.map((l) => [l.id, l.line_no]));
  ticketRows.sort((a, b) => lineNo.get(a.line_id)! - lineNo.get(b.line_id)! || 0);
  const lines: ReservationLine[] = lineRows.map((l) => ({
    id: l.id, lineNo: l.line_no, occurrenceId: l.occurrence_id, offerId: l.offer_id, offerCode: l.offer_code, quantity: l.quantity, placesPerUnit: l.places_per_unit,
    unitPrice: l.unit_price, amount: l.unit_price * l.quantity, currency: l.currency, vatClassCode: l.vat_class_code, vatRatePct: Number(l.vat_rate_pct),
    externalSku: l.external_sku, name: l.line_name, occurrenceStartUtc: l.occurrence_start_utc, timezone: l.timezone, locationName: l.location_name, signature: null,
  }));
  const key = caller.signingKey;
  if (key) for (const l of lines) l.signature = sign(key, lineSignatureText(id, l));
  const tickets: Ticket[] = [];
  for (const t of ticketRows) {
    const a = admissions.get(t.id)!;
    const valid = t.status === "valid";
    tickets.push({
      id: t.id, lineId: t.line_id, occurrenceId: t.occurrence_id, offerId: t.offer_id, status: t.status, admissionId: a.id, partySize: a.partySize,
      cancelledAt: t.cancelled_at, cancelledBy: t.cancelled_by, externalRefundRef: t.external_refund_ref,
      ticketToken: valid ? await registration.issueToken(tx, caller.tenantId, "ticket", t.id, t.token_version) : null,
      admissionToken: valid ? await registration.issueToken(tx, caller.tenantId, "admission", a.id, t.token_version) : null,
    });
  }
  const res: Reservation = {
    id: r.id, channelId: r.channel_id, status: effectiveStatus({ status: r.status, expiresAt: r.expires_at }, now), expiresAt: r.expires_at,
    extendLimitAt: new Date(r.created_at.getTime() + MAX_HOLD_MINUTES * MIN),
    externalRef: r.external_ref, externalOrderRef: r.external_order_ref, locale: r.locale,
    buyer: r.buyer_name || r.buyer_email || r.buyer_locale ? { name: r.buyer_name, email: r.buyer_email, locale: r.buyer_locale } : null,
    lines, total: { amount: lines.reduce((s, l) => s + l.amount, 0), currency: lines[0]?.currency ?? catalog.CURRENCY }, tickets,
    confirmedAt: r.confirmed_at, cancelledAt: r.cancelled_at, anonymisedAt: r.anonymised_at, version: r.version, createdAt: r.created_at, updatedAt: r.updated_at, signature: null,
  };
  if (key) res.signature = sign(key, reservationSignatureText(res, lines.map((l) => l.signature!)));
  return res;
}

// ── Extend ────────────────────────────────────────────────────────────────────

/**
 * Moves expiresAt to `minutes` from now (the channel's hold time by default), at most 60 minutes
 * after the reservation was made. Revalidates the lines: an offer taken off sale meanwhile fails
 * the extend with its reason. Throws expired or extend_limit.
 */
export async function extendReservation(tx: Tx, caller: ChannelCaller, id: string, input: { minutes?: number } = {}, now: Date = new Date()): Promise<Reservation> {
  const channel = await requireChannel(tx, caller);
  const minutes = input.minutes ?? channel.holdMinutes;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_HOLD_MINUTES) throw invalid("minutes", `Must be a whole number of minutes, 1–${MAX_HOLD_MINUTES}`);
  const { row, holds } = await lockReservation(tx, id, channel.id);
  const status = effectiveStatus({ status: row.status, expiresAt: row.expires_at }, now);
  if (status === "cancelled") throw new DomainError("already_cancelled", "The reservation is cancelled");
  if (status === "confirmed") throw new DomainError("already_confirmed", "The reservation is confirmed");
  if (status === "expired") throw new DomainError("expired", "The reservation has expired");
  const limit = new Date(row.created_at.getTime() + MAX_HOLD_MINUTES * MIN);
  const expiresAt = new Date(Math.min(now.getTime() + minutes * MIN, limit.getTime()));
  if (expiresAt <= row.expires_at) throw new DomainError("extend_limit", "The reservation cannot be held any longer", { extendLimitAt: limit.toISOString() });

  const lines = await tx.selectFrom("sales.reservation_line").select(["line_no", "occurrence_id", "offer_id"]).where("reservation_id", "=", id).orderBy("line_no").execute();
  const cache = await newCache(tx, channel.id);
  for (const l of lines) await sellable(tx, channel.id, { occurrenceId: l.occurrence_id, offerId: l.offer_id }, l.line_no - 1, now, cache);
  for (const h of holds) {
    if (!(await inventory.extendHold(tx, h.hold_id, expiresAt))) throw new DomainError("expired", "The reservation has expired");
  }
  await tx.updateTable("sales.reservation").set({ expires_at: expiresAt, version: sql<number>`version + 1` }).where("id", "=", id).execute();
  return view(tx, caller, id, now);
}

// ── Confirm ───────────────────────────────────────────────────────────────────

/**
 * Takes the held places, issues one ticket per unit with its admission, and stores the
 * channel's order and the buyer. After expiry it takes the places again if they are still
 * free, and fails with expired_sold_out if not (the channel then refunds). Confirming again
 * with the same order returns the reservation as it is; with another order it fails.
 */
export async function confirm(tx: Tx, caller: ChannelCaller, id: string, input: ConfirmInput, now: Date = new Date()): Promise<Reservation> {
  const channel = await requireChannel(tx, caller);
  const externalOrderRef = ref("externalOrderRef", input.externalOrderRef, true)!;
  const buyer = await normalizeBuyer(tx, input.buyer);
  const { row, holds } = await lockReservation(tx, id, channel.id);
  if (row.status === "confirmed") {
    if (row.external_order_ref === externalOrderRef) return view(tx, caller, id, now);
    throw new DomainError("already_confirmed", "The reservation is confirmed for another order", { externalOrderRef: row.external_order_ref });
  }
  if (row.status === "cancelled") throw new DomainError("already_cancelled", "The reservation is cancelled");

  // The tickets must be for the time the buyer was shown and charged for. Regeneration leaves
  // held occurrences alone, but staff can still move one by hand while it is held.
  const lines = await tx.selectFrom("sales.reservation_line").select(["id", "occurrence_id", "offer_id", "quantity", "places_per_unit", "occurrence_start_utc"]).where("reservation_id", "=", id).orderBy("line_no").execute();
  const starts = new Map((await tx.selectFrom("catalog.occurrence").select(["id", "start_utc"]).where("id", "in", [...new Set(lines.map((l) => l.occurrence_id))]).execute()).map((o) => [o.id, o.start_utc]));
  for (const l of lines) {
    const current = starts.get(l.occurrence_id);
    if (current?.getTime() !== l.occurrence_start_utc.getTime()) {
      throw new DomainError("schedule_changed", "The occurrence has moved since the reservation was made; cancel it and reserve again", {
        occurrenceId: l.occurrence_id, reservedStartUtc: l.occurrence_start_utc.toISOString(), startUtc: current?.toISOString() ?? null,
      });
    }
  }

  for (const h of holds) {
    // A live hold becomes taken places. An expired one is released here, and a swept or
    // expired reservation's places are taken again if they still fit.
    let ok = row.status === "held" && (await inventory.endHold(tx, h.hold_id, true, now));
    if (!ok) ok = await inventory.takePlaces(tx, h.occurrence_id, h.places);
    if (!ok) {
      const pool = await inventory.getPool(tx, h.occurrence_id);
      throw new DomainError("expired_sold_out", "The reservation expired and its places have been sold", { occurrenceId: h.occurrence_id, placesLeft: pool?.available ?? 0, places: h.places });
    }
  }
  await tx.updateTable("sales.reservation").set({
    status: "confirmed", confirmed_at: now, external_order_ref: externalOrderRef,
    buyer_name: buyer?.name ?? null, buyer_email: buyer?.email ?? null, buyer_locale: buyer?.locale ?? null, version: sql<number>`version + 1`,
  }).where("id", "=", id).execute();

  const tickets = lines.flatMap((l) => Array.from({ length: l.quantity }, () => ({
    id: newId(), tenant_id: caller.tenantId, reservation_id: id, line_id: l.id, occurrence_id: l.occurrence_id, offer_id: l.offer_id, partySize: l.places_per_unit,
  })));
  for (let i = 0; i < tickets.length; i += 1000) {
    await tx.insertInto("sales.ticket").values(tickets.slice(i, i + 1000).map(({ partySize: _p, ...t }) => ({ ...t, created_at: now }))).execute();
  }
  await admission.issueTicketAdmissions(tx, caller.tenantId, tickets.map((t) => ({ ticketId: t.id, occurrenceId: t.occurrence_id, partySize: t.partySize })));
  // Reserve detached the occurrences already; a reattach since then detaches them again.
  for (const occurrenceId of new Set(lines.map((l) => l.occurrence_id))) await catalog.detachForRegistrations(tx, occurrenceId);

  await emit(tx, caller.tenantId, {
    type: "reservation.confirmed.v1", subject: `reservation/${id}`,
    data: {
      reservationId: id, channelId: channel.id, externalOrderRef, ticketIds: tickets.map((t) => t.id),
      lines: lines.map((l) => ({ occurrenceId: l.occurrence_id, offerId: l.offer_id, quantity: l.quantity })),
      afterExpiry: row.status === "expired" || row.expires_at <= now,
    },
  });
  return view(tx, caller, id, now);
}

// ── Cancel ──────────────────────────────────────────────────────────────────

/**
 * Held (or expired): releases the places and cancels the reservation. Confirmed: cancels the
 * listed tickets, or all valid ones, voids their admissions and links and puts their places
 * back on sale, recording the channel's refund reference; once no valid ticket is left the
 * reservation is cancelled too. Throws already_cancelled, and occurrence_started for a ticket
 * whose occurrence has begun (unless the occurrence itself was cancelled).
 */
export async function cancelReservation(tx: Tx, caller: ChannelCaller, id: string, input: CancelInput = {}, now: Date = new Date()): Promise<Reservation> {
  const channel = await requireChannel(tx, caller);
  const refundRef = ref("externalRefundRef", input.externalRefundRef, false);
  const { row, holds } = await lockReservation(tx, id, channel.id);
  if (row.status === "cancelled") throw new DomainError("already_cancelled", "The reservation is cancelled");
  if (row.status === "confirmed") {
    await cancelTickets(tx, caller.tenantId, row, holds, input.ticketIds ?? null, { by: "channel", refundRef }, now);
    return view(tx, caller, id, now);
  }
  if (input.ticketIds?.length) throw invalid("ticketIds", "The reservation is not confirmed, so it has no tickets");
  if (refundRef) throw invalid("externalRefundRef", "Only confirmed reservations are refunded");
  // Ending a hold that is gone (swept, or released at expiry) changes nothing.
  if (row.status === "held") for (const h of holds) await inventory.endHold(tx, h.hold_id, false, now);
  await tx.updateTable("sales.reservation").set({ status: "cancelled", cancelled_at: now, version: sql<number>`version + 1` }).where("id", "=", id).execute();
  await emit(tx, caller.tenantId, {
    type: "reservation.cancelled.v1", subject: `reservation/${id}`,
    data: { reservationId: id, channelId: channel.id, previousStatus: row.status, occurrenceIds: holds.map((h) => h.occurrence_id), by: "channel" },
  });
  return view(tx, caller, id, now);
}

/**
 * Staff (sales.write, Occurrence → Sales): cancels tickets of a confirmed reservation, e.g. at
 * the box office after the shop has refunded. The same rules as the channel's cancel.
 */
export async function cancelTicketsAsStaff(tx: Tx, ctx: ActorContext, id: string, input: CancelInput = {}, now: Date = new Date()): Promise<Reservation> {
  assertCan(ctx, "sales.write");
  const refundRef = ref("externalRefundRef", input.externalRefundRef, false);
  const { row, holds } = await lockReservation(tx, id, null);
  if (row.status === "cancelled") throw new DomainError("already_cancelled", "The reservation is cancelled");
  if (row.status !== "confirmed") throw new DomainError("conflict", "Only confirmed reservations have tickets to cancel; the channel releases held ones");
  const cancelled = await cancelTickets(tx, ctx.tenantId, row, holds, input.ticketIds ?? null, { by: "staff", refundRef }, now);
  const lines = await tx.selectFrom("sales.reservation_line as l").innerJoin("catalog.occurrence as o", "o.id", "l.occurrence_id")
    .select("o.event_id").where("l.reservation_id", "=", id).execute();
  for (const eventId of new Set(lines.map((l) => l.event_id))) {
    await recordAudit(tx, ctx, {
      action: "tickets.cancelled", entityType: "event", entityId: eventId,
      diff: { reservationId: id, externalOrderRef: row.external_order_ref, ticketIds: cancelled, ...(refundRef ? { externalRefundRef: refundRef } : {}) },
    });
  }
  return view(tx, { tenantId: ctx.tenantId, channelId: null, signingKey: null }, id, now);
}

/** Cancels tickets of a locked, confirmed reservation. Returns the ids cancelled. */
async function cancelTickets(
  tx: Tx, tenantId: string, row: Row, holds: HoldRow[], ticketIds: readonly string[] | null,
  opts: { by: TicketCancelledBy; refundRef: string | null }, now: Date,
): Promise<string[]> {
  const all = await tx.selectFrom("sales.ticket as t").innerJoin("sales.reservation_line as l", "l.id", "t.line_id")
    .select(["t.id", "t.status", "t.occurrence_id", "l.places_per_unit", "l.unit_price", "l.currency"])
    .where("t.reservation_id", "=", row.id).execute();
  let chosen;
  if (ticketIds) {
    if (!Array.isArray(ticketIds) || ticketIds.length === 0) throw invalid("ticketIds", "List the tickets to cancel, or leave the list out to cancel all");
    const byId = new Map(all.map((t) => [t.id, t]));
    const unknown = ticketIds.filter((x) => !byId.has(x));
    if (unknown.length) throw new DomainError("validation_failed", "Some tickets do not belong to the reservation", { field: "ticketIds", ticketIds: unknown });
    chosen = [...new Set(ticketIds)].map((x) => byId.get(x)!);
    const done = chosen.filter((t) => t.status === "cancelled").map((t) => t.id);
    if (done.length) throw new DomainError("already_cancelled", "Some tickets are already cancelled", { ticketIds: done });
  } else {
    chosen = all.filter((t) => t.status === "valid");
    if (!chosen.length) throw new DomainError("already_cancelled", "The reservation has no valid tickets");
  }

  // A ticket for an occurrence that has begun has been used, or could have been. A cancelled
  // occurrence's tickets can always be cancelled: that is the refund for the cancelled show.
  const occurrences = await tx.selectFrom("catalog.occurrence").select(["id", "start_utc", "status"])
    .where("id", "in", [...new Set(chosen.map((t) => t.occurrence_id))]).execute();
  const started = occurrences.filter((o) => o.status !== "cancelled" && o.start_utc <= now);
  if (started.length) {
    throw new DomainError("occurrence_started", "The occurrence has started; its tickets can no longer be cancelled", {
      occurrenceIds: started.map((o) => o.id), ticketIds: chosen.filter((t) => started.some((o) => o.id === t.occurrence_id)).map((t) => t.id),
    });
  }

  const ids = chosen.map((t) => t.id);
  for (let i = 0; i < ids.length; i += 1000) {
    const part = ids.slice(i, i + 1000);
    await tx.updateTable("sales.ticket").set({
      status: "cancelled", cancelled_at: now, cancelled_by: opts.by, external_refund_ref: opts.refundRef, token_version: sql<number>`token_version + 1`,
    }).where("id", "in", part).execute();
    await admission.voidTicketAdmissions(tx, part);
  }
  // Places back per occurrence, in pool id order (the order lockReservation locked them in).
  const places = new Map<string, number>();
  for (const t of chosen) places.set(t.occurrence_id, (places.get(t.occurrence_id) ?? 0) + t.places_per_unit);
  const order = holds.map((h) => h.occurrence_id);
  for (const occurrenceId of [...places.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b))) {
    await inventory.releasePlaces(tx, occurrenceId, places.get(occurrenceId)!);
  }

  const remaining = all.filter((t) => t.status === "valid" && !ids.includes(t.id)).length;
  await tx.updateTable("sales.reservation").set({
    ...(remaining === 0 ? { status: "cancelled" as const, cancelled_at: now } : {}), version: sql<number>`version + 1`,
  }).where("id", "=", row.id).execute();

  const amount = chosen.reduce((s, t) => s + t.unit_price, 0);
  await emit(tx, tenantId, {
    type: "ticket.cancelled.v1", subject: `reservation/${row.id}`,
    data: {
      reservationId: row.id, channelId: row.channel_id, externalOrderRef: row.external_order_ref, externalRefundRef: opts.refundRef, by: opts.by,
      ticketIds: ids, occurrenceIds: [...places.keys()], amount: { amount, currency: chosen[0]?.currency ?? catalog.CURRENCY }, remainingTickets: remaining,
    },
  });
  if (remaining === 0) {
    await emit(tx, tenantId, {
      type: "reservation.cancelled.v1", subject: `reservation/${row.id}`,
      data: { reservationId: row.id, channelId: row.channel_id, previousStatus: "confirmed", occurrenceIds: holds.map((h) => h.occurrence_id), by: opts.by },
    });
  }
  return ids;
}

// ── Expiry ────────────────────────────────────────────────────────────────────

/**
 * The sweeper's step for one reservation: a held reservation past its expiry releases its
 * places and becomes expired (reservation.expired). Returns the new expiry when it was extended
 * meanwhile and is not due yet, so the job can run again then; null otherwise.
 */
export async function expireReservation(tx: Tx, tenantId: string, id: string, now: Date = new Date()): Promise<Date | null> {
  const found = await tx.selectFrom("sales.reservation").select("id").where("id", "=", id).executeTakeFirst();
  if (!found) return null;
  const { row, holds } = await lockReservation(tx, id, null);
  if (row.status !== "held") return null;
  if (row.expires_at > now) return row.expires_at;
  for (const h of holds) await inventory.endHold(tx, h.hold_id, false, now);
  await tx.updateTable("sales.reservation").set({ status: "expired", expired_at: now, version: sql<number>`version + 1` }).where("id", "=", id).execute();
  await emit(tx, tenantId, {
    type: "reservation.expired.v1", subject: `reservation/${id}`,
    data: { reservationId: id, channelId: row.channel_id, expiresAt: row.expires_at.toISOString(), occurrenceIds: holds.map((h) => h.occurrence_id) },
  });
  return null;
}

