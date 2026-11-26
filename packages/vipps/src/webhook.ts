import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// Vipps signs webhook requests with the webhook's secret (Webhooks API, "Request
// authentication"): the body's SHA-256 goes in x-ms-content-sha256, and Authorization is
//   HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=<base64>
// where the signature is an HMAC-SHA256 over
//   POST\n<path and query>\n<x-ms-date>;<host>;<x-ms-content-sha256>

export interface SignedRequest {
  method: string;
  /** Path and query as the request named them, e.g. /webhooks/vipps/…?x=1 */
  pathAndQuery: string;
  host: string;
  date: string;
  contentSha256: string;
  authorization: string;
  /** The raw body, exactly as received. */
  body: string | Buffer;
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function contentHash(body: string | Buffer): string {
  return createHash("sha256").update(body).digest("base64");
}

export function signature(secret: string, req: Pick<SignedRequest, "method" | "pathAndQuery" | "host" | "date" | "contentSha256">): string {
  const toSign = `${req.method.toUpperCase()}\n${req.pathAndQuery}\n${req.date};${req.host};${req.contentSha256}`;
  return createHmac("sha256", secret).update(toSign, "utf8").digest("base64");
}

/** True when the body is unchanged and the request was signed with `secret`. Timing-safe. */
export function verifyWebhook(secret: string, req: SignedRequest): boolean {
  if (!same(contentHash(req.body), req.contentSha256)) return false;
  const m = /^HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=(.+)$/.exec(req.authorization.trim());
  if (!m) return false;
  return same(signature(secret, req), m[1]!);
}

/** Headers a webhook request from Vipps carries, for tests and the fake. */
export function signHeaders(secret: string, req: { method: string; pathAndQuery: string; host: string; body: string; date?: string }): Record<string, string> {
  const date = req.date ?? new Date().toUTCString();
  const contentSha256 = contentHash(req.body);
  const sig = signature(secret, { ...req, date, contentSha256 });
  return {
    "x-ms-date": date,
    "x-ms-content-sha256": contentSha256,
    authorization: `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${sig}`,
  };
}

/** The ePayment webhook body (the fields the platform reads). */
export interface PaymentWebhook {
  msn: string;
  reference: string;
  name: string;
  pspReference?: string;
  timestamp?: string;
}
