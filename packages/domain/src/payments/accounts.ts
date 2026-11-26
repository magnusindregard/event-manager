import { type Db, newId, sql, type Tx, withTenant } from "@event-manager/db";
import { emit } from "../outbox/index.js";
import { type ActorContext, decryptJson, DomainError, encryptJson } from "../shared/index.js";
import { assertCan, recordAudit } from "../tenancy/index.js";
import { type PaymentProvider, type ProviderCredentials, type ProviderEnvironment, providerMessage, refusedKeys } from "./provider.js";

// Provider accounts (docs/checkout.md, "Connecting Vipps MobilePay"). Each account sells on its
// own Vipps merchant: an owner enters the merchant serial number and the keys from the Vipps
// portal. The keys are checked by fetching a token before they are stored, and stored encrypted
// with the account's data key, bound to the provider account's id. Verifying also registers
// the webhook, when the platform has a public URL for it. Disconnecting keeps the row (who,
// when, which merchant) and deletes the keys.

export type ProviderAccountStatus = "active" | "invalid" | "disconnected";

export interface ProviderAccount {
  id: string;
  provider: "vipps";
  environment: ProviderEnvironment;
  merchantSerialNumber: string;
  clientId: string;
  status: ProviderAccountStatus;
  statusReason: string | null;
  webhookRegistered: boolean;
  verifiedAt: Date | null;
  connectedAt: Date;
  disconnectedAt: Date | null;
  version: number;
  updatedAt: Date;
}

export interface ConnectVippsInput {
  environment: ProviderEnvironment;
  merchantSerialNumber: string;
  clientId: string;
  clientSecret: string;
  subscriptionKey: string;
}

export interface ProviderDeps {
  provider: PaymentProvider;
  /** The webhook URL for a provider account, or null where the platform has no public URL (local stacks). */
  webhookUrl: ((tenantId: string, providerAccountId: string) => string) | null;
}

type Secrets = { clientSecret: string; subscriptionKey: string };

const columns = [
  "id", "provider", "environment", "merchant_serial_number", "client_id", "status", "status_reason", "webhook_id",
  "verified_at", "connected_at", "disconnected_at", "version", "updated_at",
] as const;
type Row = {
  id: string; provider: "vipps"; environment: ProviderEnvironment; merchant_serial_number: string; client_id: string; status: ProviderAccountStatus;
  status_reason: string | null; webhook_id: string | null; verified_at: Date | null; connected_at: Date; disconnected_at: Date | null; version: number; updated_at: Date;
};
const toAccount = (r: Row): ProviderAccount => ({
  id: r.id, provider: r.provider, environment: r.environment, merchantSerialNumber: r.merchant_serial_number, clientId: r.client_id,
  status: r.status, statusReason: r.status_reason, webhookRegistered: r.webhook_id !== null, verifiedAt: r.verified_at,
  connectedAt: r.connected_at, disconnectedAt: r.disconnected_at, version: r.version, updatedAt: r.updated_at,
});

const credentialsAad = (tenantId: string, id: string) => `payments-credentials:${tenantId}:${id}`;
const webhookAad = (tenantId: string, id: string) => `payments-webhook:${tenantId}:${id}`;
const invalid = (field: string, message: string) => new DomainError("validation_failed", message, { field });

function validate(input: ConnectVippsInput): ConnectVippsInput {
  const v = {
    environment: input.environment,
    merchantSerialNumber: input.merchantSerialNumber?.trim() ?? "",
    clientId: input.clientId?.trim() ?? "",
    clientSecret: input.clientSecret?.trim() ?? "",
    subscriptionKey: input.subscriptionKey?.trim() ?? "",
  };
  if (v.environment !== "test" && v.environment !== "production") throw invalid("environment", "test or production");
  if (!/^[0-9]{4,10}$/.test(v.merchantSerialNumber)) throw invalid("merchantSerialNumber", "The merchant serial number (MSN) is 4–10 digits");
  if (!v.clientId || v.clientId.length > 200) throw invalid("clientId", "Give the client id from the Vipps portal");
  if (!v.clientSecret || v.clientSecret.length > 500) throw invalid("clientSecret", "Give the client secret from the Vipps portal");
  if (!v.subscriptionKey || v.subscriptionKey.length > 500) throw invalid("subscriptionKey", "Give the subscription key (Ocp-Apim-Subscription-Key) from the Vipps portal");
  return v;
}

/** The account's connected Vipps merchant, or null. Readable by every member. */
export async function getProviderAccount(tx: Tx): Promise<ProviderAccount | null> {
  const r = await tx.selectFrom("payments.provider_account").select(columns).where("provider", "=", "vipps").where("status", "<>", "disconnected").executeTakeFirst();
  return r ? toAccount(r) : null;
}

export async function getProviderAccountById(tx: Tx, id: string): Promise<ProviderAccount> {
  const r = await tx.selectFrom("payments.provider_account").select(columns).where("id", "=", id).executeTakeFirst();
  if (!r) throw new DomainError("not_found", "Payment provider account not found");
  return toAccount(r);
}

/** The account's keys, decrypted, for a call to the provider. Null once disconnected. */
export async function credentialsFor(tx: Tx, tenantId: string, id: string): Promise<ProviderCredentials | null> {
  const r = await tx.selectFrom("payments.provider_account")
    .select(["environment", "merchant_serial_number", "client_id", "credentials"]).where("id", "=", id).executeTakeFirst();
  if (!r?.credentials) return null;
  const s = (await decryptJson(tx, tenantId, credentialsAad(tenantId, id), r.credentials)) as Secrets;
  return { environment: r.environment, merchantSerialNumber: r.merchant_serial_number, clientId: r.client_id, clientSecret: s.clientSecret, subscriptionKey: s.subscriptionKey };
}

/** The secret that signs the provider account's webhooks; null when none is registered. */
export async function webhookSecretFor(tx: Tx, tenantId: string, id: string): Promise<string | null> {
  const r = await tx.selectFrom("payments.provider_account").select(["webhook_secret", "status"]).where("id", "=", id).executeTakeFirst();
  if (!r?.webhook_secret || r.status === "disconnected") return null;
  return (await decryptJson(tx, tenantId, webhookAad(tenantId, id), r.webhook_secret)) as string;
}

/**
 * Connects the account's Vipps merchant (owner). The keys are checked with Vipps first and
 * refused if Vipps refuses them.
 *
 * Payments belong to the provider account they were made on, so its keys must stay reachable
 * while those payments settle or are refunded:
 *   - The same merchant again (same serial number and environment, connected now or before)
 *     reuses its provider account: the new keys replace the old ones in place, and its payments,
 *     even from before a disconnect, settle and refund with them.
 *   - Another merchant replaces the connected one. The old one is retired: no longer used for new
 *     payments and its webhook removed, but its keys are kept for the payments made on it.
 */
export async function connectVipps(db: Db, ctx: ActorContext, input: ConnectVippsInput, deps: ProviderDeps): Promise<ProviderAccount> {
  assertCan(ctx, "account.write");
  const creds = validate(input);
  try {
    await deps.provider.verifyCredentials(creds);
  } catch (e) {
    if (refusedKeys(e)) throw new DomainError("validation_failed", "Vipps refused these keys. Check the merchant serial number, the keys and test or production.", { field: "clientSecret" });
    throw new DomainError("conflict", `Vipps could not be reached; try again. (${providerMessage(e)})`);
  }

  const { id, retired, hasWebhook } = await withTenant(db, ctx, async (tx) => {
    const rows = await tx.selectFrom("payments.provider_account").select(["id", "status", "environment", "merchant_serial_number", "webhook_id"])
      .where("provider", "=", "vipps").orderBy("connected_at", "desc").forUpdate().execute();
    const current = rows.find((r) => r.status !== "disconnected") ?? null;
    const same = rows.find((r) => r.environment === creds.environment && r.merchant_serial_number === creds.merchantSerialNumber) ?? null;
    let retired: { creds: ProviderCredentials | null; webhookId: string } | null = null;
    if (current && current.id !== same?.id) {
      // Retire the other merchant first: at most one is connected (provider_account_connected).
      retired = current.webhook_id ? { creds: await credentialsFor(tx, ctx.tenantId, current.id), webhookId: current.webhook_id } : null;
      await markDisconnected(tx, current.id, "Replaced by another merchant; kept for the payments made on it", { keepCredentials: true });
    }
    const id = same?.id ?? newId();
    const sealed = await encryptJson(tx, ctx.tenantId, credentialsAad(ctx.tenantId, id), { clientSecret: creds.clientSecret, subscriptionKey: creds.subscriptionKey } satisfies Secrets);
    const now = new Date();
    if (same) {
      await tx.updateTable("payments.provider_account").set({
        client_id: creds.clientId, credentials: sealed, status: "active", status_reason: null, verified_at: now, connected_by: ctx.userId, connected_at: now,
        disconnected_at: null, version: sql<number>`version + 1`,
      }).where("id", "=", id).execute();
    } else {
      await tx.insertInto("payments.provider_account").values({
        id, tenant_id: ctx.tenantId, provider: "vipps", environment: creds.environment, merchant_serial_number: creds.merchantSerialNumber,
        client_id: creds.clientId, credentials: sealed, status: "active", verified_at: now, connected_by: ctx.userId, connected_at: now,
      }).execute();
    }
    await recordAudit(tx, ctx, {
      action: "payments.provider_connected", entityType: "account", entityId: ctx.tenantId,
      diff: { id, provider: "vipps", environment: creds.environment, merchantSerialNumber: creds.merchantSerialNumber, reused: !!same, replaced: current && current.id !== id ? current.id : null },
    });
    await emit(tx, ctx.tenantId, { type: "payments.provider_account.changed.v1", subject: `payment-provider-account/${id}`, data: { id, change: "connected" } });
    return { id, retired, hasWebhook: !!same?.webhook_id && same.status !== "disconnected" };
  });

  if (retired?.creds) await deps.provider.deleteWebhook(retired.creds, retired.webhookId).catch(() => undefined);
  // The merchant's webhook belongs to the merchant, not the keys: one still registered stays.
  if (!hasWebhook) await registerWebhook(db, ctx.tenantId, id, creds, deps);
  return withTenant(db, ctx, (tx) => getProviderAccountById(tx, id));
}

/**
 * Checks the stored keys again (owner): active when Vipps accepts them, invalid with the reason
 * when it refuses them. Registers the webhook if it is missing.
 */
export async function verifyVipps(db: Db, ctx: ActorContext, deps: ProviderDeps): Promise<ProviderAccount> {
  assertCan(ctx, "account.write");
  const { account, creds } = await withTenant(db, ctx, async (tx) => {
    const account = await getProviderAccount(tx);
    if (!account) throw new DomainError("not_found", "Vipps MobilePay is not connected");
    return { account, creds: (await credentialsFor(tx, ctx.tenantId, account.id))! };
  });
  let status: ProviderAccountStatus = "active";
  let reason: string | null = null;
  try {
    await deps.provider.verifyCredentials(creds);
  } catch (e) {
    if (!refusedKeys(e)) throw new DomainError("conflict", `Vipps could not be reached; try again. (${providerMessage(e)})`);
    status = "invalid";
    reason = `Vipps refused the keys: ${providerMessage(e)}`.slice(0, 500);
  }
  await withTenant(db, ctx, async (tx) => {
    await tx.updateTable("payments.provider_account")
      .set({ status, status_reason: reason, verified_at: status === "active" ? new Date() : undefined, version: sql<number>`version + 1` })
      .where("id", "=", account.id).where("status", "<>", "disconnected").execute();
    if (status !== account.status) {
      await recordAudit(tx, ctx, { action: "payments.provider_verified", entityType: "account", entityId: ctx.tenantId, diff: { id: account.id, status: { from: account.status, to: status } } });
      await emit(tx, ctx.tenantId, { type: "payments.provider_account.changed.v1", subject: `payment-provider-account/${account.id}`, data: { id: account.id, change: status } });
    }
  });
  if (status === "active" && !account.webhookRegistered) await registerWebhook(db, ctx.tenantId, account.id, creds, deps);
  return withTenant(db, ctx, (tx) => getProviderAccountById(tx, account.id));
}

/**
 * Disconnects the merchant (owner): deletes the keys here and the webhook at Vipps. Refused while
 * payments made on it are still settling. Payments already made stay; refunding them needs the
 * same merchant connected again, which brings back its provider account.
 */
export async function disconnectVipps(db: Db, ctx: ActorContext, expectedVersion: number, deps: ProviderDeps): Promise<void> {
  assertCan(ctx, "account.write");
  const old = await withTenant(db, ctx, async (tx) => {
    const account = await getProviderAccount(tx);
    if (!account) throw new DomainError("not_found", "Vipps MobilePay is not connected");
    if (account.version !== expectedVersion) throw new DomainError("version_conflict", "The Vipps connection was changed by someone else", { currentVersion: account.version });
    const open = await tx.selectFrom("payments.payment").select((eb) => eb.fn.countAll<number>().as("n"))
      .where("provider_account_id", "=", account.id).where("state", "in", ["created", "authorized"]).executeTakeFirstOrThrow();
    if (Number(open.n) > 0) {
      throw new DomainError("conflict", `${open.n} payment(s) made with this merchant are still settling; disconnect again once they have`, { openPayments: Number(open.n) });
    }
    const creds = await credentialsFor(tx, ctx.tenantId, account.id);
    const { webhook_id } = await tx.selectFrom("payments.provider_account").select("webhook_id").where("id", "=", account.id).executeTakeFirstOrThrow();
    await markDisconnected(tx, account.id, null, { keepCredentials: false });
    await recordAudit(tx, ctx, { action: "payments.provider_disconnected", entityType: "account", entityId: ctx.tenantId, diff: { id: account.id, merchantSerialNumber: account.merchantSerialNumber } });
    await emit(tx, ctx.tenantId, { type: "payments.provider_account.changed.v1", subject: `payment-provider-account/${account.id}`, data: { id: account.id, change: "disconnected" } });
    return { creds, webhookId: webhook_id };
  });
  if (old.creds && old.webhookId) await deps.provider.deleteWebhook(old.creds, old.webhookId).catch(() => undefined);
}

async function markDisconnected(tx: Tx, id: string, reason: string | null, opts: { keepCredentials: boolean }) {
  await tx.updateTable("payments.provider_account")
    .set({
      status: "disconnected", status_reason: reason, ...(opts.keepCredentials ? {} : { credentials: null }),
      webhook_id: null, webhook_secret: null, disconnected_at: new Date(), version: sql<number>`version + 1`,
    })
    .where("id", "=", id).execute();
}

/** Registers the webhook and stores its secret. A failure is kept as the status reason; the reconcile job polls meanwhile. */
async function registerWebhook(db: Db, tenantId: string, id: string, creds: ProviderCredentials, deps: ProviderDeps): Promise<void> {
  if (!deps.webhookUrl) return;
  let hook: { id: string; secret: string };
  try {
    hook = await deps.provider.registerWebhook(creds, deps.webhookUrl(tenantId, id));
  } catch (e) {
    await withTenant(db, { tenantId }, (tx) => tx.updateTable("payments.provider_account")
      .set({ status_reason: `The webhook could not be registered; payments are checked by polling. (${providerMessage(e)})`.slice(0, 500) })
      .where("id", "=", id).execute());
    return;
  }
  const stored = await withTenant(db, { tenantId }, async (tx) => {
    const res = await tx.updateTable("payments.provider_account")
      .set({ webhook_id: hook.id, webhook_secret: await encryptJson(tx, tenantId, webhookAad(tenantId, id), hook.secret), status_reason: null })
      .where("id", "=", id).where("status", "<>", "disconnected").executeTakeFirst();
    return Number(res.numUpdatedRows) > 0;
  });
  // Disconnected meanwhile: take the webhook away again.
  if (!stored) await deps.provider.deleteWebhook(creds, hook.id).catch(() => undefined);
}
