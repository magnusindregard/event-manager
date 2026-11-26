import { sql, type Tx } from "@event-manager/db";
import type { ConnectionRef } from "./index.js";
import { contactKey, type SyncTarget } from "./sync.js";

// Static segments per event (docs/hubspot.md, "Segments", milestone 3): `EM · <event> · Awaiting
// reply` (sent an invitation, no answer yet) and `EM · <event> · Confirmed · <occurrence>`. They
// are for the client's own lists, reports and workflows; HubSpot sending does not use them.
//
// Membership is worked out from the platform's own state, never from the outbox event that
// prompted it: `markSegments` recomputes it for the guests asked about (or the whole event) and
// marks a `segment_member` row dirty wherever it differs from what HubSpot was last told. So a
// replayed or out-of-order event changes nothing, and the nightly reconcile can reuse it.

export type SegmentRole = "awaiting" | "confirmed";

export interface SegmentData {
  eventId: string;
  role: SegmentRole;
  occurrenceId: string | null;
  /** The event was archived: delete the segment in HubSpot. */
  deleted?: boolean;
}

export const segmentKey = (eventId: string, role: SegmentRole, occurrenceId?: string | null) =>
  role === "awaiting" ? `${eventId}:awaiting` : `${eventId}:confirmed:${occurrenceId}`;
export const segmentMemberKey = (segment: string, email: string) => `${segment}|${contactKey(email)}`;

function parseSegmentKey(key: string): SegmentData {
  const [eventId, role, occurrenceId] = key.split(":") as [string, SegmentRole, string | undefined];
  return { eventId, role, occurrenceId: occurrenceId ?? null };
}

/**
 * Brings the event's segment memberships in line with the platform, for `emails` or (omitted)
 * every guest. Marks a member dirty only where it differs from what it was, and creates the
 * segment rows a member needs. Does nothing for an archived or never-synced event.
 */
export async function markSegments(tx: Tx, tenantId: string, target: SyncTarget, eventId: string, emails?: readonly string[]): Promise<number> {
  const ev = await tx.selectFrom("catalog.event").select("status").where("id", "=", eventId).executeTakeFirst();
  if (!ev || ev.status === "archived" || ev.status === "draft") return 0;
  const keys = emails ? [...new Set(emails.map(contactKey))] : null;
  if (keys && !keys.length) return 0;

  const desired = new Map<string, { segment: string; email: string }>();
  const want = (segment: string, email: string) => desired.set(segmentMemberKey(segment, email), { segment, email: contactKey(email) });

  if (target.settings.syncInvitedGuests) {
    let q = tx.selectFrom("registration.guest_invitation").select("email").where("event_id", "=", eventId).where("status", "=", "sent");
    if (keys) q = q.where(sql<string>`lower(email)`, "in", keys);
    for (const g of await q.execute()) want(segmentKey(eventId, "awaiting"), g.email);
  }
  let rq = tx
    .selectFrom("registration.registration")
    .select(["occurrence_id", "email", "invitation_id"])
    .where("event_id", "=", eventId)
    .where("status", "=", "confirmed")
    .where("email", "is not", null);
  if (keys) rq = rq.where(sql<string>`lower(email)`, "in", keys);
  for (const r of await rq.execute()) {
    if (!(r.invitation_id ? target.settings.syncInvitedGuests : target.settings.syncOpenAttendees)) continue;
    want(segmentKey(eventId, "confirmed", r.occurrence_id), r.email!);
  }

  let eq = tx
    .selectFrom("integrations.sync_item")
    .select(["local_key", "data"])
    .where("connection_id", "=", target.id)
    .where("kind", "=", "segment_member")
    .where("local_key", "like", `${eventId}:%`);
  if (keys) eq = eq.where(sql<string>`data->>'email'`, "in", keys);
  const existing = new Map((await eq.execute()).map((r) => [r.local_key, r.data as { member?: boolean }]));

  let changed = 0;
  const segments = new Set<string>();
  for (const [key, m] of desired) {
    segments.add(m.segment);
    const before = existing.get(key);
    if (before?.member === true) continue;
    const data = JSON.stringify({ segment: m.segment, eventId, email: m.email, member: true });
    if (!before) {
      await tx.insertInto("integrations.sync_item").values({ tenant_id: tenantId, connection_id: target.id, kind: "segment_member", local_key: key, data }).execute();
    } else {
      await setMember(tx, target.id, key, data, true);
    }
    changed++;
  }
  for (const [key, before] of existing) {
    if (desired.has(key) || before.member === false) continue;
    const segment = key.slice(0, key.indexOf("|"));
    await setMember(tx, target.id, key, JSON.stringify({ segment, eventId, email: key.slice(key.indexOf("|") + 1), member: false }), false);
    changed++;
  }
  for (const segment of segments) {
    const p = parseSegmentKey(segment);
    await tx
      .insertInto("integrations.sync_item")
      .values({ tenant_id: tenantId, connection_id: target.id, kind: "segment", local_key: segment, data: JSON.stringify({ eventId, role: p.role, occurrenceId: p.occurrenceId }) })
      .onConflict((oc) => oc.columns(["connection_id", "kind", "local_key"]).doNothing())
      .execute();
  }
  return changed;
}

async function setMember(tx: Tx, connectionId: string, key: string, data: string, member: boolean) {
  await tx
    .updateTable("integrations.sync_item")
    .set({ data, dirty: sql<boolean>`synced_state is distinct from ${member ? "in" : "out"}`, attempts: 0, last_error: null })
    .where("connection_id", "=", connectionId)
    .where("kind", "=", "segment_member")
    .where("local_key", "=", key)
    .execute();
}

/**
 * The event was archived, or (with `occurrenceId`) the occurrence deleted: its segments go. One
 * HubSpot never had is dropped at once; the others are marked for the sync job to delete.
 */
export async function markSegmentsDeleted(tx: Tx, connectionId: string, eventId: string, occurrenceId?: string): Promise<boolean> {
  const prefix = occurrenceId ? segmentKey(eventId, "confirmed", occurrenceId) : `${eventId}:`;
  const like = occurrenceId ? prefix : `${prefix}%`;
  const rows = await tx
    .selectFrom("integrations.sync_item")
    .select(["local_key", "remote_id"])
    .where("connection_id", "=", connectionId)
    .where("kind", "=", "segment")
    .where("local_key", "like", like)
    .execute();
  let marked = false;
  for (const r of rows) {
    if (!r.remote_id) {
      await dropSegmentRows(tx, connectionId, r.local_key);
      continue;
    }
    await tx
      .updateTable("integrations.sync_item")
      .set({ data: sql`data || '{"deleted": true}'::jsonb`, dirty: true, attempts: 0, last_error: null })
      .where("connection_id", "=", connectionId)
      .where("kind", "=", "segment")
      .where("local_key", "=", r.local_key)
      .execute();
    marked = true;
  }
  return marked;
}

async function dropSegmentRows(tx: Tx, connectionId: string, segment: string) {
  await tx
    .deleteFrom("integrations.sync_item")
    .where("connection_id", "=", connectionId)
    .where((eb) => eb.or([eb.and([eb("kind", "=", "segment"), eb("local_key", "=", segment)]), eb.and([eb("kind", "=", "segment_member"), eb("local_key", "like", `${segment}|%`)])]))
    .execute();
}

const live = (tx: Tx, ref: ConnectionRef) =>
  tx.selectFrom("integrations.connection as c").select("c.id").where("c.id", "=", ref.id).where("c.generation", "=", ref.generation).where("c.status", "=", "active");

/** The segment is gone from HubSpot (deleted): drops its rows, if the job's connection is still the live one. */
export async function dropSegment(tx: Tx, ref: ConnectionRef, segment: string): Promise<void> {
  if (!(await live(tx, ref).executeTakeFirst())) return;
  await dropSegmentRows(tx, ref.id, segment);
}

/**
 * HubSpot no longer has the segment (someone deleted it there): it is made again by the next
 * sync, with every member added back.
 */
export async function recordSegmentGone(tx: Tx, ref: ConnectionRef, segment: string): Promise<void> {
  if (!(await live(tx, ref).executeTakeFirst())) return;
  await tx
    .updateTable("integrations.sync_item")
    .set({ remote_id: null, dirty: true, attempts: 0, last_error: null })
    .where("connection_id", "=", ref.id)
    .where("kind", "=", "segment")
    .where("local_key", "=", segment)
    .execute();
  await tx
    .updateTable("integrations.sync_item")
    .set({ synced_state: null, dirty: sql<boolean>`(data->>'member')::boolean`, attempts: 0, last_error: null })
    .where("connection_id", "=", ref.id)
    .where("kind", "=", "segment_member")
    .where("local_key", "like", `${segment}|%`)
    .execute();
}

/** Segments HubSpot has and that are not being deleted, by key: their list ids. */
export async function liveSegments(tx: Tx, connectionId: string, keys?: readonly string[]): Promise<Map<string, string>> {
  if (keys && !keys.length) return new Map();
  let q = tx
    .selectFrom("integrations.sync_item")
    .select(["local_key", "remote_id"])
    .where("connection_id", "=", connectionId)
    .where("kind", "=", "segment")
    .where("remote_id", "is not", null)
    .where(sql<boolean>`coalesce((data->>'deleted')::boolean, false)`, "=", false);
  if (keys) q = q.where("local_key", "in", keys);
  return new Map((await q.execute()).map((r) => [r.local_key, r.remote_id!]));
}

/** Whether a list id is already one of the connection's segments. */
export async function isMappedSegment(tx: Tx, connectionId: string, listId: string): Promise<boolean> {
  const r = await tx.selectFrom("integrations.sync_item").select("local_key").where("connection_id", "=", connectionId).where("kind", "=", "segment").where("remote_id", "=", listId).executeTakeFirst();
  return !!r;
}

/**
 * The names to give new segments in HubSpot: `EM · <event> · Awaiting reply` and
 * `EM · <event> · Confirmed · <local start>`, with the title in the account's default locale.
 */
export async function segmentNames(tx: Tx, keys: readonly string[]): Promise<Map<string, string>> {
  if (!keys.length) return new Map();
  const parsed = keys.map((k) => ({ key: k, ...parseSegmentKey(k) }));
  const account = await tx.selectFrom("tenancy.account").select("default_locale").executeTakeFirstOrThrow();
  const eventIds = [...new Set(parsed.map((p) => p.eventId))];
  const events = await tx
    .selectFrom("catalog.event as e")
    .select(["e.id", "e.slug", "e.timezone"])
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
    .where("e.id", "in", eventIds)
    .execute();
  const byId = new Map(events.map((e) => [e.id, e]));
  const occIds = parsed.map((p) => p.occurrenceId).filter((x): x is string => !!x);
  const occ = occIds.length ? await tx.selectFrom("catalog.occurrence").select(["id", "start_utc"]).where("id", "in", occIds).execute() : [];
  const starts = new Map(occ.map((o) => [o.id, o.start_utc]));
  const names = new Map<string, string>();
  for (const p of parsed) {
    const e = byId.get(p.eventId);
    const title = (e?.title ?? e?.slug ?? p.eventId).slice(0, 150);
    if (p.role === "awaiting") {
      names.set(p.key, `EM · ${title} · Awaiting reply`);
      continue;
    }
    const start = p.occurrenceId ? starts.get(p.occurrenceId) : null;
    const when = start ? new Intl.DateTimeFormat("sv-SE", { timeZone: e?.timezone ?? "UTC", dateStyle: "short", timeStyle: "short" }).format(start) : (p.occurrenceId ?? "");
    names.set(p.key, `EM · ${title} · Confirmed · ${when}`);
  }
  return names;
}

// ── The nightly reconcile ───────────────────────────────────────────────────

/** Accounts with a live connection to the provider (across tenants, for the nightly jobs). */
export async function connectedTenants(tx: Tx, provider: "hubspot"): Promise<string[]> {
  const r = await sql<{ id: string }>`select integrations.connected_tenants(${provider}) as id`.execute(tx);
  return r.rows.map((x) => x.id);
}

/** Events that have segments, for the reconcile to recompute first. */
export async function segmentEvents(tx: Tx, connectionId: string): Promise<string[]> {
  const rows = await tx
    .selectFrom("integrations.sync_item")
    .select(sql<string>`data->>'eventId'`.as("event_id"))
    .distinct()
    .where("connection_id", "=", connectionId)
    .where("kind", "=", "segment")
    .where(sql<boolean>`coalesce((data->>'deleted')::boolean, false)`, "=", false)
    .execute();
  return rows.map((r) => r.event_id);
}

/** Who should be in the segment, by HubSpot contact id: members whose contact HubSpot has. */
export async function expectedMembers(tx: Tx, connectionId: string, segment: string): Promise<Set<string>> {
  const rows = await tx
    .selectFrom("integrations.sync_item as m")
    .innerJoin("integrations.sync_item as c", (j) =>
      j.onRef("c.connection_id", "=", "m.connection_id").on("c.kind", "=", "contact").on(sql`c.local_key`, "=", sql`m.data->>'email'`),
    )
    .select("c.remote_id")
    .where("m.connection_id", "=", connectionId)
    .where("m.kind", "=", "segment_member")
    .where("m.local_key", "like", `${segment}|%`)
    .where(sql<boolean>`(m.data->>'member')::boolean`, "=", true)
    .where("c.remote_id", "is not", null)
    .execute();
  return new Set(rows.map((r) => r.remote_id!));
}

/**
 * The segment now matches the platform: every member whose contact HubSpot has is in, everyone
 * else out. Members marked again after `before` stay dirty.
 */
export async function recordSegmentReconciled(tx: Tx, ref: ConnectionRef, segment: string, before: string): Promise<void> {
  if (!(await live(tx, ref).executeTakeFirst())) return;
  await sql`
    UPDATE integrations.sync_item m
       SET synced_state = CASE WHEN (m.data->>'member')::boolean THEN 'in' ELSE 'out' END,
           dirty = m.updated_at > ${before}::timestamptz, attempts = 0, last_error = null, last_synced_at = now()
     WHERE m.connection_id = ${ref.id} AND m.kind = 'segment_member' AND m.local_key LIKE ${`${segment}|%`}
       AND (NOT (m.data->>'member')::boolean OR EXISTS (
             SELECT 1 FROM integrations.sync_item c
              WHERE c.connection_id = m.connection_id AND c.kind = 'contact' AND c.local_key = m.data->>'email' AND c.remote_id IS NOT NULL))
  `.execute(tx);
}

export interface ReconcileResult {
  at: string;
  segments: number;
  /** Members HubSpot was missing, added back. */
  added: number;
  /** Contacts in a segment that should not be, removed (failed updates or hand edits). */
  removed: number;
  /** Segments deleted in HubSpot, to be made again. */
  recreated: number;
  /** Segments HubSpot refused to read or change. */
  failed: number;
}

/** What the last reconcile did, for the sync log. */
export async function recordReconcile(tx: Tx, ref: ConnectionRef, result: ReconcileResult): Promise<void> {
  await tx
    .updateTable("integrations.connection")
    .set({ last_reconcile: JSON.stringify(result) })
    .where("id", "=", ref.id)
    .where("generation", "=", ref.generation)
    .execute();
}
