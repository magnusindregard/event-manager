import { type ConnectionStatus, type IntegrationProvider, newId, sql, type Tx } from "@event-manager/db";
import { emit } from "../outbox/index.js";
import { type ActorContext, decryptJson, DomainError, encryptJson } from "../shared/index.js";
import { assertCan, diffFields, recordAudit } from "../tenancy/index.js";

// Connections to the account's outside systems (docs/hubspot.md, ADR 0017). One per account
// and provider. The module stores what the connection is (portal, scopes, settings, setup
// state) and its OAuth tokens, encrypted with the account's data key; the API and the worker
// make the calls to the provider. Disconnecting keeps the row and deletes the tokens.

export type { ConnectionStatus, IntegrationProvider };

export interface ConnectionSettings {
  /** Upsert invited guests as contacts (default on). */
  syncInvitedGuests: boolean;
  /** Upsert attendees of open registration as contacts (default off). */
  syncOpenAttendees: boolean;
}

export interface Connection {
  id: string;
  provider: IntegrationProvider;
  status: ConnectionStatus;
  /** HubSpot: the portal (hub) id. */
  portalId: string;
  scopes: string[];
  settings: ConnectionSettings;
  setup: { status: "pending" | "done" | "failed"; error: string | null; at: Date | null };
  /** Why the connection needs reconnecting. */
  statusReason: string | null;
  connectedBy: string | null;
  connectedAt: Date;
  disconnectedAt: Date | null;
  version: number;
  updatedAt: Date;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
}

const DEFAULT_SETTINGS: ConnectionSettings = { syncInvitedGuests: true, syncOpenAttendees: false };

const columns = [
  "id", "provider", "status", "external_account_id", "scopes", "settings", "setup_status", "setup_error", "setup_at",
  "status_reason", "connected_by", "connected_at", "disconnected_at", "version", "updated_at",
] as const;

type Row = {
  id: string; provider: IntegrationProvider; status: ConnectionStatus; external_account_id: string; scopes: string[]; settings: unknown;
  setup_status: "pending" | "done" | "failed"; setup_error: string | null; setup_at: Date | null; status_reason: string | null;
  connected_by: string | null; connected_at: Date; disconnected_at: Date | null; version: number; updated_at: Date;
};

const toConnection = (r: Row): Connection => ({
  id: r.id,
  provider: r.provider,
  status: r.status,
  portalId: r.external_account_id,
  scopes: r.scopes,
  settings: { ...DEFAULT_SETTINGS, ...(r.settings as Partial<ConnectionSettings>) },
  setup: { status: r.setup_status, error: r.setup_error, at: r.setup_at },
  statusReason: r.status_reason,
  connectedBy: r.connected_by,
  connectedAt: r.connected_at,
  disconnectedAt: r.disconnected_at,
  version: r.version,
  updatedAt: r.updated_at,
});

const credentialAad = (tenantId: string, connectionId: string) => `integration-credential:${tenantId}:${connectionId}`;

async function load(tx: Tx, provider: IntegrationProvider, lock = false): Promise<Connection | null> {
  let q = tx.selectFrom("integrations.connection").select(columns).where("provider", "=", provider);
  if (lock) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  return row ? toConnection(row as Row) : null;
}

async function writeTokens(tx: Tx, tenantId: string, connectionId: string, tokens: Tokens): Promise<void> {
  const ciphertext = await encryptJson(tx, tenantId, credentialAad(tenantId, connectionId), { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
  await tx
    .insertInto("integrations.credential")
    .values({ connection_id: connectionId, tenant_id: tenantId, ciphertext, access_expires_at: tokens.accessExpiresAt })
    .onConflict((oc) => oc.column("connection_id").doUpdateSet({ ciphertext, access_expires_at: tokens.accessExpiresAt, updated_at: sql<Date>`now()` }))
    .execute();
}

// ── Staff ────────────────────────────────────────────────────────────────────

/** The account's connections, disconnected ones included (the admin shows who and when). */
export async function listConnections(tx: Tx, ctx: ActorContext): Promise<Connection[]> {
  assertCan(ctx, "content.read");
  const rows = await tx.selectFrom("integrations.connection").select(columns).orderBy("provider").execute();
  return rows.map((r) => toConnection(r as Row));
}

export async function getConnection(tx: Tx, ctx: ActorContext, provider: IntegrationProvider): Promise<Connection | null> {
  assertCan(ctx, "content.read");
  return load(tx, provider);
}

export interface ConnectInput {
  provider: IntegrationProvider;
  portalId: string;
  scopes: string[];
  tokens: Tokens;
  /** Scopes the connection cannot work without; refused if any is missing. */
  requiredScopes: readonly string[];
}

/**
 * Stores a connection after the owner approved the install (owner). Reconnecting the same
 * portal (after a refused token, or after disconnecting) reuses the row; switching to another
 * portal needs a disconnect first, so ids synced to one portal are never sent to another.
 */
export async function saveConnection(tx: Tx, ctx: ActorContext, input: ConnectInput): Promise<Connection> {
  assertCan(ctx, "account.write");
  const missing = input.requiredScopes.filter((s) => !input.scopes.includes(s));
  if (missing.length) throw new DomainError("validation_failed", `The install did not grant ${missing.join(", ")}`, { field: "scopes", missing });
  const before = await load(tx, input.provider, true);
  if (before && before.status !== "disconnected" && before.portalId !== input.portalId) {
    throw new DomainError("conflict", `The account is connected to portal ${before.portalId}. Disconnect it first`, { portalId: before.portalId });
  }
  const values = {
    status: "active" as const,
    external_account_id: input.portalId,
    scopes: [...new Set(input.scopes)].sort(),
    setup_status: "pending" as const,
    setup_error: null,
    status_reason: null,
    connected_by: ctx.userId,
    connected_at: new Date(),
    disconnected_at: null,
  };
  let id: string;
  if (before) {
    id = before.id;
    await tx.updateTable("integrations.connection").set({ ...values, version: sql<number>`version + 1` }).where("id", "=", id).execute();
  } else {
    id = newId();
    await tx.insertInto("integrations.connection").values({ id, tenant_id: ctx.tenantId, provider: input.provider, ...values }).execute();
  }
  await writeTokens(tx, ctx.tenantId, id, input.tokens);
  await recordAudit(tx, ctx, { action: "integration.connected", entityType: "account", entityId: ctx.tenantId, diff: { provider: input.provider, portalId: input.portalId, scopes: values.scopes } });
  await emit(tx, ctx.tenantId, { type: "integration.connected.v1", subject: `integration/${input.provider}`, data: { connectionId: id, provider: input.provider, portalId: input.portalId } });
  return (await load(tx, input.provider))!;
}

/**
 * Disconnects (owner): sync stops and the tokens are deleted. Returns the refresh token, so
 * the caller can revoke it at the provider after the commit; null if there was none.
 */
export async function disconnect(tx: Tx, ctx: ActorContext, provider: IntegrationProvider): Promise<{ refreshToken: string | null }> {
  assertCan(ctx, "account.write");
  const before = await load(tx, provider, true);
  if (!before || before.status === "disconnected") throw new DomainError("not_found", "Not connected");
  const tokens = await readTokens(tx, ctx.tenantId, before.id);
  await tx.deleteFrom("integrations.credential").where("connection_id", "=", before.id).execute();
  await tx
    .updateTable("integrations.connection")
    .set({ status: "disconnected", disconnected_at: sql<Date>`now()`, status_reason: null, version: sql<number>`version + 1` })
    .where("id", "=", before.id)
    .execute();
  await recordAudit(tx, ctx, { action: "integration.disconnected", entityType: "account", entityId: ctx.tenantId, diff: { provider, portalId: before.portalId } });
  await emit(tx, ctx.tenantId, { type: "integration.disconnected.v1", subject: `integration/${provider}`, data: { connectionId: before.id, provider, portalId: before.portalId } });
  return { refreshToken: tokens?.refreshToken ?? null };
}

/** Who to sync (owner). Requires the version the change was made from. */
export async function updateSettings(tx: Tx, ctx: ActorContext, provider: IntegrationProvider, expectedVersion: number, patch: Partial<ConnectionSettings>): Promise<Connection> {
  assertCan(ctx, "account.write");
  const before = await load(tx, provider, true);
  if (!before) throw new DomainError("not_found", "Not connected");
  if (before.version !== expectedVersion) throw new DomainError("version_conflict", "The connection was changed by someone else", { currentVersion: before.version });
  const settings: ConnectionSettings = {
    syncInvitedGuests: patch.syncInvitedGuests ?? before.settings.syncInvitedGuests,
    syncOpenAttendees: patch.syncOpenAttendees ?? before.settings.syncOpenAttendees,
  };
  await tx.updateTable("integrations.connection").set({ settings: JSON.stringify(settings), version: sql<number>`version + 1` }).where("id", "=", before.id).execute();
  const diff = diffFields(before.settings as unknown as Record<string, unknown>, settings as unknown as Record<string, unknown>);
  await recordAudit(tx, ctx, { action: "integration.updated", entityType: "account", entityId: ctx.tenantId, diff: { provider, ...diff } });
  await emit(tx, ctx.tenantId, { type: "integration.changed.v1", subject: `integration/${provider}`, data: { connectionId: before.id, provider, change: "settings" } });
  return (await load(tx, provider))!;
}

/** Runs the setup in the provider again ("Repair setup", owner). */
export async function requestSetup(tx: Tx, ctx: ActorContext, provider: IntegrationProvider): Promise<Connection> {
  assertCan(ctx, "account.write");
  const before = await load(tx, provider, true);
  if (!before || before.status === "disconnected") throw new DomainError("not_found", "Not connected");
  if (before.status === "needs_reconnect") throw new DomainError("conflict", "Reconnect first: the provider refuses our access", { status: before.status });
  await tx.updateTable("integrations.connection").set({ setup_status: "pending", setup_error: null }).where("id", "=", before.id).execute();
  await emit(tx, ctx.tenantId, { type: "integration.setup_requested.v1", subject: `integration/${provider}`, data: { connectionId: before.id, provider } });
  return (await load(tx, provider))!;
}

// ── Connector (worker), in the account's tenant transaction ─────────────────

async function readTokens(tx: Tx, tenantId: string, connectionId: string): Promise<Tokens | null> {
  const row = await tx.selectFrom("integrations.credential").select(["ciphertext", "access_expires_at"]).where("connection_id", "=", connectionId).executeTakeFirst();
  if (!row) return null;
  const t = (await decryptJson(tx, tenantId, credentialAad(tenantId, connectionId), row.ciphertext)) as { accessToken: string; refreshToken: string };
  return { ...t, accessExpiresAt: row.access_expires_at };
}

/** An active connection and its tokens, or null when there is none to use. */
export async function loadForSync(tx: Tx, tenantId: string, provider: IntegrationProvider): Promise<{ connection: Connection; tokens: Tokens } | null> {
  const connection = await load(tx, provider);
  if (!connection || connection.status !== "active") return null;
  const tokens = await readTokens(tx, tenantId, connection.id);
  return tokens ? { connection, tokens } : null;
}

/** Stores refreshed tokens, unless the connection was disconnected or reconnected meanwhile. */
export async function storeRefreshedTokens(tx: Tx, tenantId: string, connectionId: string, tokens: Tokens): Promise<void> {
  const c = await tx.selectFrom("integrations.connection").select("status").where("id", "=", connectionId).forUpdate().executeTakeFirst();
  if (c?.status !== "active") return;
  await writeTokens(tx, tenantId, connectionId, tokens);
}

/** Records how the setup in the provider went. */
export async function recordSetup(tx: Tx, connectionId: string, result: { ok: true } | { ok: false; error: string }): Promise<void> {
  await tx
    .updateTable("integrations.connection")
    .set({ setup_status: result.ok ? "done" : "failed", setup_error: result.ok ? null : result.error.slice(0, 1000), setup_at: sql<Date>`now()` })
    .where("id", "=", connectionId)
    .where("status", "=", "active")
    .execute();
}

/** The provider refused our tokens (uninstalled, revoked): sync pauses until an owner reconnects. */
export async function markNeedsReconnect(tx: Tx, tenantId: string, connectionId: string, reason: string): Promise<void> {
  const res = await tx
    .updateTable("integrations.connection")
    .set({ status: "needs_reconnect", status_reason: reason.slice(0, 1000), version: sql<number>`version + 1` })
    .where("id", "=", connectionId)
    .where("status", "=", "active")
    .returning(["provider"])
    .executeTakeFirst();
  if (res) await emit(tx, tenantId, { type: "integration.changed.v1", subject: `integration/${res.provider}`, data: { connectionId, provider: res.provider, change: "needs_reconnect" } });
}
