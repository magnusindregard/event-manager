import createClient from "openapi-fetch";
import type { paths } from "./core.js";
import type { paths as publicPaths } from "./public.js";

// For a sales channel's connector: the server-side code between a web shop or POS and the
// reservations API (docs/integration-guide.md). Channel keys are secrets; never ship this to a
// browser. Uses only fetch and WebCrypto, so it runs on Node 22+, Deno, Bun and edge runtimes.

export type Reservation = paths["/v1/reservations/{id}"]["get"]["responses"][200]["content"]["application/json"];
export type ReservationLine = Reservation["lines"][number];

export interface ChannelClientOptions {
  /** The core API's origin, e.g. https://api.<host>; paths start with /v1. */
  baseUrl: string;
  /** The channel key, sk_<id>_<secret>. */
  channelKey: string;
  /** Replaces the global fetch, e.g. to add timeouts or route requests in tests. */
  fetch?: (request: Request) => Promise<Response>;
}

/** Typed client for /v1/reservations with the channel key as bearer token. */
export function createChannelClient(opts: ChannelClientOptions) {
  const client = createClient<paths>({ baseUrl: opts.baseUrl, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  client.use({
    onRequest({ request }) {
      request.headers.set("authorization", `Bearer ${opts.channelKey}`);
      return request;
    },
  });
  return client;
}

export type ChannelClient = ReturnType<typeof createChannelClient>;

/**
 * Typed client for the public API (/public/v1) read with the channel key: the channel's own
 * offers with SKUs and limits, and exact places left. Server-side only; never cached.
 */
export function createChannelCatalogClient(opts: ChannelClientOptions) {
  const client = createClient<publicPaths>({ baseUrl: opts.baseUrl, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  client.use({
    onRequest({ request }) {
      request.headers.set("authorization", `Bearer ${opts.channelKey}`);
      return request;
    },
  });
  return client;
}

/** The secret part of sk_<id>_<secret>: everything after the second underscore. */
function channelSecret(channelKey: string): string {
  const m = /^sk_[A-Za-z0-9]{12}_([A-Za-z0-9_-]{43})$/.exec(channelKey);
  if (!m) throw new Error("Not a channel key (sk_<id>_<secret>)");
  return m[1]!;
}

const enc = new TextEncoder();

async function hmacKey(channelKey: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(channelSecret(channelKey)));
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

const base64url = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function sign(key: CryptoKey, text: string): Promise<string> {
  return `v1.${base64url(await crypto.subtle.sign("HMAC", key, enc.encode(text)))}`;
}

/** The text a line's signature covers (reservation_line.v2): a JSON array in this fixed order. */
export const lineSignatureText = (reservationId: string, l: ReservationLine): string =>
  JSON.stringify([
    "reservation_line.v2", reservationId, l.id, l.lineNo, l.occurrenceId, l.offerId, l.offerCode, l.quantity, l.placesPerUnit,
    l.unitPrice, l.currency, l.vatClassCode, l.vatRatePct, l.externalSku, l.name, l.occurrenceStartUtc, l.timezone, l.locationName, l.group,
  ]);

/** The text the reservation's signature covers (reservation.v2), ending with its lines' signatures. */
export const reservationSignatureText = (r: Reservation): string =>
  JSON.stringify([
    "reservation.v2", r.id, r.channelId, r.status, r.expiresAt, r.externalRef, r.externalOrderRef, r.total.amount, r.total.currency, r.group,
    r.lines.map((l) => l.signature),
  ]);

/** Constant-time comparison of two signatures. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Checks the reservation's and every line's signature under the channel key, e.g. for a
 * snapshot that came back through the buyer's browser. Reading the reservation server-side with
 * GET /v1/reservations/{id} needs no check; it is the source of truth.
 */
export async function verifyReservation(r: Reservation, channelKey: string): Promise<boolean> {
  if (!r.signature || r.lines.some((l) => !l.signature)) return false;
  const key = await hmacKey(channelKey);
  for (const l of r.lines) if (!same(await sign(key, lineSignatureText(r.id, l)), l.signature!)) return false;
  return same(await sign(key, reservationSignatureText(r)), r.signature);
}
