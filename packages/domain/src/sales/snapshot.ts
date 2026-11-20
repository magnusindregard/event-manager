import { createHmac } from "node:crypto";

// Pure parts of a reservation (docs/ticketing.md, "Reservation"): the line name a shop prints
// on its receipt, and the snapshot signatures.
//
// Signatures let a connector check a snapshot that came back through the buyer's browser
// without calling the API. They are HMAC-SHA256 under the SHA-256 of the calling channel key's
// secret (the part of sk_<id>_<secret> after the second underscore), which the connector holds
// and the platform stores only as that hash. Each response is signed for the key that asked.
// The signed text is the JSON array built below, so a connector rebuilds it from the response.

/** Date and time for a line name in the event's timezone, e.g. "Sat 13 Feb 19:30". */
export function shortWhen(locale: string, timezone: string, at: Date): string {
  const lang = locale.startsWith("n") ? "nb-NO" : locale === "en" ? "en-GB" : locale;
  const date = new Intl.DateTimeFormat(lang, { timeZone: timezone, weekday: "short", day: "numeric", month: "short" }).format(at).replace(/,/g, "");
  const time = new Intl.DateTimeFormat(lang, { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
  return `${date} ${time}`;
}

/** "Adult – Hamlet, Sat 13 Feb 19:30, Main stage". At most 200 characters. */
export function lineName(offerName: string, eventTitle: string, when: string, locationName: string | null): string {
  const name = `${offerName} – ${eventTitle}, ${when}${locationName ? `, ${locationName}` : ""}`;
  return name.length > 200 ? `${name.slice(0, 199)}…` : name;
}

export interface SignedLine {
  id: string;
  lineNo: number;
  occurrenceId: string;
  offerId: string;
  offerCode: string;
  quantity: number;
  placesPerUnit: number;
  unitPrice: number;
  currency: string;
  vatClassCode: string;
  vatRatePct: number;
  externalSku: string;
  name: string;
  occurrenceStartUtc: Date;
  timezone: string;
  locationName: string | null;
}

export interface SignedReservation {
  id: string;
  channelId: string;
  status: string;
  expiresAt: Date;
  externalRef: string | null;
  externalOrderRef: string | null;
  total: { amount: number; currency: string };
}

/** Pure: the text a line's signature covers. */
export const lineSignatureText = (reservationId: string, l: SignedLine): string =>
  JSON.stringify([
    "reservation_line.v1", reservationId, l.id, l.lineNo, l.occurrenceId, l.offerId, l.offerCode, l.quantity, l.placesPerUnit,
    l.unitPrice, l.currency, l.vatClassCode, l.vatRatePct, l.externalSku, l.name, l.occurrenceStartUtc.toISOString(), l.timezone, l.locationName,
  ]);

/** Pure: the text a reservation's signature covers; it includes its lines' signatures in order. */
export const reservationSignatureText = (r: SignedReservation, lineSignatures: readonly string[]): string =>
  JSON.stringify([
    "reservation.v1", r.id, r.channelId, r.status, r.expiresAt.toISOString(), r.externalRef, r.externalOrderRef, r.total.amount, r.total.currency, lineSignatures,
  ]);

/** Pure: "v1." + base64url(HMAC-SHA256(key, text)). */
export const sign = (key: Buffer, text: string): string => `v1.${createHmac("sha256", key).update(text).digest("base64url")}`;
