import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { type ApiKeyKind, type Db, newId, sql, type Tx, withoutTenant, withTenant } from "@event-manager/db";
import { emit } from "../outbox/index.js";
import { type ActorContext, DomainError } from "../shared/index.js";
import { recordAudit } from "./audit.js";
import { assertCan } from "./permissions.js";

// Public API credentials (docs/mvp.md, "Public read API"):
//   publishable  pk_<id>_<secret>   in ?key=, identifies the tenant and its rate limit; safe in browsers
//   preview      prv_<id>_<secret>  in Authorization: Bearer, reads drafts; server-side only
//   channel      sk_<id>_<secret>   in Authorization: Bearer, held by a sales channel's connector;
//                                   server-side only (docs/ticketing.md, "Sales channel")
// The <id> part is stored as `prefix` and looked up across tenants by tenancy.resolve_api_key.
// Secrets are 32 random bytes, so a plain SHA-256 is enough; there is nothing to brute-force.

export interface ApiKey {
  id: string;
  kind: ApiKeyKind;
  prefix: string;
  label: string;
  /** Channel keys: the sales channel they belong to. */
  channelId: string | null;
  createdAt: Date;
  revokedAt: Date | null;
}

const PREFIX: Record<ApiKeyKind, string> = { publishable: "pk", preview: "prv", channel: "sk" };
const TOKEN_RE = /^(pk|prv|sk)_([A-Za-z0-9]{12})_([A-Za-z0-9_-]{43})$/;

const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");
const alnum = (n: number) => randomBytes(n * 2).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, n);

const keyColumns = ["id", "kind", "prefix", "label", "channel_id", "created_at", "revoked_at"] as const;
type KeyRow = { id: string; kind: ApiKeyKind; prefix: string; label: string; channel_id: string | null; created_at: Date; revoked_at: Date | null };
const toKey = (r: KeyRow): ApiKey => ({ id: r.id, kind: r.kind, prefix: r.prefix, label: r.label, channelId: r.channel_id, createdAt: r.created_at, revokedAt: r.revoked_at });

/** Public API keys, or with channelId the keys of that sales channel. */
export async function listApiKeys(tx: Tx, ctx: ActorContext, opts: { channelId?: string } = {}): Promise<ApiKey[]> {
  assertCan(ctx, "account.write");
  let q = tx.selectFrom("tenancy.api_key").select(keyColumns).orderBy("created_at", "desc");
  q = opts.channelId ? q.where("channel_id", "=", opts.channelId) : q.where("channel_id", "is", null);
  return (await q.execute()).map(toKey);
}

/** Channel keys need the channel; the offers module checks it exists and is active. */
export async function createApiKey(tx: Tx, ctx: ActorContext, kind: ApiKeyKind, label: string, channelId: string | null = null): Promise<ApiKey & { secret: string }> {
  assertCan(ctx, "account.write");
  if ((kind === "channel") !== (channelId !== null)) throw new DomainError("validation_failed", "Channel keys, and only they, belong to a sales channel", { field: "kind" });
  const prefix = `${PREFIX[kind]}_${alnum(12)}`;
  const secret = randomBytes(32).toString("base64url");
  const row = await tx
    .insertInto("tenancy.api_key")
    .values({ id: newId(), tenant_id: ctx.tenantId, kind, prefix, secret_hash: hash(secret), label, channel_id: channelId })
    .returning(keyColumns)
    .executeTakeFirstOrThrow();
  await recordAudit(tx, ctx, { action: "api_key.created", entityType: "api_key", entityId: row.id, diff: { kind, label, prefix, ...(channelId ? { channelId } : {}) } });
  await emit(tx, ctx.tenantId, { type: "api_key.changed.v1", subject: `api_key/${row.id}`, data: { id: row.id, change: "created" } });
  return { ...toKey(row), secret: `${prefix}_${secret}` };
}

/** With channelId, only a key of that channel is revoked. */
export async function revokeApiKey(tx: Tx, ctx: ActorContext, id: string, opts: { channelId?: string } = {}): Promise<void> {
  assertCan(ctx, "account.write");
  let q = tx.updateTable("tenancy.api_key").set({ revoked_at: sql<Date>`now()` }).where("id", "=", id).where("revoked_at", "is", null);
  if (opts.channelId) q = q.where("channel_id", "=", opts.channelId);
  const res = await q.executeTakeFirst();
  if (!res.numUpdatedRows) throw new DomainError("not_found", "Active API key not found");
  await recordAudit(tx, ctx, { action: "api_key.revoked", entityType: "api_key", entityId: id });
  await emit(tx, ctx.tenantId, { type: "api_key.changed.v1", subject: `api_key/${id}`, data: { id, change: "revoked" } });
}

export interface VerifiedApiKey {
  tenantId: string;
  kind: ApiKeyKind;
  /** Channel keys: their sales channel. Whether it is active is checked per request. */
  channelId: string | null;
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
  let channelId: string | null = null;
  if (row.kind === "channel") {
    // The key's own row, read in its tenant now that the secret has checked out.
    const k = await withTenant(db, { tenantId: row.tenant_id }, (tx) => tx.selectFrom("tenancy.api_key").select("channel_id").where("prefix", "=", prefix).executeTakeFirst());
    if (!k?.channel_id) return null;
    channelId = k.channel_id;
  }
  return { tenantId: row.tenant_id, kind: row.kind, channelId };
}
