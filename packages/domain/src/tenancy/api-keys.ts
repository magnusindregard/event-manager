import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { type ApiKeyKind, type Db, newId, sql, type Tx, withoutTenant } from "@event-manager/db";
import { emit } from "../outbox/index.js";
import { type ActorContext, DomainError } from "../shared/index.js";
import { recordAudit } from "./audit.js";
import { assertCan } from "./permissions.js";

// Public API credentials (docs/mvp.md, "Public read API"):
//   publishable  pk_<id>_<secret>   in ?key=, identifies the tenant and its rate limit; safe in browsers
//   preview      prv_<id>_<secret>  in Authorization: Bearer, reads drafts; server-side only
// The <id> part is stored as `prefix` and looked up across tenants by tenancy.resolve_api_key.
// Secrets are 32 random bytes, so a plain SHA-256 is enough; there is nothing to brute-force.

export interface ApiKey {
  id: string;
  kind: ApiKeyKind;
  prefix: string;
  label: string;
  createdAt: Date;
  revokedAt: Date | null;
}

const PREFIX: Record<ApiKeyKind, string> = { publishable: "pk", preview: "prv" };
const TOKEN_RE = /^(pk|prv)_([A-Za-z0-9]{12})_([A-Za-z0-9_-]{43})$/;

const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");
const alnum = (n: number) => randomBytes(n * 2).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, n);

export async function listApiKeys(tx: Tx, ctx: ActorContext): Promise<ApiKey[]> {
  assertCan(ctx, "account.write");
  const rows = await tx.selectFrom("tenancy.api_key").select(["id", "kind", "prefix", "label", "created_at", "revoked_at"]).orderBy("created_at", "desc").execute();
  return rows.map((r) => ({ id: r.id, kind: r.kind, prefix: r.prefix, label: r.label, createdAt: r.created_at, revokedAt: r.revoked_at }));
}

export async function createApiKey(tx: Tx, ctx: ActorContext, kind: ApiKeyKind, label: string): Promise<ApiKey & { secret: string }> {
  assertCan(ctx, "account.write");
  const prefix = `${PREFIX[kind]}_${alnum(12)}`;
  const secret = randomBytes(32).toString("base64url");
  const row = await tx
    .insertInto("tenancy.api_key")
    .values({ id: newId(), tenant_id: ctx.tenantId, kind, prefix, secret_hash: hash(secret), label })
    .returning(["id", "kind", "prefix", "label", "created_at", "revoked_at"])
    .executeTakeFirstOrThrow();
  await recordAudit(tx, ctx, { action: "api_key.created", entityType: "api_key", entityId: row.id, diff: { kind, label, prefix } });
  await emit(tx, ctx.tenantId, { type: "api_key.changed.v1", subject: `api_key/${row.id}`, data: { id: row.id, change: "created" } });
  return { id: row.id, kind: row.kind, prefix: row.prefix, label: row.label, createdAt: row.created_at, revokedAt: null, secret: `${prefix}_${secret}` };
}

export async function revokeApiKey(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  assertCan(ctx, "account.write");
  const res = await tx.updateTable("tenancy.api_key").set({ revoked_at: sql<Date>`now()` }).where("id", "=", id).where("revoked_at", "is", null).executeTakeFirst();
  if (!res.numUpdatedRows) throw new DomainError("not_found", "Active API key not found");
  await recordAudit(tx, ctx, { action: "api_key.revoked", entityType: "api_key", entityId: id });
  await emit(tx, ctx.tenantId, { type: "api_key.changed.v1", subject: `api_key/${id}`, data: { id, change: "revoked" } });
}

export interface VerifiedApiKey {
  tenantId: string;
  kind: ApiKeyKind;
}

/** Resolves a full key to its tenant, or null if it is malformed, unknown, revoked or of another kind. */
export async function verifyApiKey(db: Db, token: string, expected: ApiKeyKind): Promise<VerifiedApiKey | null> {
  const m = TOKEN_RE.exec(token);
  if (!m || m[1] !== PREFIX[expected]) return null;
  const prefix = `${m[1]}_${m[2]}`;
  const row = await withoutTenant(db, async (tx) => {
    const res = await sql<{ tenant_id: string; kind: ApiKeyKind; secret_hash: string }>`
      select tenant_id, kind::text as kind, secret_hash from tenancy.resolve_api_key(${prefix})`.execute(tx);
    return res.rows[0];
  });
  if (!row || row.kind !== expected) return null;
  const a = Buffer.from(hash(m[3]!), "hex");
  const b = Buffer.from(row.secret_hash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { tenantId: row.tenant_id, kind: row.kind };
}
