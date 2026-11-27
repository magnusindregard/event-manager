import { type CleanupStatus, sql, type Tx } from "@event-manager/db";
import type { ConnectionRef } from "./index.js";
import type { SingleSendTemplate } from "./sending.js";
import { contactKey } from "./sync.js";

// Cleanup after HubSpot sending (docs/hubspot.md, milestone 4). The platform takes back what it
// did to the client's portal: contacts it created are deleted, contacts it made marketing are set
// back to non-marketing (through the workflow the setup makes), and the subscription types it
// unsubscribed them from are put back. `integrations.contact_state` remembers what it did; this
// module holds that state and works out when a contact is no longer needed. The worker makes the
// HubSpot calls.

export type { CleanupStatus };

export interface SubscriptionTypeInfo {
  id: string;
  name: string;
  active: boolean;
}

/** What the setup made or found in the portal (`connection.portal_setup`). */
export interface PortalSetup {
  /** The portal this was found in: a reconnect to another portal starts afresh. */
  portalId?: string;
  subscriptionTypes?: SubscriptionTypeInfo[];
  /** `EM · Temporary marketing contacts`. */
  temporaryListId?: string;
  /** `EM · Set to non-marketing`, which the workflow enrols on. */
  nonMarketingListId?: string;
  workflowId?: string;
  /** Whether the workflow was there and on when last checked. */
  workflowEnabled?: boolean;
  /** Contacts still in `EM · Set to non-marketing` from an earlier night: the workflow is not taking them. */
  nonMarketingWaiting?: number;
  /** The portal's emails saved for the single-send API, the platform's own clones left out (milestone 5). */
  singleSendEmails?: SingleSendTemplate[];
  /** The client's own emails that use the event subscription type, which only the platform's should (at most 10). */
  eventTypeUsedBy?: { id: string; name: string }[];
  checkedAt?: string;
  /** HubSpot's account type (`/account-info/v3/details`): STANDARD, SANDBOX, DEVELOPER_TEST, … */
  accountType?: string | null;
}

export interface CleanupResult {
  at: string;
  /** Contacts the platform created, deleted. */
  deleted: number;
  /** Contacts set back to non-marketing, with their subscriptions put back. */
  restored: number;
  /** Contacts the client has taken into use, left as theirs. */
  kept: number;
  failed: number;
  /** Contacts still needed by an event, not cleaned up yet. */
  waiting: number;
  /** Temporary contacts unsubscribed from subscription types created since. */
  newTypesCovered: number;
  /** Set when the run was for "Clean up and disconnect" and could not finish. */
  error?: string;
}

export interface ContactState {
  email: string;
  contactId: string | null;
  createdByUs: boolean;
  /** Null: never prepared for a HubSpot send (a contact made only for mirroring). */
  marketableBefore: boolean | null;
  subscriptionsBefore: Record<string, string>;
  subscriptionsSet: string[];
  marketingByUsAt: Date | null;
  neededUntil: Date | null;
  status: CleanupStatus;
  reason: string | null;
  /** When the preparation for the first HubSpot send finished; null while its HubSpot writes are not all done. */
  preparedAt: Date | null;
}

/** Merges what the setup found into `portal_setup`, for the generation that ran it. */
export async function recordPortalSetup(tx: Tx, ref: ConnectionRef, patch: PortalSetup): Promise<void> {
  await tx
    .updateTable("integrations.connection")
    .set({ portal_setup: sql`portal_setup || ${JSON.stringify(patch)}::jsonb` })
    .where("id", "=", ref.id)
    .where("generation", "=", ref.generation)
    .where("status", "=", "active")
    .execute();
}

/** What the last cleanup did, for the sync log. */
export async function recordCleanup(tx: Tx, ref: ConnectionRef, result: CleanupResult): Promise<void> {
  await tx.updateTable("integrations.connection").set({ last_cleanup: JSON.stringify(result) }).where("id", "=", ref.id).where("generation", "=", ref.generation).execute();
}

const toState = (r: {
  email: string; contact_id: string | null; created_by_us: boolean; marketable_before: boolean | null; subscriptions_before: unknown; subscriptions_set: string[];
  marketing_by_us_at: Date | null; needed_until: Date | null; cleanup_status: CleanupStatus; cleanup_reason: string | null; prepared_at: Date | null;
}): ContactState => ({
  email: r.email,
  contactId: r.contact_id,
  createdByUs: r.created_by_us,
  marketableBefore: r.marketable_before,
  subscriptionsBefore: (r.subscriptions_before ?? {}) as Record<string, string>,
  subscriptionsSet: r.subscriptions_set,
  marketingByUsAt: r.marketing_by_us_at,
  neededUntil: r.needed_until,
  status: r.cleanup_status,
  reason: r.cleanup_reason,
  preparedAt: r.prepared_at,
});

const stateColumns = [
  "email", "contact_id", "created_by_us", "marketable_before", "subscriptions_before", "subscriptions_set", "marketing_by_us_at", "needed_until", "cleanup_status", "cleanup_reason", "prepared_at",
] as const;

/** The state of these contacts, by email. */
export async function contactStates(tx: Tx, connectionId: string, emails: readonly string[]): Promise<Map<string, ContactState>> {
  if (!emails.length) return new Map();
  const rows = await tx.selectFrom("integrations.contact_state").select(stateColumns).where("connection_id", "=", connectionId).where("email", "in", emails.map(contactKey)).execute();
  return new Map(rows.map((r) => [r.email, toState(r)]));
}

/** Whether the platform created each contact, from the contact sync (`sync_item.created_by_us`). */
export async function createdByUs(tx: Tx, connectionId: string, emails: readonly string[]): Promise<Set<string>> {
  if (!emails.length) return new Set();
  const rows = await tx
    .selectFrom("integrations.sync_item")
    .select("local_key")
    .where("connection_id", "=", connectionId)
    .where("kind", "=", "contact")
    .where("created_by_us", "=", true)
    .where("local_key", "in", emails.map(contactKey))
    .execute();
  return new Set(rows.map((r) => r.local_key));
}

export interface PreparedContact {
  email: string;
  contactId: string;
  createdByUs: boolean;
  marketableBefore: boolean;
  /** The status per type before we changed any (only the types we changed, and any read). */
  subscriptionsBefore: Record<string, string>;
  subscriptionsSet: string[];
}

/**
 * Before the first HubSpot send to a contact (milestone 5 calls this through the worker): what it
 * was, and what the platform changed. A contact that was a marketing contact already is the
 * client's and is never cleaned up (`none`); the others are `pending`. A contact that has a snapshot
 * already keeps it.
 */
export async function recordPrepared(tx: Tx, tenantId: string, ref: ConnectionRef, contacts: readonly PreparedContact[], now = new Date()): Promise<void> {
  for (const c of contacts) {
    const marketing = !c.marketableBefore;
    const values = {
      contact_id: c.contactId,
      created_by_us: c.createdByUs,
      marketable_before: c.marketableBefore,
      subscriptions_before: JSON.stringify(c.subscriptionsBefore),
      subscriptions_set: c.subscriptionsSet,
      marketing_by_us_at: marketing ? now : null,
      cleanup_status: (marketing ? "pending" : "none") as CleanupStatus,
      cleanup_reason: null,
      // A contact that is marketing already needs no HubSpot writes: prepared now. The others once the worker has made them.
      prepared_at: marketing ? null : now,
    };
    await tx
      .insertInto("integrations.contact_state")
      .values({ tenant_id: tenantId, connection_id: ref.id, email: contactKey(c.email), ...values })
      // The first snapshot wins (overlapping sends to one address): a row without one is the
      // nightly cleanup's record of a contact made for mirroring, and takes it.
      .onConflict((oc) => oc.columns(["connection_id", "email"]).doUpdateSet(values).where("integrations.contact_state.marketable_before", "is", null))
      .execute();
  }
}

/** The HubSpot writes of a contact's preparation are all done: from now on it can be sent to. */
export async function recordPreparedDone(tx: Tx, ref: ConnectionRef, emails: readonly string[], now = new Date()): Promise<void> {
  if (!emails.length) return;
  await tx
    .updateTable("integrations.contact_state")
    .set({ prepared_at: now })
    .where("connection_id", "=", ref.id)
    .where("email", "in", emails.map(contactKey))
    .where("prepared_at", "is", null)
    .execute();
}

/** Temporary contacts the platform unsubscribed, for the nightly check of new subscription types. */
export async function temporaryContacts(tx: Tx, connectionId: string): Promise<ContactState[]> {
  const rows = await tx
    .selectFrom("integrations.contact_state")
    .select(stateColumns)
    .where("connection_id", "=", connectionId)
    .where("marketable_before", "=", false)
    .where("cleanup_status", "in", ["pending", "failed"])
    .execute();
  return rows.map(toState);
}

/** More types unsubscribed for a temporary contact (types created in the portal since). */
export async function recordSubscriptionsSet(tx: Tx, ref: ConnectionRef, email: string, before: Record<string, string>, set: readonly string[]): Promise<void> {
  await tx
    .updateTable("integrations.contact_state")
    .set({
      subscriptions_before: sql`subscriptions_before || ${JSON.stringify(before)}::jsonb`,
      subscriptions_set: sql<string[]>`(select array(select distinct unnest(subscriptions_set || ${[...set]}::text[])))`,
    })
    .where("connection_id", "=", ref.id)
    .where("email", "=", contactKey(email))
    .execute();
}

export interface CleanupCandidate extends ContactState {
  /** No invitation or registration needs the contact any more, or (all) the cleanup was asked for now. */
  due: boolean;
}

/**
 * The contacts the cleanup is for, with when each is last needed (docs/hubspot.md, "When a
 * contact is no longer needed"): contacts the platform created, and contacts it made marketing.
 * `needed_until` is the latest end of an occurrence the guest is invited to or registered for,
 * or the day they declined, plus the account's grace period; null when nothing needs the contact
 * (anonymised, removed), which makes it due at once. Kept contacts are the client's and left out.
 * Writes `needed_until` back, creating state rows for created contacts that have none.
 */
export async function cleanupCandidates(tx: Tx, tenantId: string, connectionId: string, graceDays: number, now: Date, all = false): Promise<CleanupCandidate[]> {
  const grace = `${graceDays} days`;
  await sql`
    INSERT INTO integrations.contact_state (tenant_id, connection_id, email, contact_id, created_by_us, cleanup_status)
    SELECT ${tenantId}::uuid, s.connection_id, s.local_key, s.remote_id, true, 'pending'
      FROM integrations.sync_item s
     WHERE s.connection_id = ${connectionId} AND s.kind = 'contact' AND s.created_by_us AND s.remote_id IS NOT NULL
    ON CONFLICT (connection_id, email) DO UPDATE SET created_by_us = true, contact_id = coalesce(integrations.contact_state.contact_id, EXCLUDED.contact_id)
  `.execute(tx);
  await sql`
    UPDATE integrations.contact_state c SET needed_until = (
      SELECT max(t) + ${grace}::interval FROM (
        SELECT (SELECT max(o.end_utc) FROM catalog.occurrence o WHERE o.event_id = i.event_id) AS t
          FROM registration.guest_invitation i WHERE lower(i.email) = c.email AND i.status <> 'declined'
        UNION ALL
        SELECT i.responded_at FROM registration.guest_invitation i WHERE lower(i.email) = c.email AND i.status = 'declined'
        UNION ALL
        SELECT o.end_utc FROM registration.registration r JOIN catalog.occurrence o ON o.id = r.occurrence_id
         WHERE lower(r.email) = c.email AND r.status <> 'cancelled'
      ) needs)
     WHERE c.connection_id = ${connectionId} AND c.cleanup_status IN ('pending', 'failed')
  `.execute(tx);
  const rows = await tx
    .selectFrom("integrations.contact_state")
    .select(stateColumns)
    .where("connection_id", "=", connectionId)
    .where("cleanup_status", "in", ["pending", "failed"])
    .where((eb) => eb.or([eb("created_by_us", "=", true), eb("marketable_before", "=", false)]))
    .orderBy("email")
    .execute();
  return rows.map((r) => {
    const s = toState(r);
    return { ...s, due: all || !s.neededUntil || s.neededUntil <= now };
  });
}

/** Contacts the cleanup will take back later, kept, and failed, for the sync log. */
export async function cleanupCounts(tx: Tx, connectionId: string): Promise<{ pending: number; kept: number; failed: number }> {
  const r = await tx
    .selectFrom("integrations.contact_state")
    .select(sql<number>`count(*) filter (where cleanup_status = 'pending' and (created_by_us or marketable_before = false))::int`.as("pending"))
    .select(sql<number>`count(*) filter (where cleanup_status = 'kept')::int`.as("kept"))
    .select(sql<number>`count(*) filter (where cleanup_status = 'failed')::int`.as("failed"))
    .where("connection_id", "=", connectionId)
    .executeTakeFirstOrThrow();
  // Created contacts the nightly run has not looked at yet count as pending too.
  const unseen = await tx
    .selectFrom("integrations.sync_item as s")
    .select(sql<number>`count(*)::int`.as("n"))
    .where("s.connection_id", "=", connectionId)
    .where("s.kind", "=", "contact")
    .where("s.created_by_us", "=", true)
    .where(({ not, exists, selectFrom }) => not(exists(selectFrom("integrations.contact_state as c").select("c.email").whereRef("c.connection_id", "=", "s.connection_id").whereRef("c.email", "=", "s.local_key"))))
    .executeTakeFirstOrThrow();
  return { pending: r.pending + unseen.n, kept: r.kept, failed: r.failed };
}

const live = (tx: Tx, ref: ConnectionRef) =>
  tx.selectFrom("integrations.connection").select("id").where("id", "=", ref.id).where("generation", "=", ref.generation).where("status", "=", "active").executeTakeFirst();

/**
 * The contact was deleted in HubSpot. Its state and mappings go; if a new invitation marked the
 * contact again since `before`, the contact item stays to be made again, as new.
 */
export async function recordContactDeleted(tx: Tx, ref: ConnectionRef, email: string, before: string): Promise<void> {
  if (!(await live(tx, ref))) return;
  const key = contactKey(email);
  await tx.deleteFrom("integrations.contact_state").where("connection_id", "=", ref.id).where("email", "=", key).execute();
  const remarked = await tx
    .updateTable("integrations.sync_item")
    .set({ remote_id: null, created_by_us: null, dirty: true, attempts: 0, last_error: null })
    .where("connection_id", "=", ref.id)
    .where("kind", "=", "contact")
    .where("local_key", "=", key)
    .where("updated_at", ">", sql<Date>`${before}::timestamptz`)
    .executeTakeFirst();
  if (!Number(remarked.numUpdatedRows)) {
    await tx.deleteFrom("integrations.sync_item").where("connection_id", "=", ref.id).where("kind", "=", "contact").where("local_key", "=", key).execute();
  }
  // HubSpot drops the deleted contact's attendance and memberships with it.
  await tx
    .deleteFrom("integrations.sync_item")
    .where("connection_id", "=", ref.id)
    .where((eb) => eb.or([eb.and([eb("kind", "=", "attendance"), eb("local_key", "like", `%:${key}`)]), eb.and([eb("kind", "=", "segment_member"), eb("local_key", "like", `%|${key}`)])]))
    .execute();
}

/** Set back to non-marketing with its subscriptions put back: the cleanup is done with the contact. */
export async function recordContactRestored(tx: Tx, ref: ConnectionRef, email: string): Promise<void> {
  if (!(await live(tx, ref))) return;
  await tx.deleteFrom("integrations.contact_state").where("connection_id", "=", ref.id).where("email", "=", contactKey(email)).execute();
}

/** The client has taken the contact into use, or the account keeps mirrored contacts: never touched again. */
export async function recordContactKept(tx: Tx, ref: ConnectionRef, email: string, reason: string): Promise<void> {
  if (!(await live(tx, ref))) return;
  await tx
    .updateTable("integrations.contact_state")
    .set({ cleanup_status: "kept", cleanup_reason: reason.slice(0, 1000), cleanup_at: sql<Date>`now()` })
    .where("connection_id", "=", ref.id)
    .where("email", "=", contactKey(email))
    .execute();
}

/** HubSpot refused part of the cleanup; the next night tries again. */
export async function recordCleanupFailed(tx: Tx, ref: ConnectionRef, email: string, error: string): Promise<void> {
  if (!(await live(tx, ref))) return;
  await tx
    .updateTable("integrations.contact_state")
    .set({ cleanup_status: "failed", cleanup_reason: error.slice(0, 1000), cleanup_at: sql<Date>`now()` })
    .where("connection_id", "=", ref.id)
    .where("email", "=", contactKey(email))
    .execute();
}

/** List ids that are the platform's own: the event segments and the two cleanup segments. */
export async function ownListIds(tx: Tx, connectionId: string, setup: PortalSetup): Promise<Set<string>> {
  const rows = await tx.selectFrom("integrations.sync_item").select("remote_id").where("connection_id", "=", connectionId).where("kind", "=", "segment").where("remote_id", "is not", null).execute();
  const ids = new Set(rows.map((r) => r.remote_id!));
  if (setup.temporaryListId) ids.add(setup.temporaryListId);
  if (setup.nonMarketingListId) ids.add(setup.nonMarketingListId);
  return ids;
}
