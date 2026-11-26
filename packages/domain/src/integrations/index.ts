import { type ConnectionStatus, type IntegrationProvider, newId, sql, type Tx } from "@event-manager/db";
import { emit } from "../outbox/index.js";
import { type ActorContext, decryptJson, DomainError, encryptJson } from "../shared/index.js";
import { assertCan, diffFields, recordAudit } from "../tenancy/index.js";
import type { CleanupResult, PortalSetup } from "./cleanup.js";
import { dropSyncItems } from "./sync.js";

export * from "./cleanup.js";
export * from "./segments.js";
export * from "./sending.js";
export * from "./session.js";
export * from "./guest-lists.js";
export * from "./sync.js";

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
  /** The subscription type the platform's HubSpot emails use; temporary contacts are unsubscribed from every other (milestone 4). */
  eventSubscriptionTypeId: string | null;
  /** Days after a contact's last occurrence ends before the cleanup takes back what the platform did. */
  cleanupGraceDays: number;
  /** Delete contacts the platform created only for mirroring, once no event needs them (default on). */
  deleteMirroredContacts: boolean;
  /** The account's default single-send template email per kind (milestone 5); an event can choose others. */
  invitationTemplateId: string | null;
  reminderTemplateId: string | null;
  welcomeTemplateId: string | null;
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
  /** Bumped on every (re)connect; see ConnectionRef. */
  generation: number;
  /** What the setup made or found in the portal: subscription types, the cleanup segments and workflow. */
  portalSetup: PortalSetup;
  /** What the last cleanup run did. */
  lastCleanup: CleanupResult | null;
  /** An owner asked to clean up and then disconnect; the worker is on it. */
  cleanupDisconnectRequestedAt: Date | null;
  version: number;
  updatedAt: Date;
}

/**
 * The connection a job loaded. Reconnecting reuses the row, so the id alone does not say it is
 * still the same install: the connector writes back only if the generation still matches.
 */
export type ConnectionRef = Pick<Connection, "id" | "generation">;

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
}

export const DEFAULT_SETTINGS: ConnectionSettings = {
  syncInvitedGuests: true, syncOpenAttendees: false, eventSubscriptionTypeId: null, cleanupGraceDays: 7, deleteMirroredContacts: true,
  invitationTemplateId: null, reminderTemplateId: null, welcomeTemplateId: null,
};

const columns = [
  "id", "provider", "status", "external_account_id", "scopes", "settings", "setup_status", "setup_error", "setup_at",
  "status_reason", "connected_by", "connected_at", "disconnected_at", "generation", "version", "updated_at",
  "portal_setup", "last_cleanup", "cleanup_disconnect_requested_at",
] as const;

type Row = {
  id: string; provider: IntegrationProvider; status: ConnectionStatus; external_account_id: string; scopes: string[]; settings: unknown;
  setup_status: "pending" | "done" | "failed"; setup_error: string | null; setup_at: Date | null; status_reason: string | null;
  connected_by: string | null; connected_at: Date; disconnected_at: Date | null; generation: number; version: number; updated_at: Date;
  portal_setup: unknown; last_cleanup: unknown; cleanup_disconnect_requested_at: Date | null;
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
  generation: r.generation,
  portalSetup: (r.portal_setup ?? {}) as PortalSetup,
  lastCleanup: (r.last_cleanup ?? null) as CleanupResult | null,
  cleanupDisconnectRequestedAt: r.cleanup_disconnect_requested_at,
  version: r.version,
  updatedAt: r.updated_at,
});

const credentialAad = (tenantId: string, connectionId: string) => `integration-credential:${tenantId}:${connectionId}`;

/** DomainError details.reason when a portal is connected to another account: the install is that account's too, so the caller must not revoke it. */
export const PORTAL_TAKEN = "portal_connected_elsewhere";
const isPortalTaken = (e: unknown) =>
  typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505" && (e as { constraint?: unknown }).constraint === "connection_portal_live";

/** The connection, without a permission check: for other parts of the module and the worker. */
export const loadConnection = (tx: Tx, provider: IntegrationProvider): Promise<Connection | null> => load(tx, provider);

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
  try {
    if (before) {
      id = before.id;
      await tx.updateTable("integrations.connection").set({ ...values, generation: sql<number>`generation + 1`, version: sql<number>`version + 1` }).where("id", "=", id).execute();
    } else {
      id = newId();
      await tx.insertInto("integrations.connection").values({ id, tenant_id: ctx.tenantId, provider: input.provider, ...values }).execute();
    }
  } catch (e) {
    // Another account has this portal connected (the index sees every account): two accounts
    // would prepare and clean up the same contacts, and one could undo what the other needs.
    if (isPortalTaken(e)) {
      throw new DomainError("conflict", "This HubSpot portal is connected to another account on the platform. Disconnect it there first", { field: "portalId", reason: PORTAL_TAKEN });
    }
    throw e;
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
  return closeConnection(tx, ctx, provider, before, {});
}

/**
 * Deletes the tokens and mappings and moves the connection to a new, disconnected generation, so
 * jobs still running for the old install drop what they would write.
 */
async function closeConnection(tx: Tx, audit: AuditActor, provider: IntegrationProvider, before: Connection, extra: Record<string, unknown>): Promise<{ refreshToken: string | null }> {
  const tokens = await readTokens(tx, audit.tenantId, before.id);
  await tx.deleteFrom("integrations.credential").where("connection_id", "=", before.id).execute();
  // Ids in a portal the account no longer reaches; a reconnect backfills afresh.
  await dropSyncItems(tx, before.id);
  await tx.deleteFrom("integrations.contact_state").where("connection_id", "=", before.id).execute();
  // The event's emails stay in the portal; a reconnect makes them afresh.
  await tx.deleteFrom("integrations.event_email").where("connection_id", "=", before.id).execute();
  await tx
    .updateTable("integrations.connection")
    .set({
      status: "disconnected", disconnected_at: sql<Date>`now()`, status_reason: null, generation: sql<number>`generation + 1`, version: sql<number>`version + 1`,
      cleanup_disconnect_requested_at: null, cleanup_disconnect_requested_by: null,
    })
    .where("id", "=", before.id)
    .execute();
  await recordAudit(tx, audit, { action: "integration.disconnected", entityType: "account", entityId: audit.tenantId, diff: { provider, portalId: before.portalId, ...extra } });
  await emit(tx, audit.tenantId, { type: "integration.disconnected.v1", subject: `integration/${provider}`, data: { connectionId: before.id, provider, portalId: before.portalId } });
  return { refreshToken: tokens?.refreshToken ?? null };
}

/** Who the audit log names; the worker's disconnect names the owner who asked, with no roles of its own. */
type AuditActor = ActorContext;

/**
 * "Clean up and disconnect" (owner): the worker runs the cleanup for every contact at once and
 * then disconnects. Refused while sync is paused for a reconnect: the cleanup needs our access.
 */
export async function requestCleanupAndDisconnect(tx: Tx, ctx: ActorContext, provider: IntegrationProvider): Promise<Connection> {
  assertCan(ctx, "account.write");
  const before = await load(tx, provider, true);
  if (!before || before.status === "disconnected") throw new DomainError("not_found", "Not connected");
  if (before.status === "needs_reconnect") throw new DomainError("conflict", "Reconnect first: the cleanup needs our access to the portal", { status: before.status });
  await tx
    .updateTable("integrations.connection")
    .set({ cleanup_disconnect_requested_at: sql<Date>`now()`, cleanup_disconnect_requested_by: ctx.userId })
    .where("id", "=", before.id)
    .execute();
  await recordAudit(tx, ctx, { action: "integration.cleanup_requested", entityType: "account", entityId: ctx.tenantId, diff: { provider, disconnect: true } });
  await emit(tx, ctx.tenantId, { type: "integration.cleanup_requested.v1", subject: `integration/${provider}`, data: { connectionId: before.id, provider, disconnect: true } });
  return (await load(tx, provider))!;
}

/**
 * The worker finished "Clean up and disconnect": disconnects in the name of the owner who asked,
 * if the generation it cleaned up is still the live one. Returns the refresh token to revoke, or
 * null when there was nothing (left) to disconnect.
 */
export async function disconnectAfterCleanup(tx: Tx, tenantId: string, ref: ConnectionRef, result: CleanupResult): Promise<{ refreshToken: string | null } | null> {
  const before = await load(tx, "hubspot", true);
  if (!before || before.id !== ref.id || before.generation !== ref.generation || before.status === "disconnected" || !before.cleanupDisconnectRequestedAt) return null;
  const by = await tx.selectFrom("integrations.connection").select("cleanup_disconnect_requested_by").where("id", "=", ref.id).executeTakeFirstOrThrow();
  return closeConnection(tx, { tenantId, userId: by.cleanup_disconnect_requested_by, clientId: null, roles: [] }, "hubspot", before, { afterCleanup: { deleted: result.deleted, restored: result.restored, kept: result.kept } });
}

/** The cleanup before a disconnect could not finish: the request is dropped and the connection stays, for the owner to look at. */
export async function cancelCleanupDisconnect(tx: Tx, ref: ConnectionRef): Promise<void> {
  await tx
    .updateTable("integrations.connection")
    .set({ cleanup_disconnect_requested_at: null, cleanup_disconnect_requested_by: null })
    .where("id", "=", ref.id)
    .where("generation", "=", ref.generation)
    .execute();
}

/** Who to sync (owner). Requires the version the change was made from. */
export async function updateSettings(tx: Tx, ctx: ActorContext, provider: IntegrationProvider, expectedVersion: number, patch: Partial<ConnectionSettings>): Promise<Connection> {
  assertCan(ctx, "account.write");
  const before = await load(tx, provider, true);
  if (!before) throw new DomainError("not_found", "Not connected");
  if (before.version !== expectedVersion) throw new DomainError("version_conflict", "The connection was changed by someone else", { currentVersion: before.version });
  const settings: ConnectionSettings = { ...before.settings };
  for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof ConnectionSettings)[]) if (patch[k] !== undefined) (settings as unknown as Record<string, unknown>)[k] = patch[k];
  if (!Number.isInteger(settings.cleanupGraceDays) || settings.cleanupGraceDays < 0 || settings.cleanupGraceDays > 90) {
    throw new DomainError("validation_failed", "The grace period is 0 to 90 days", { field: "cleanupGraceDays" });
  }
  if (patch.eventSubscriptionTypeId) {
    const types = before.portalSetup.subscriptionTypes ?? [];
    const type = types.find((t) => t.id === patch.eventSubscriptionTypeId);
    if (!type) throw new DomainError("validation_failed", "The portal has no such subscription type. Repair setup to read the portal's types again", { field: "eventSubscriptionTypeId" });
    if (!type.active) throw new DomainError("validation_failed", "The subscription type is not active in HubSpot", { field: "eventSubscriptionTypeId" });
  }
  const templates = new Set((before.portalSetup.portalId === before.portalId ? (before.portalSetup.singleSendEmails ?? []) : []).map((t) => t.id));
  for (const k of ["invitationTemplateId", "reminderTemplateId", "welcomeTemplateId"] as const) {
    if (patch[k] && !templates.has(patch[k])) {
      throw new DomainError("validation_failed", "The portal has no single-send email by that id. Repair setup to read the portal's emails again", { field: k });
    }
  }
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

/** Stores refreshed tokens, unless the connection was disconnected or reconnected since `ref` was loaded. */
export async function storeRefreshedTokens(tx: Tx, tenantId: string, ref: ConnectionRef, tokens: Tokens): Promise<boolean> {
  const c = await tx.selectFrom("integrations.connection").select(["status", "generation"]).where("id", "=", ref.id).forUpdate().executeTakeFirst();
  if (c?.status !== "active" || c.generation !== ref.generation) return false;
  await writeTokens(tx, tenantId, ref.id, tokens);
  return true;
}

/** Records how the setup in the provider went, for the generation that ran it. */
export async function recordSetup(tx: Tx, ref: ConnectionRef, result: { ok: true } | { ok: false; error: string }): Promise<void> {
  await tx
    .updateTable("integrations.connection")
    .set({ setup_status: result.ok ? "done" : "failed", setup_error: result.ok ? null : result.error.slice(0, 1000), setup_at: sql<Date>`now()` })
    .where("id", "=", ref.id)
    .where("generation", "=", ref.generation)
    .where("status", "=", "active")
    .execute();
}

/**
 * The provider refused our tokens (uninstalled, revoked): sync pauses until an owner reconnects.
 * A refusal of an older generation's tokens says nothing about the current install and is ignored.
 */
export async function markNeedsReconnect(tx: Tx, tenantId: string, ref: ConnectionRef, reason: string): Promise<void> {
  const res = await tx
    .updateTable("integrations.connection")
    .set({ status: "needs_reconnect", status_reason: reason.slice(0, 1000), version: sql<number>`version + 1` })
    .where("id", "=", ref.id)
    .where("generation", "=", ref.generation)
    .where("status", "=", "active")
    .returning(["provider"])
    .executeTakeFirst();
  if (res) await emit(tx, tenantId, { type: "integration.changed.v1", subject: `integration/${res.provider}`, data: { connectionId: ref.id, provider: res.provider, change: "needs_reconnect" } });
}
