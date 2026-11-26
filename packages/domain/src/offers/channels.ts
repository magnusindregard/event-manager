import { type ChannelKind, newId, sql, type Tx } from "@event-manager/db";
import { emit } from "../outbox/index.js";
import { type ActorContext, DomainError } from "../shared/index.js";
import { assertCan, createApiKey, diffFields, listApiKeys, recordAudit, revokeApiKey, type ApiKey } from "../tenancy/index.js";

// Sales channels and SKUs (docs/ticketing.md, "Sales channel", "SKU mapping"). Each account
// sells through its own channels: its web shop, its POS. A channel's connector authenticates
// with a channel key, so reservations know which channel made them. The SKU mapping names the
// shop's product for a ticket line, per (VAT class, channel). Changing them takes account.write.

export interface SalesChannel {
  id: string;
  code: string;
  name: string;
  kind: ChannelKind;
  holdMinutes: number;
  sendTickets: boolean;
  active: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SalesChannelInput {
  code: string;
  name: string;
  kind: ChannelKind;
  holdMinutes?: number;
  sendTickets?: boolean;
}

export type SalesChannelPatch = Partial<Omit<SalesChannelInput, "code" | "kind">> & { active?: boolean };

const CODE_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const KINDS: readonly ChannelKind[] = ["ecom", "pos"];
const invalid = (field: string, message: string) => new DomainError("validation_failed", message, { field });

const columns = ["id", "code", "name", "kind", "hold_minutes", "send_tickets", "active", "version", "created_at", "updated_at"] as const;
type Row = { id: string; code: string; name: string; kind: ChannelKind; hold_minutes: number; send_tickets: boolean; active: boolean; version: number; created_at: Date; updated_at: Date };
const toChannel = (r: Row): SalesChannel => ({
  id: r.id, code: r.code, name: r.name, kind: r.kind, holdMinutes: r.hold_minutes, sendTickets: r.send_tickets, active: r.active,
  version: r.version, createdAt: r.created_at, updatedAt: r.updated_at,
});

function validateName(v: string | undefined) {
  if (v !== undefined && (!v?.trim() || v.trim().length > 200)) throw invalid("name", "Name the channel (at most 200 characters)");
}
function validateHold(v: number | undefined) {
  if (v !== undefined && (!Number.isInteger(v) || v < 1 || v > 60)) throw invalid("holdMinutes", "Must be a whole number of minutes, 1–60");
}

/** Active channels first, then by code. Readable by every member, like VAT classes. */
export async function listChannels(tx: Tx): Promise<SalesChannel[]> {
  const rows = await tx.selectFrom("offers.sales_channel").select(columns).orderBy("active", "desc").orderBy("code").execute();
  return rows.map(toChannel);
}

export async function getChannel(tx: Tx, id: string): Promise<SalesChannel> {
  const r = await tx.selectFrom("offers.sales_channel").select(columns).where("id", "=", id).executeTakeFirst();
  if (!r) throw new DomainError("not_found", "Sales channel not found");
  return toChannel(r);
}

export async function createChannel(tx: Tx, ctx: ActorContext, input: SalesChannelInput): Promise<SalesChannel> {
  assertCan(ctx, "account.write");
  if (!CODE_RE.test(input.code ?? "")) throw invalid("code", "Use lowercase letters, digits, - and _");
  // The hosted channel comes from enabling the checkout (enableHostedChannel), one per account.
  if (!KINDS.includes(input.kind)) throw invalid("kind", "ecom or pos");
  if (input.name === undefined) throw invalid("name", "Name the channel");
  validateName(input.name);
  validateHold(input.holdMinutes);
  const id = newId();
  try {
    await tx
      .insertInto("offers.sales_channel")
      .values({ id, tenant_id: ctx.tenantId, code: input.code, name: input.name.trim(), kind: input.kind, hold_minutes: input.holdMinutes, send_tickets: input.sendTickets })
      .execute();
  } catch (e) {
    if (typeof e === "object" && e !== null && (e as { code?: string }).code === "23505") throw new DomainError("conflict", "Another channel uses this code", { field: "code" });
    throw e;
  }
  await recordAudit(tx, ctx, { action: "sales_channel.created", entityType: "account", entityId: ctx.tenantId, diff: { id, code: input.code, kind: input.kind } });
  await emit(tx, ctx.tenantId, { type: "sales_channel.changed.v1", subject: `sales-channel/${id}`, data: { id, change: "created" } });
  return getChannel(tx, id);
}

/** Deactivating a channel stops its keys working and takes its offers off sale there. */
export async function updateChannel(tx: Tx, ctx: ActorContext, id: string, expectedVersion: number, patch: SalesChannelPatch): Promise<SalesChannel> {
  assertCan(ctx, "account.write");
  validateName(patch.name);
  validateHold(patch.holdMinutes);
  const before = await getChannel(tx, id);
  const res = await tx
    .updateTable("offers.sales_channel")
    .set({ name: patch.name?.trim(), hold_minutes: patch.holdMinutes, send_tickets: patch.sendTickets, active: patch.active, version: sql<number>`version + 1` })
    .where("id", "=", id)
    .where("version", "=", expectedVersion)
    .executeTakeFirst();
  if (!res.numUpdatedRows) throw new DomainError("version_conflict", "Sales channel was changed by someone else", { currentVersion: before.version });
  const after = await getChannel(tx, id);
  const diff = diffFields(before as unknown as Record<string, unknown>, patch as Record<string, unknown>);
  await recordAudit(tx, ctx, { action: "sales_channel.updated", entityType: "account", entityId: ctx.tenantId, diff: { id, code: before.code, ...diff } });
  await emit(tx, ctx.tenantId, { type: "sales_channel.changed.v1", subject: `sales-channel/${id}`, data: { id, change: "updated" } });
  return after;
}

// ── The hosted checkout's channel ───────────────────────────────────────────────

/** The code of the hosted checkout's channel (docs/checkout.md); staff cannot create kind hosted themselves. */
export const HOSTED_CHANNEL_CODE = "hosted-checkout";
/** At least this long, so the hold outlives the Vipps payment (the buyer has a few minutes to approve). */
export const HOSTED_HOLD_MINUTES = 20;

/** The account's hosted checkout channel, active or not; null until the checkout is enabled. */
export async function hostedChannel(tx: Tx): Promise<SalesChannel | null> {
  const r = await tx.selectFrom("offers.sales_channel").select(columns).where("kind", "=", "hosted").executeTakeFirst();
  return r ? toChannel(r) : null;
}

/**
 * Enables the hosted checkout (owner): creates its channel, or activates it again. The channel
 * emails the tickets. VAT classes without a SKU on it get a default one (TICKET-<code>), which
 * staff can change. Offers are then put on sale there like on any channel.
 */
export async function enableHostedChannel(tx: Tx, ctx: ActorContext): Promise<SalesChannel> {
  assertCan(ctx, "account.write");
  let channel = await hostedChannel(tx);
  if (!channel) {
    const id = newId();
    const taken = await tx.selectFrom("offers.sales_channel").select("id").where("code", "=", HOSTED_CHANNEL_CODE).executeTakeFirst();
    await tx.insertInto("offers.sales_channel").values({
      id, tenant_id: ctx.tenantId, code: taken ? `${HOSTED_CHANNEL_CODE}-${id.slice(-6)}` : HOSTED_CHANNEL_CODE, name: "Checkout", kind: "hosted",
      hold_minutes: HOSTED_HOLD_MINUTES, send_tickets: true,
    }).execute();
    await recordAudit(tx, ctx, { action: "sales_channel.created", entityType: "account", entityId: ctx.tenantId, diff: { id, code: HOSTED_CHANNEL_CODE, kind: "hosted" } });
    await emit(tx, ctx.tenantId, { type: "sales_channel.changed.v1", subject: `sales-channel/${id}`, data: { id, change: "created" } });
    channel = await getChannel(tx, id);
  } else if (!channel.active) {
    channel = await updateChannel(tx, ctx, channel.id, channel.version, { active: true });
  }
  const mapped = new Set((await listSkuMappings(tx)).filter((m) => m.channelId === channel.id).map((m) => m.vatClassId));
  const vat = await tx.selectFrom("offers.vat_class").select(["id", "code"]).execute();
  for (const v of vat.filter((x) => !mapped.has(x.id))) {
    await setSkuMapping(tx, ctx, v.id, channel.id, `TICKET-${v.code.toUpperCase()}`.slice(0, 100));
  }
  return channel;
}

// ── Channel keys ───────────────────────────────────────────────────────────────

export async function listChannelKeys(tx: Tx, ctx: ActorContext, channelId: string): Promise<ApiKey[]> {
  assertCan(ctx, "account.write");
  await getChannel(tx, channelId);
  return listApiKeys(tx, ctx, { channelId });
}

/** The full secret is returned once. Only active channels get new keys. */
export async function createChannelKey(tx: Tx, ctx: ActorContext, channelId: string, label: string): Promise<ApiKey & { secret: string }> {
  assertCan(ctx, "account.write");
  const channel = await getChannel(tx, channelId);
  if (!channel.active) throw new DomainError("conflict", "The channel is inactive; activate it first");
  // The hosted checkout reserves and settles by itself; a key would let a shop cancel its paid tickets without a refund.
  if (channel.kind === "hosted") throw new DomainError("conflict", "The hosted checkout's channel takes no keys");
  if (!label?.trim() || label.trim().length > 100) throw invalid("label", "Label the key (at most 100 characters)");
  return createApiKey(tx, ctx, "channel", label.trim(), channelId);
}

export async function revokeChannelKey(tx: Tx, ctx: ActorContext, channelId: string, keyId: string): Promise<void> {
  await revokeApiKey(tx, ctx, keyId, { channelId });
}

/**
 * The channel a channel key acts for, if it may act now. Called per request inside the
 * caller's tenant transaction, so deactivating a channel stops its keys at once.
 */
export async function activeChannel(tx: Tx, channelId: string): Promise<SalesChannel | null> {
  const r = await tx.selectFrom("offers.sales_channel").select(columns).where("id", "=", channelId).where("active", "=", true).executeTakeFirst();
  return r ? toChannel(r) : null;
}

// ── SKU mapping ────────────────────────────────────────────────────────────────

export interface SkuMapping {
  vatClassId: string;
  channelId: string;
  externalSku: string;
  updatedAt: Date;
}

export async function listSkuMappings(tx: Tx): Promise<SkuMapping[]> {
  const rows = await tx.selectFrom("offers.sku_mapping").select(["vat_class_id", "channel_id", "external_sku", "updated_at"]).orderBy("channel_id").orderBy("vat_class_id").execute();
  return rows.map((r) => ({ vatClassId: r.vat_class_id, channelId: r.channel_id, externalSku: r.external_sku, updatedAt: r.updated_at }));
}

/** Sets the SKU for a (VAT class, channel), or with null removes it. Returns the mapping, or null once removed. */
export async function setSkuMapping(tx: Tx, ctx: ActorContext, vatClassId: string, channelId: string, externalSku: string | null): Promise<SkuMapping | null> {
  assertCan(ctx, "account.write");
  await getChannel(tx, channelId);
  const vat = await tx.selectFrom("offers.vat_class").select("id").where("id", "=", vatClassId).executeTakeFirst();
  if (!vat) throw new DomainError("not_found", "VAT class not found");
  const before = await tx.selectFrom("offers.sku_mapping").select("external_sku").where("vat_class_id", "=", vatClassId).where("channel_id", "=", channelId).executeTakeFirst();
  let sku: string | null = null;
  if (externalSku === null) {
    await tx.deleteFrom("offers.sku_mapping").where("vat_class_id", "=", vatClassId).where("channel_id", "=", channelId).execute();
  } else {
    sku = externalSku.trim();
    if (!sku || sku.length > 100) throw invalid("externalSku", "Give the SKU (at most 100 characters)");
    await tx
      .insertInto("offers.sku_mapping")
      .values({ tenant_id: ctx.tenantId, vat_class_id: vatClassId, channel_id: channelId, external_sku: sku })
      .onConflict((oc) => oc.columns(["vat_class_id", "channel_id"]).doUpdateSet({ external_sku: sku! }))
      .execute();
  }
  if ((before?.external_sku ?? null) !== sku) {
    await recordAudit(tx, ctx, { action: "sku_mapping.changed", entityType: "account", entityId: ctx.tenantId, diff: { vatClassId, channelId, externalSku: { from: before?.external_sku ?? null, to: sku } } });
    await emit(tx, ctx.tenantId, { type: "sku_mapping.changed.v1", subject: `sales-channel/${channelId}`, data: { vatClassId, channelId, change: sku === null ? "removed" : "set" } });
  }
  if (sku === null) return null;
  const r = await tx.selectFrom("offers.sku_mapping").select(["vat_class_id", "channel_id", "external_sku", "updated_at"]).where("vat_class_id", "=", vatClassId).where("channel_id", "=", channelId).executeTakeFirstOrThrow();
  return { vatClassId: r.vat_class_id, channelId: r.channel_id, externalSku: r.external_sku, updatedAt: r.updated_at };
}
