import { type SyncItemKind, sql, type Tx } from "@event-manager/db";
import { emit } from "../outbox/index.js";
import { type ActorContext, DomainError } from "../shared/index.js";
import { assertCan, recordAudit } from "../tenancy/index.js";
import type { ConnectionRef, ConnectionSettings } from "./index.js";

// What the connector keeps in step in the provider (docs/hubspot.md, milestone 2): contacts,
// one marketing event per occurrence, and attendance. Each is a row in integrations.sync_item
// that is both the id mapping and the pending change. The outbox handler marks rows dirty in the
// event's transaction; the sync job reads dirty rows, pushes them in batches and records what
// the provider answered. Every write back names the generation the job loaded, so a job that
// outlives a disconnect or reconnect changes nothing.

export type { SyncItemKind };

/** The attendance the platform wants HubSpot to show for a contact at an occurrence. */
export type AttendanceTarget = "registered" | "cancelled" | "attended";

export interface SyncTarget {
  id: string;
  generation: number;
  settings: ConnectionSettings;
}

export interface SyncItem {
  kind: SyncItemKind;
  localKey: string;
  remoteId: string | null;
  data: Record<string, unknown>;
  createdByUs: boolean | null;
  syncedState: string | null;
  attempts: number;
  /** When the item was last marked or recorded, exactly as stored: a mark after this keeps it dirty. */
  markedAt: string;
}

/** After this many failed pushes an item stops being retried until it changes again or is replayed. */
export const MAX_SYNC_ATTEMPTS = 5;

const DEFAULTS: ConnectionSettings = { syncInvitedGuests: true, syncOpenAttendees: false };

/**
 * The connection to mark changes for: active, or paused for a reconnect (its changes wait and go
 * once reconnected). Null when not connected or disconnected.
 */
export async function syncTarget(tx: Tx, provider: "hubspot"): Promise<SyncTarget | null> {
  const c = await tx
    .selectFrom("integrations.connection")
    .select(["id", "generation", "status", "settings"])
    .where("provider", "=", provider)
    .executeTakeFirst();
  if (!c || c.status === "disconnected") return null;
  return { id: c.id, generation: c.generation, settings: { ...DEFAULTS, ...(c.settings as Partial<ConnectionSettings>) } };
}

export const contactKey = (email: string) => email.trim().toLowerCase();
export const attendanceKey = (occurrenceId: string, email: string) => `${occurrenceId}:${contactKey(email)}`;

/** A contact to upsert: by email, with the guest's name for HubSpot to use where it has none. */
export async function markContact(tx: Tx, tenantId: string, connectionId: string, contact: { email: string; name: string | null }): Promise<void> {
  const data = JSON.stringify({ email: contact.email.trim(), name: contact.name });
  await tx
    .insertInto("integrations.sync_item")
    .values({ tenant_id: tenantId, connection_id: connectionId, kind: "contact", local_key: contactKey(contact.email), data })
    .onConflict((oc) => oc.columns(["connection_id", "kind", "local_key"]).doUpdateSet({ data, dirty: true, attempts: 0, last_error: null }))
    .execute();
}

/** An occurrence whose marketing event should be created or brought up to date. */
export async function markMarketingEvent(tx: Tx, tenantId: string, connectionId: string, occurrenceId: string): Promise<void> {
  await tx
    .insertInto("integrations.sync_item")
    .values({ tenant_id: tenantId, connection_id: connectionId, kind: "marketing_event", local_key: occurrenceId, data: JSON.stringify({ occurrenceId }) })
    .onConflict((oc) => oc.columns(["connection_id", "kind", "local_key"]).doUpdateSet({ dirty: true, attempts: 0, last_error: null }))
    .execute();
}

/**
 * The attendance HubSpot should show. Dirty only when it differs from what HubSpot was last
 * told, so a replayed event costs nothing. Cancelling what was never registered is a no-op.
 */
export async function markAttendance(tx: Tx, tenantId: string, connectionId: string, occurrenceId: string, email: string, target: AttendanceTarget): Promise<void> {
  const key = attendanceKey(occurrenceId, email);
  const existing = await tx
    .selectFrom("integrations.sync_item")
    .select(["synced_state", "data"])
    .where("connection_id", "=", connectionId)
    .where("kind", "=", "attendance")
    .where("local_key", "=", key)
    .executeTakeFirst();
  if (!existing && target === "cancelled") return;
  const data = JSON.stringify({ occurrenceId, email: contactKey(email), target });
  if (!existing) {
    await tx.insertInto("integrations.sync_item").values({ tenant_id: tenantId, connection_id: connectionId, kind: "attendance", local_key: key, data }).execute();
    return;
  }
  await tx
    .updateTable("integrations.sync_item")
    .set({ data, dirty: existing.synced_state !== target, attempts: 0, last_error: null })
    .where("connection_id", "=", connectionId)
    .where("kind", "=", "attendance")
    .where("local_key", "=", key)
    .execute();
}

/** Items of one kind waiting to be pushed, oldest change first, leaving out those that keep failing. */
export async function dirtyItems(tx: Tx, connectionId: string, kind: SyncItemKind, limit: number): Promise<SyncItem[]> {
  const rows = await tx
    .selectFrom("integrations.sync_item")
    .select(["kind", "local_key", "remote_id", "data", "created_by_us", "synced_state", "attempts"])
    .select(sql<string>`updated_at::text`.as("marked_at"))
    .where("connection_id", "=", connectionId)
    .where("kind", "=", kind)
    .where("dirty", "=", true)
    .where("attempts", "<", MAX_SYNC_ATTEMPTS)
    .orderBy("updated_at")
    .limit(limit)
    .execute();
  return rows.map((r) => ({
    kind: r.kind,
    localKey: r.local_key,
    remoteId: r.remote_id,
    data: r.data as Record<string, unknown>,
    createdByUs: r.created_by_us,
    syncedState: r.synced_state,
    attempts: r.attempts,
    markedAt: r.marked_at,
  }));
}

/** Remote ids of items of one kind, for the keys asked (contacts by email, events by occurrence). */
export async function remoteIds(tx: Tx, connectionId: string, kind: SyncItemKind, keys: string[]): Promise<Map<string, string>> {
  if (!keys.length) return new Map();
  const rows = await tx
    .selectFrom("integrations.sync_item")
    .select(["local_key", "remote_id"])
    .where("connection_id", "=", connectionId)
    .where("kind", "=", kind)
    .where("local_key", "in", keys)
    .where("remote_id", "is not", null)
    .execute();
  return new Map(rows.map((r) => [r.local_key, r.remote_id!]));
}

/** A sync_item update guarded by the generation the job loaded. */
function guarded(tx: Tx, ref: ConnectionRef, kind: SyncItemKind, key: string) {
  return tx
    .updateTable("integrations.sync_item")
    .where("connection_id", "=", ref.id)
    .where("kind", "=", kind)
    .where("local_key", "=", key)
    .where(({ exists, selectFrom }) =>
      exists(selectFrom("integrations.connection as c").select("c.id").where("c.id", "=", ref.id).where("c.generation", "=", ref.generation).where("c.status", "=", "active")),
    );
}

/**
 * The provider took the item. `createdByUs` is recorded only the first time (the cleanup needs to
 * know who created the contact, not whether the latest upsert did). The item stays dirty if it
 * was marked again while the push was under way.
 */
export async function recordSynced(
  tx: Tx,
  ref: ConnectionRef,
  item: Pick<SyncItem, "kind" | "localKey" | "markedAt">,
  result: { remoteId?: string | null; createdByUs?: boolean; syncedState?: string },
): Promise<void> {
  await guarded(tx, ref, item.kind, item.localKey)
    .set({
      ...(result.remoteId ? { remote_id: result.remoteId } : {}),
      ...(result.createdByUs !== undefined ? { created_by_us: sql<boolean>`coalesce(created_by_us, ${result.createdByUs})` } : {}),
      ...(result.syncedState !== undefined ? { synced_state: result.syncedState } : {}),
      dirty: sql<boolean>`updated_at > ${item.markedAt}::timestamptz`,
      attempts: 0,
      last_error: null,
      last_synced_at: sql<Date>`now()`,
    })
    .execute();
}

/** The provider refused the item; it is retried by later runs until MAX_SYNC_ATTEMPTS. */
export async function recordFailed(tx: Tx, ref: ConnectionRef, item: Pick<SyncItem, "kind" | "localKey">, error: string): Promise<void> {
  await guarded(tx, ref, item.kind, item.localKey)
    .set({ attempts: sql<number>`attempts + 1`, last_error: error.slice(0, 1000) })
    .execute();
}

/** Nothing to push for the item (an unpublished event never synced): clear it without a call. */
export async function recordSkipped(tx: Tx, ref: ConnectionRef, item: Pick<SyncItem, "kind" | "localKey" | "markedAt">): Promise<void> {
  await guarded(tx, ref, item.kind, item.localKey).set({ dirty: sql<boolean>`updated_at > ${item.markedAt}::timestamptz`, attempts: 0, last_error: null }).execute();
}

/** Whether any item of the connection is waiting to be pushed. */
export async function hasDirty(tx: Tx, connectionId: string): Promise<boolean> {
  const r = await tx
    .selectFrom("integrations.sync_item")
    .select("local_key")
    .where("connection_id", "=", connectionId)
    .where("dirty", "=", true)
    .where("attempts", "<", MAX_SYNC_ATTEMPTS)
    .limit(1)
    .executeTakeFirst();
  return !!r;
}

export interface MarketingEventSource {
  occurrenceId: string;
  eventId: string;
  eventStatus: string;
  occurrenceStatus: string | null;
  title: string;
  organizer: string;
  startUtc: Date | null;
  endUtc: Date | null;
  externalUrl: string | null;
}

/**
 * What a marketing event is made from: the occurrence, its event's title in the account's
 * default locale (or any), and the account name as organiser. A deleted occurrence comes back
 * with no times and status null.
 */
export async function marketingEventSources(tx: Tx, occurrenceIds: string[]): Promise<Map<string, MarketingEventSource>> {
  if (!occurrenceIds.length) return new Map();
  const account = await tx.selectFrom("tenancy.account").select(["name", "default_locale"]).executeTakeFirstOrThrow();
  const rows = await tx
    .selectFrom("catalog.occurrence as o")
    .innerJoin("catalog.event as e", "e.id", "o.event_id")
    .select(["o.id as occurrence_id", "o.status as occurrence_status", "o.start_utc", "o.end_utc", "o.external_url_override", "e.id as event_id", "e.status as event_status", "e.slug", "e.external_url"])
    .select((eb) =>
      eb
        .selectFrom("catalog.event_translation as t")
        .select("t.title")
        .whereRef("t.event_id", "=", "e.id")
        .orderBy(sql`t.locale = ${account.default_locale}`, "desc")
        .orderBy("t.locale")
        .limit(1)
        .as("title"),
    )
    .where("o.id", "in", occurrenceIds)
    .execute();
  return new Map(
    rows.map((r) => [
      r.occurrence_id,
      {
        occurrenceId: r.occurrence_id,
        eventId: r.event_id,
        eventStatus: r.event_status,
        occurrenceStatus: r.occurrence_status,
        title: r.title ?? r.slug,
        organizer: account.name,
        startUtc: r.start_utc,
        endUtc: r.end_utc,
        externalUrl: r.external_url_override ?? r.external_url,
      },
    ]),
  );
}

/**
 * Everything the connection should show, marked dirty: after connecting and on Resync. Published
 * (or cancelled) events with occurrences not long past, their invited guests who were sent an
 * invitation, attendees of open registration if the account syncs them, and attendance.
 */
export async function markForBackfill(tx: Tx, tenantId: string, target: SyncTarget, now = new Date()): Promise<{ contacts: number; events: number; attendance: number }> {
  const since = new Date(now.getTime() - 24 * 3600_000);
  const occurrences = await tx
    .selectFrom("catalog.occurrence as o")
    .innerJoin("catalog.event as e", "e.id", "o.event_id")
    .select(["o.id", "o.event_id"])
    .where("e.status", "in", ["published", "cancelled"])
    .where("o.end_utc", ">=", since)
    .execute();
  for (const o of occurrences) await markMarketingEvent(tx, tenantId, target.id, o.id);
  const eventIds = [...new Set(occurrences.map((o) => o.event_id))];

  let contacts = 0;
  if (eventIds.length && target.settings.syncInvitedGuests) {
    const guests = await tx
      .selectFrom("registration.guest_invitation")
      .select(["email", "name"])
      .where("event_id", "in", eventIds)
      .where("first_sent_at", "is not", null)
      .execute();
    for (const g of guests) await markContact(tx, tenantId, target.id, g);
    contacts += guests.length;
  }

  let attendance = 0;
  if (occurrences.length) {
    const regs = await tx
      .selectFrom("registration.registration")
      .select(["occurrence_id", "email", "name", "invitation_id"])
      .where("occurrence_id", "in", occurrences.map((o) => o.id))
      .where("status", "=", "confirmed")
      .where("email", "is not", null)
      .execute();
    for (const r of regs) {
      if (!(r.invitation_id ? target.settings.syncInvitedGuests : target.settings.syncOpenAttendees)) continue;
      await markContact(tx, tenantId, target.id, { email: r.email!, name: r.name });
      await markAttendance(tx, tenantId, target.id, r.occurrence_id, r.email!, "registered");
      contacts++;
      attendance++;
    }
  }
  return { contacts, events: occurrences.length, attendance };
}

/** Drops the connection's mappings and pending changes (on disconnect). */
export async function dropSyncItems(tx: Tx, connectionId: string): Promise<void> {
  await tx.deleteFrom("integrations.sync_item").where("connection_id", "=", connectionId).execute();
}

// ── Staff: the sync log, retry and resync ───────────────────────────────────

export interface SyncCounts {
  /** In HubSpot and up to date. */
  synced: number;
  /** Waiting to be pushed, including items being retried after a refusal. */
  pending: number;
  /** Refused MAX_SYNC_ATTEMPTS times; waits for a retry or a change. */
  failed: number;
}

export interface SyncIssue {
  kind: SyncItemKind;
  /** What the item is, for people: the contact's email, or the event and time. */
  label: string;
  email: string | null;
  eventTitle: string | null;
  startUtc: Date | null;
  attempts: number;
  /** Refused MAX_SYNC_ATTEMPTS times: no longer retried by itself. */
  givenUp: boolean;
  lastError: string;
  updatedAt: Date;
}

export interface SyncSummary {
  counts: Record<SyncItemKind, SyncCounts>;
  lastSyncedAt: Date | null;
  /** Items HubSpot refused, latest first (at most 50). */
  issues: SyncIssue[];
}

async function liveConnection(tx: Tx, provider: "hubspot") {
  const c = await tx.selectFrom("integrations.connection").select(["id", "status"]).where("provider", "=", provider).executeTakeFirst();
  if (!c || c.status === "disconnected") throw new DomainError("not_found", "Not connected");
  return c;
}

/** What is in step, waiting or refused, and why (Settings → Integrations, the sync log). */
export async function syncSummary(tx: Tx, ctx: ActorContext, provider: "hubspot"): Promise<SyncSummary> {
  assertCan(ctx, "content.read");
  const c = await liveConnection(tx, provider);
  const rows = await tx
    .selectFrom("integrations.sync_item")
    .select(["kind"])
    .select(sql<number>`count(*) filter (where not dirty and remote_id is not null or (kind = 'attendance' and not dirty))::int`.as("synced"))
    .select(sql<number>`count(*) filter (where dirty and attempts < ${MAX_SYNC_ATTEMPTS})::int`.as("pending"))
    .select(sql<number>`count(*) filter (where dirty and attempts >= ${MAX_SYNC_ATTEMPTS})::int`.as("failed"))
    .select(sql<Date | null>`max(last_synced_at)`.as("last_synced_at"))
    .where("connection_id", "=", c.id)
    .groupBy("kind")
    .execute();
  const empty = (): SyncCounts => ({ synced: 0, pending: 0, failed: 0 });
  const counts: Record<SyncItemKind, SyncCounts> = { contact: empty(), marketing_event: empty(), attendance: empty() };
  let lastSyncedAt: Date | null = null;
  for (const r of rows) {
    counts[r.kind] = { synced: r.synced, pending: r.pending, failed: r.failed };
    if (r.last_synced_at && (!lastSyncedAt || r.last_synced_at > lastSyncedAt)) lastSyncedAt = r.last_synced_at;
  }

  const issues = await tx
    .selectFrom("integrations.sync_item as s")
    .leftJoin("catalog.occurrence as o", (j) => j.on(sql`o.id::text`, "=", sql`coalesce(s.data->>'occurrenceId', '')`))
    .select(["s.kind", "s.local_key", "s.data", "s.attempts", "s.last_error", "s.updated_at", "o.start_utc"])
    .select((eb) =>
      eb.selectFrom("catalog.event_translation as t").select("t.title").whereRef("t.event_id", "=", "o.event_id").orderBy("t.locale").limit(1).as("title"),
    )
    .where("s.connection_id", "=", c.id)
    .where("s.dirty", "=", true)
    .where("s.last_error", "is not", null)
    .orderBy("s.updated_at", "desc")
    .limit(50)
    .execute();

  return {
    counts,
    lastSyncedAt,
    issues: issues.map((r) => {
      const data = r.data as { email?: string };
      const email = r.kind === "marketing_event" ? null : (data.email ?? r.local_key);
      const label = [email, r.title].filter(Boolean).join(" · ") || r.local_key;
      return {
        kind: r.kind,
        label,
        email,
        eventTitle: r.title,
        startUtc: r.start_utc,
        attempts: r.attempts,
        givenUp: r.attempts >= MAX_SYNC_ATTEMPTS,
        lastError: r.last_error!,
        updatedAt: r.updated_at,
      };
    }),
  };
}

/** Tries every refused item again, given up or not ("Retry", owner). Returns how many. */
export async function retryFailed(tx: Tx, ctx: ActorContext, provider: "hubspot"): Promise<number> {
  assertCan(ctx, "account.write");
  const c = await liveConnection(tx, provider);
  const res = await tx
    .updateTable("integrations.sync_item")
    .set({ attempts: 0, dirty: true })
    .where("connection_id", "=", c.id)
    .where("dirty", "=", true)
    .where("last_error", "is not", null)
    .executeTakeFirst();
  const n = Number(res.numUpdatedRows);
  await recordAudit(tx, ctx, { action: "integration.sync_retried", entityType: "account", entityId: ctx.tenantId, diff: { provider, items: n } });
  if (n) await emit(tx, ctx.tenantId, { type: "integration.sync_requested.v1", subject: `integration/${provider}`, data: { connectionId: c.id, provider } });
  return n;
}

/**
 * Marks everything the connection should show for pushing again, as after connecting ("Resync",
 * owner): for a portal where someone deleted or changed what we wrote.
 */
export async function requestResync(tx: Tx, ctx: ActorContext, provider: "hubspot"): Promise<void> {
  assertCan(ctx, "account.write");
  const c = await liveConnection(tx, provider);
  if (c.status === "needs_reconnect") throw new DomainError("conflict", "Reconnect first: the provider refuses our access", { status: c.status });
  await recordAudit(tx, ctx, { action: "integration.resync_requested", entityType: "account", entityId: ctx.tenantId, diff: { provider } });
  await emit(tx, ctx.tenantId, { type: "integration.resync_requested.v1", subject: `integration/${provider}`, data: { connectionId: c.id, provider } });
}
