import type { Task } from "graphile-worker";
import { type Db, sql, type Tx, withoutTenant, withTenant } from "@event-manager/db";
import { integrations } from "@event-manager/domain";
import { CLEANUP_SCOPES, type ContactUsage, type HubSpotClient, HubSpotError, type SubscriptionState, type SubscriptionWrite } from "@event-manager/hubspot";
import type { InternalHandler } from "../handlers.js";
import { withHubSpot } from "./session.js";
import type { HubSpotDeps } from "./setup.js";

// Cleanup after HubSpot sending (docs/hubspot.md, milestone 4): what the platform does to a
// contact before its first HubSpot send, and how it takes that back once no event needs the
// contact. Also the setup of the two cleanup segments and the workflow that sets contacts back
// to non-marketing, and "Clean up and disconnect".

export const TEMPORARY_LIST = "EM · Temporary marketing contacts";
export const NON_MARKETING_LIST = "EM · Set to non-marketing";
export const NON_MARKETING_WORKFLOW = "EM · Set to non-marketing";

/** Run for "Clean up and disconnect": one keyed job per account. */
export const HUBSPOT_CLEANUP_TASK = "hubspot.cleanup";
// Crontab task names may not contain dots, so the nightly one uses a colon.
export const HUBSPOT_NIGHTLY_CLEANUP_TASK = "hubspot:cleanup";
/** Nightly at 04:30 UTC, after the segment reconcile (04:00). */
export const HUBSPOT_CLEANUP_CRONTAB = `30 4 * * * ${HUBSPOT_NIGHTLY_CLEANUP_TASK}`;

type InTenant = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
const inTenant = (db: Db, tenantId: string): InTenant => (fn) => withTenant(db, { tenantId }, fn);
const hasCleanupScopes = (c: integrations.Connection) => CLEANUP_SCOPES.every((s) => c.scopes.includes(s));
/** What the setup recorded, if it was recorded for this portal. */
const setupOf = (c: integrations.Connection): integrations.PortalSetup => (c.portalSetup.portalId === c.portalId ? c.portalSetup : {});
const itemRefusal = (e: unknown): e is HubSpotError => e instanceof HubSpotError && !e.retryable && !e.unauthorized;

async function ownList(client: HubSpotClient, accessToken: string, known: string | undefined, name: string): Promise<string> {
  if (known) {
    try {
      await client.listMembers(accessToken, known);
      return known;
    } catch (e) {
      if (!(e instanceof HubSpotError && e.status === 404)) throw e;
    }
  }
  // The name is the platform's: a static list by that name is ours from an earlier connection.
  const found = await client.findListByName(accessToken, name);
  if (found?.processingType === "MANUAL") return found.listId;
  return (await client.createList(accessToken, name)).listId;
}

/**
 * The cleanup's part of the setup, with the cleanup scopes: the portal's subscription types, the
 * two segments, and the workflow on `EM · Set to non-marketing`, made or switched on again.
 * Without the scopes it records that there is nothing to set up.
 */
export async function setUpCleanup(client: HubSpotClient, accessToken: string, connection: integrations.Connection, t: InTenant): Promise<void> {
  const ref = { id: connection.id, generation: connection.generation };
  if (!hasCleanupScopes(connection)) {
    await t((tx) => integrations.recordPortalSetup(tx, ref, { portalId: connection.portalId, subscriptionTypes: [], checkedAt: new Date().toISOString() }));
    return;
  }
  const known = setupOf(connection);
  const subscriptionTypes = await client.subscriptionTypes(accessToken);
  const temporaryListId = await ownList(client, accessToken, known.temporaryListId, TEMPORARY_LIST);
  const nonMarketingListId = await ownList(client, accessToken, known.nonMarketingListId, NON_MARKETING_LIST);
  let flow = known.workflowId ? await client.getWorkflow(accessToken, known.workflowId) : null;
  if (!flow) flow = await client.createNonMarketingWorkflow(accessToken, NON_MARKETING_WORKFLOW, nonMarketingListId);
  else if (!flow.enabled) await client.enableWorkflow(accessToken, flow.id);
  await t((tx) =>
    integrations.recordPortalSetup(tx, ref, {
      portalId: connection.portalId, subscriptionTypes, temporaryListId, nonMarketingListId, workflowId: flow.id, workflowEnabled: true, checkedAt: new Date().toISOString(),
    }),
  );
}

// ── Before a HubSpot send ───────────────────────────────────────────────────

export interface SendReadiness {
  /** Why the account cannot send through HubSpot yet; null when it can. */
  blocker: string | null;
}

/** What HubSpot sending needs from the cleanup: its scopes, the event subscription type and the setup. */
export function sendReadiness(connection: integrations.Connection): SendReadiness {
  if (!hasCleanupScopes(connection)) return { blocker: `The cleanup scopes are not granted: ${CLEANUP_SCOPES.filter((s) => !connection.scopes.includes(s)).join(", ")}` };
  if (!connection.settings.eventSubscriptionTypeId) return { blocker: "No subscription type is chosen for event emails" };
  const setup = setupOf(connection);
  if (!setup.temporaryListId || !setup.nonMarketingListId || !setup.workflowId) return { blocker: "The cleanup is not set up in the portal: repair setup" };
  if (setup.workflowEnabled === false) return { blocker: `The workflow ${NON_MARKETING_WORKFLOW} is off or missing in HubSpot: repair setup` };
  return { blocker: null };
}

/**
 * Before the first HubSpot send to each guest (milestone 5 calls this, after the contact sync):
 * reads whether each contact is a marketing contact already. Those that are not are unsubscribed
 * from every subscription type but the event type, and put in `EM · Temporary marketing
 * contacts`; what they were is recorded first, so the cleanup can put it back. Contacts prepared
 * before, or kept by the client, are left as they are. Returns whether each was marketing before.
 */
export async function prepareForSend(
  tenantId: string,
  client: HubSpotClient,
  accessToken: string,
  connection: integrations.Connection,
  t: InTenant,
  guests: readonly { email: string; contactId: string }[],
): Promise<Map<string, boolean>> {
  const ready = sendReadiness(connection);
  if (ready.blocker) throw new Error(ready.blocker);
  const ref = { id: connection.id, generation: connection.generation };
  const setup = setupOf(connection);
  const eventType = connection.settings.eventSubscriptionTypeId!;
  const emails = guests.map((g) => integrations.contactKey(g.email));
  const [states, created] = await t(async (tx) => [await integrations.contactStates(tx, ref.id, emails), await integrations.createdByUs(tx, ref.id, emails)]);

  const out = new Map<string, boolean>();
  const fresh: { email: string; contactId: string }[] = [];
  for (const g of guests) {
    const email = integrations.contactKey(g.email);
    const s = states.get(email);
    if (s?.status === "kept") out.set(email, true);
    else if (s && s.marketableBefore !== null) out.set(email, s.marketableBefore);
    else fresh.push({ email, contactId: g.contactId });
  }
  if (!fresh.length) return out;

  const marketable = new Map<string, boolean>();
  for (let i = 0; i < fresh.length; i += 100) {
    for (const [id, m] of await client.marketableStatuses(accessToken, fresh.slice(i, i + 100).map((g) => g.contactId))) marketable.set(id, m);
  }
  const temporary = fresh.filter((g) => marketable.get(g.contactId) === false);
  const types = (await client.subscriptionTypes(accessToken)).filter((x) => x.active && x.id !== eventType);
  const statuses = await client.subscriptionStatuses(accessToken, temporary.map((g) => g.email));

  const writes: SubscriptionWrite[] = [];
  const prepared: integrations.PreparedContact[] = [];
  for (const g of fresh) {
    const before: Record<string, string> = {};
    const set: string[] = [];
    const isTemporary = marketable.get(g.contactId) === false;
    if (isTemporary) {
      const current = statuses.get(g.email) ?? new Map<string, SubscriptionState>();
      for (const type of types) {
        const was = current.get(type.id) ?? "NOT_SPECIFIED";
        if (was === "UNSUBSCRIBED") continue;
        before[type.id] = was;
        set.push(type.id);
        writes.push({ email: g.email, subscriptionId: type.id, status: "UNSUBSCRIBED" });
      }
    }
    prepared.push({ email: g.email, contactId: g.contactId, createdByUs: created.has(g.email), marketableBefore: !isTemporary, subscriptionsBefore: before, subscriptionsSet: set });
    out.set(g.email, !isTemporary);
  }
  // Recorded before anything changes, so a failure half way leaves the cleanup knowing what to undo.
  await t((tx) => integrations.recordPrepared(tx, tenantId, ref, prepared));
  if (writes.length) await client.setSubscriptionStatuses(accessToken, writes);
  if (temporary.length) await client.addToList(accessToken, setup.temporaryListId!, temporary.map((g) => g.contactId));
  return out;
}

// ── The cleanup ─────────────────────────────────────────────────────────────

/** Why a contact the platform created is the client's now, or null (docs/hubspot.md, "Cleaning up a contact"). */
function inUse(u: ContactUsage, ownLists: Set<string>, tenantId: string): string | null {
  if (u.owner) return "It has an owner in HubSpot";
  if (u.associations > 0) return "It is associated with companies, deals or tickets";
  if (u.conversions > 0) return "It has form submissions";
  if (u.listIds.some((id) => !ownLists.has(id))) return "It is in the client's own lists";
  if (u.marketingEvents.some((e) => e.externalAccountId !== tenantId)) return "It takes part in the client's own marketing events";
  return null;
}

/** Puts back the subscription types the platform unsubscribed, where the guest has not changed them since; then queues non-marketing. */
async function restore(client: HubSpotClient, accessToken: string, setup: integrations.PortalSetup, c: integrations.CleanupCandidate): Promise<string | null> {
  if (!setup.nonMarketingListId || !setup.temporaryListId) throw new HubSpotError("The cleanup is not set up in the portal: repair setup", 409);
  if (!c.contactId) throw new HubSpotError("No HubSpot contact id is known for the contact", 409);
  const current = (await client.subscriptionStatuses(accessToken, [c.email])).get(c.email) ?? new Map<string, SubscriptionState>();
  const back = c.subscriptionsSet.filter((id) => (current.get(id) ?? "NOT_SPECIFIED") === "UNSUBSCRIBED");
  const plain = back.filter((id) => (c.subscriptionsBefore[id] ?? "NOT_SPECIFIED") !== "SUBSCRIBED");
  if (plain.length) await client.setSubscriptionStatuses(accessToken, plain.map((id) => ({ email: c.email, subscriptionId: id, status: "NOT_SPECIFIED" })));
  let note: string | null = null;
  for (const id of back.filter((x) => !plain.includes(x))) {
    try {
      await client.setSubscriptionStatuses(accessToken, [{ email: c.email, subscriptionId: id, status: "SUBSCRIBED" }]);
    } catch (e) {
      // HubSpot does not let an app subscribe anyone (spike run 15): the guest can do it themselves.
      if (!itemRefusal(e)) throw e;
      note = "HubSpot did not let the platform subscribe the guest again to a type they were subscribed to";
    }
  }
  await client.addToList(accessToken, setup.nonMarketingListId, [c.contactId]);
  await client.removeFromList(accessToken, setup.temporaryListId, [c.contactId]);
  return note;
}

/**
 * One account's cleanup: subscription types created since are covered, the workflow checked, and
 * every contact no event needs any more (or every contact, with `all`) taken back. A refusal for
 * one contact is recorded on it and tried again the next night; HubSpot being down fails the run.
 */
export async function runCleanup(db: Db, tenantId: string, deps: HubSpotDeps, opts: { all?: boolean; now?: Date } = {}): Promise<{ result: integrations.CleanupResult; ref: integrations.ConnectionRef } | null> {
  const now = opts.now ?? new Date();
  const t = inTenant(db, tenantId);
  const client = deps.client;
  const run = await withHubSpot(db, tenantId, client, async (accessToken, connection) => {
    const ref = { id: connection.id, generation: connection.generation };
    const settings = connection.settings;
    const result: integrations.CleanupResult = { at: now.toISOString(), deleted: 0, restored: 0, kept: 0, failed: 0, waiting: 0, newTypesCovered: 0 };
    let setup = setupOf(connection);

    if (hasCleanupScopes(connection) && setup.temporaryListId) {
      const types = await client.subscriptionTypes(accessToken);
      const health: integrations.PortalSetup = { subscriptionTypes: types, checkedAt: now.toISOString() };
      if (setup.workflowId) health.workflowEnabled = (await client.getWorkflow(accessToken, setup.workflowId))?.enabled === true;
      if (setup.nonMarketingListId) {
        try {
          health.nonMarketingWaiting = (await client.listMembers(accessToken, setup.nonMarketingListId)).length;
        } catch (e) {
          if (!(e instanceof HubSpotError && e.status === 404)) throw e;
          health.workflowEnabled = false;
        }
      }
      await t((tx) => integrations.recordPortalSetup(tx, ref, health));
      setup = { ...setup, ...health };

      // Types created in the portal since a contact was prepared: unsubscribe it from those too.
      const eventType = settings.eventSubscriptionTypeId;
      const temps = await t((tx) => integrations.temporaryContacts(tx, ref.id));
      const active = types.filter((x) => x.active && x.id !== eventType);
      const behind = temps.filter((c) => active.some((x) => !(x.id in c.subscriptionsBefore) && !c.subscriptionsSet.includes(x.id)));
      if (behind.length) {
        const statuses = await client.subscriptionStatuses(accessToken, behind.map((c) => c.email));
        for (const c of behind) {
          const current = statuses.get(c.email) ?? new Map<string, SubscriptionState>();
          const fresh = active.filter((x) => !(x.id in c.subscriptionsBefore) && !c.subscriptionsSet.includes(x.id) && current.get(x.id) !== "UNSUBSCRIBED");
          if (!fresh.length) continue;
          await client.setSubscriptionStatuses(accessToken, fresh.map((x) => ({ email: c.email, subscriptionId: x.id, status: "UNSUBSCRIBED" as const })));
          await t((tx) => integrations.recordSubscriptionsSet(tx, ref, c.email, Object.fromEntries(fresh.map((x) => [x.id, current.get(x.id) ?? "NOT_SPECIFIED"])), fresh.map((x) => x.id)));
          result.newTypesCovered++;
        }
      }
    }

    // The database's clock: a contact marked again after this is needed again.
    const before = await t(async (tx) => (await sql<{ now: string }>`select now()::text as now`.execute(tx)).rows[0]!.now);
    const candidates = await t((tx) => integrations.cleanupCandidates(tx, tenantId, ref.id, settings.cleanupGraceDays, now, opts.all));
    const own = await t((tx) => integrations.ownListIds(tx, ref.id, setup));

    for (const c of candidates) {
      if (!c.due) {
        result.waiting++;
        continue;
      }
      try {
        if (c.createdByUs && c.contactId) {
          // Made only for mirroring, never sent to through HubSpot.
          if (c.marketableBefore === null && !settings.deleteMirroredContacts) {
            await t((tx) => integrations.recordContactKept(tx, ref, c.email, "The account keeps contacts the platform made for mirroring"));
            result.kept++;
            continue;
          }
          const usage = await client.contactUsage(accessToken, c.contactId, c.email);
          const reason = usage.missing ? null : inUse(usage, own, tenantId);
          if (!reason) {
            if (!usage.missing) await client.deleteContact(accessToken, c.contactId);
            await t((tx) => integrations.recordContactDeleted(tx, ref, c.email, before));
            result.deleted++;
            continue;
          }
          // The client's now: treated as one the platform made marketing, and then left alone.
          const note = c.marketableBefore === false ? await restore(client, accessToken, setup, c) : null;
          await t((tx) => integrations.recordContactKept(tx, ref, c.email, note ? `${reason}. ${note}` : reason));
          result.kept++;
        } else if (c.marketableBefore === false) {
          const note = await restore(client, accessToken, setup, c);
          if (note) await t((tx) => integrations.recordContactKept(tx, ref, c.email, note));
          else await t((tx) => integrations.recordContactRestored(tx, ref, c.email));
          result.restored++;
        }
      } catch (e) {
        if (!itemRefusal(e)) throw e;
        await t((tx) => integrations.recordCleanupFailed(tx, ref, c.email, e.message));
        result.failed++;
      }
    }
    await t((tx) => integrations.recordCleanup(tx, ref, result));
    return { result, ref };
  });
  return run?.value ?? null;
}

// ── Jobs ────────────────────────────────────────────────────────────────────

/** "Clean up and disconnect": one keyed job per account. */
export const queueHubSpotCleanup: InternalHandler = {
  name: "queue-hubspot-cleanup",
  types: ["integration.cleanup_requested.v1"],
  async handle(tx, event) {
    if ((event.data as { provider?: string }).provider !== "hubspot") return;
    await sql`select graphile_worker.add_job(
      ${HUBSPOT_CLEANUP_TASK},
      json_build_object('tenantId', ${event.tenantId}::text, 'disconnect', true),
      job_key := ${`hubspot-cleanup:${event.tenantId}`},
      max_attempts := 8)`.execute(tx);
  },
};

interface Payload {
  tenantId: string;
  disconnect?: boolean;
}
const isPayload = (p: unknown): p is Payload => typeof p === "object" && p !== null && typeof (p as Payload).tenantId === "string";

/**
 * Cleans up every contact at once, then disconnects in the name of the owner who asked. If a
 * contact could not be cleaned up, the connection stays, with the request dropped and the
 * reason in the sync log, so the owner can look before disconnecting anyway.
 */
export function hubspotCleanupTask(db: Db, deps: HubSpotDeps | null): Task {
  return async (payload, helpers) => {
    if (!isPayload(payload)) throw new Error(`Invalid ${HUBSPOT_CLEANUP_TASK} payload`);
    if (!deps) return;
    const { tenantId } = payload;
    const t = inTenant(db, tenantId);
    const done = await runCleanup(db, tenantId, deps, { all: true });
    if (!done || !payload.disconnect) return;
    const { result, ref } = done;
    if (result.failed) {
      const error = `${result.failed} contacts could not be cleaned up, so HubSpot is still connected`;
      await t(async (tx) => {
        await integrations.recordCleanup(tx, ref, { ...result, error });
        await integrations.cancelCleanupDisconnect(tx, ref);
      });
      helpers.logger.warn(`hubspot cleanup for ${tenantId}: ${error}`);
      return;
    }
    const closed = await t((tx) => integrations.disconnectAfterCleanup(tx, tenantId, ref, result));
    if (closed?.refreshToken) await deps.client.revoke(closed.refreshToken).catch((e: unknown) => helpers.logger.warn(`revoking the HubSpot token failed: ${String(e)}`));
    helpers.logger.info(`hubspot cleaned up (${result.deleted} deleted, ${result.restored} set back, ${result.kept} kept) and disconnected for ${tenantId}`);
  };
}

/** The nightly cleanup, for every account with a live connection. */
export function hubspotNightlyCleanupTask(db: Db, deps: HubSpotDeps | null): Task {
  return async (_payload, helpers) => {
    if (!deps) return;
    const tenants = await withoutTenant(db, (tx) => integrations.connectedTenants(tx, "hubspot"));
    let failed = 0;
    for (const tenantId of tenants) {
      try {
        const r = await runCleanup(db, tenantId, deps);
        if (r && (r.result.deleted || r.result.restored || r.result.kept || r.result.failed)) {
          helpers.logger.info(`hubspot cleanup ${tenantId}: ${r.result.deleted} deleted, ${r.result.restored} set back, ${r.result.kept} kept, ${r.result.failed} failed`);
        }
      } catch (e) {
        failed++;
        helpers.logger.error(`hubspot cleanup ${tenantId} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (failed) throw new Error(`HubSpot cleanup failed for ${failed} accounts`);
  };
}
