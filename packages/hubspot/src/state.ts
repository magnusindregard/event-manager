import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// The OAuth `state` parameter: which account and user started the install, until when. Signed
// with a key derived from the app's client secret, so no table is needed. The admin's callback
// page posts it back with the code, and the API checks it was this user who started.

export interface OAuthState {
  tenantId: string;
  userId: string;
  expiresAt: Date;
}

const key = (clientSecret: string) => createHmac("sha256", clientSecret).update("em:oauth-state:v1").digest();
const mac = (k: Buffer, body: string) => createHmac("sha256", k).update(body).digest("base64url");

export function signState(clientSecret: string, s: Omit<OAuthState, "expiresAt">, ttlSeconds = 600, now = new Date()): string {
  const body = Buffer.from(JSON.stringify({ t: s.tenantId, u: s.userId, e: Math.floor(now.getTime() / 1000) + ttlSeconds, n: randomBytes(9).toString("base64url") })).toString("base64url");
  return `${body}.${mac(key(clientSecret), body)}`;
}

/** The state, or null if it is malformed, forged or expired. */
export function verifyState(clientSecret: string, state: string, now = new Date()): OAuthState | null {
  const [body, sig, extra] = state.split(".");
  if (!body || !sig || extra !== undefined) return null;
  const want = Buffer.from(mac(key(clientSecret), body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { t?: unknown; u?: unknown; e?: unknown };
    if (typeof p.t !== "string" || typeof p.u !== "string" || typeof p.e !== "number") return null;
    if (p.e * 1000 <= now.getTime()) return null;
    return { tenantId: p.t, userId: p.u, expiresAt: new Date(p.e * 1000) };
  } catch {
    return null;
  }
}
