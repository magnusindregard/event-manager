import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Tx } from "@event-manager/db";

// Attendee links (ADR 0005: no accounts, signed single-purpose tokens). A token names its
// tenant, purpose, subject and token version, signed with the tenant's own key:
//
//   [format 1][purpose 1][tenant 16][subject 16][token version 4][HMAC-SHA256 truncated 16]
//
// 54 bytes, 72 characters base64url, small enough for a QR code. The tenant is readable
// before verification, so the caller can open that tenant's transaction and check the
// signature with its key. Bumping the subject's token version invalidates its old links.

export type TokenPurpose = "manage" | "admission" | "invitation" | "ticket";

const FORMAT = 1;
const PURPOSES: Record<TokenPurpose, number> = { manage: 1, admission: 2, invitation: 3, ticket: 4 };
const BODY = 38;
const MAC = 16;

export interface TokenClaims {
  tenantId: string;
  purpose: TokenPurpose;
  subjectId: string;
  tokenVersion: number;
}

const uuidBytes = (id: string) => Buffer.from(id.replace(/-/g, ""), "hex");
const uuidString = (b: Buffer) => {
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

/** Pure: signs claims with a key. */
export function signClaims(key: Buffer, c: TokenClaims): string {
  const body = Buffer.alloc(BODY);
  body[0] = FORMAT;
  body[1] = PURPOSES[c.purpose];
  uuidBytes(c.tenantId).copy(body, 2);
  uuidBytes(c.subjectId).copy(body, 18);
  body.writeUInt32BE(c.tokenVersion, 34);
  const mac = createHmac("sha256", key).update(body).digest().subarray(0, MAC);
  return Buffer.concat([body, mac]).toString("base64url");
}

/** Pure: the claims of a well-formed token, unverified. Use only to pick the tenant. */
export function peekToken(token: string): TokenClaims | null {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{72}$/.test(token)) return null;
  const raw = Buffer.from(token, "base64url");
  if (raw.length !== BODY + MAC || raw[0] !== FORMAT) return null;
  const purpose = (Object.keys(PURPOSES) as TokenPurpose[]).find((p) => PURPOSES[p] === raw[1]);
  if (!purpose) return null;
  return { tenantId: uuidString(raw.subarray(2, 18)), purpose, subjectId: uuidString(raw.subarray(18, 34)), tokenVersion: raw.readUInt32BE(34) };
}

/** Pure: verifies a token's signature and purpose with a key. */
export function verifyWithKey(key: Buffer, token: string, purpose: TokenPurpose): TokenClaims | null {
  const claims = peekToken(token);
  if (!claims || claims.purpose !== purpose) return null;
  const raw = Buffer.from(token, "base64url");
  const expected = createHmac("sha256", key).update(raw.subarray(0, BODY)).digest().subarray(0, MAC);
  return timingSafeEqual(expected, raw.subarray(BODY)) ? claims : null;
}

/** The tenant's signing key, created on first use. Runs in the tenant's transaction. */
async function tenantKey(tx: Tx, tenantId: string): Promise<Buffer> {
  const existing = await tx.selectFrom("registration.token_key").select("key").executeTakeFirst();
  if (existing) return existing.key;
  await tx.insertInto("registration.token_key").values({ tenant_id: tenantId, key: randomBytes(32) }).onConflict((oc) => oc.doNothing()).execute();
  return (await tx.selectFrom("registration.token_key").select("key").executeTakeFirstOrThrow()).key;
}

export async function issueToken(tx: Tx, tenantId: string, purpose: TokenPurpose, subjectId: string, tokenVersion: number): Promise<string> {
  return signClaims(await tenantKey(tx, tenantId), { tenantId, purpose, subjectId, tokenVersion });
}

/** Verifies a token in its tenant's transaction (open it with peekToken(token).tenantId). */
export async function verifyToken(tx: Tx, token: string, purpose: TokenPurpose): Promise<TokenClaims | null> {
  const claims = peekToken(token);
  if (!claims) return null;
  return verifyWithKey(await tenantKey(tx, claims.tenantId), token, purpose);
}

