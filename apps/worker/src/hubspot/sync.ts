import type { Task } from "graphile-worker";
import { type Db, sql, type Tx, withTenant } from "@event-manager/db";
import { integrations, type outbox } from "@event-manager/domain";
import { type AttendanceState, HubSpotError } from "@event-manager/hubspot";
import type { InternalHandler } from "../handlers.js";
import { withHubSpot } from "./session.js";
import type { HubSpotDeps } from "./setup.js";

// HubSpot connector milestone 2 (docs/hubspot.md): contacts, one marketing event per occurrence,
// and attendance. The outbox handler marks what should change in integrations.sync_item, in the
// event's transaction, and queues one sync job per account a few seconds later; the job pushes
// what is dirty in batches. A busy RSVP hour thus costs a handful of calls, and a replayed event
// marks nothing new.

export const HUBSPOT_SYNC_TASK = "hubspot.sync";

/** How long the sync job waits for more changes to collect before it runs. */
const COLLECT_SECONDS = 5;

const TYPES = [
  "invitation.sent.v1",
  "registration.confirmed.v1",
  "registration.cancelled.v1",
  "registration.changed.v1",
  "registration.waitlisted.v1",
  "registration.offered.v1",
  "event.published.v1",
  "event.changed.v1",
  "event.cancelled.v1",
  "occurrence.created.v1",
  "occurrence.changed.v1",
  "occurrence.deleted.v1",
  "occurrence.relocated.v1",
  "integration.connected.v1",
  "integration.resync_requested.v1",
  "integration.sync_requested.v1",
] as const;

/** Queues the account's sync job, keeping the time of one already queued so a stream of changes cannot postpone it. */
export async function queueSync(tx: Tx, tenantId: string, delaySeconds = COLLECT_SECONDS): Promise<void> {
  await sql`select graphile_worker.add_job(
    ${HUBSPOT_SYNC_TASK},
    json_build_object('tenantId', ${tenantId}::text),
    run_at := now() + make_interval(secs => ${delaySeconds}),
    job_key := ${`hubspot-sync:${tenantId}`},
    job_key_mode := 'preserve_run_at',
    max_attempts := 10)`.execute(tx);
}

const str = (v: unknown) => (typeof v === "string" ? v : null);

/** Whether an event's occurrences should have marketing events: published or cancelled after publishing, or already synced. */
async function eventIsSynced(tx: Tx, connectionId: string, eventId: string): Promise<boolean> {
  const e = await tx.selectFrom("catalog.event").select("status").where("id", "=", eventId).executeTakeFirst();
  if (e && (e.status === "published" || e.status === "cancelled")) return true;
  const synced = await tx
    .selectFrom("integrations.sync_item as s")
    .innerJoin("catalog.occurrence as o", (j) => j.on(sql`o.id::text`, "=", sql.ref("s.local_key")))
    .select("s.local_key")
    .where("s.connection_id", "=", connectionId)
    .where("s.kind", "=", "marketing_event")
    .where("o.event_id", "=", eventId)
    .limit(1)
    .executeTakeFirst();
  return !!synced;
}

async function onEvent(tx: Tx, target: integrations.SyncTarget, event: outbox.DomainEvent): Promise<boolean> {
  const d = event.data as Record<string, unknown>;
  const tenantId = event.tenantId;

  if (event.type === "integration.connected.v1" || event.type === "integration.resync_requested.v1") {
    if (str(d.provider) !== "hubspot") return false;
    await integrations.markForBackfill(tx, tenantId, target);
    return true;
  }

  // "Retry" in the sync log: the items are marked already; only the job needs running.
  if (event.type === "integration.sync_requested.v1") return str(d.provider) === "hubspot";

  if (event.type === "invitation.sent.v1") {
    if (!target.settings.syncInvitedGuests) return false;
    const id = str(d.invitationId);
    const inv = id ? await tx.selectFrom("registration.guest_invitation").select(["email", "name"]).where("id", "=", id).executeTakeFirst() : null;
    if (!inv) return false;
    await integrations.markContact(tx, tenantId, target.id, inv);
    return true;
  }

  if (event.type.startsWith("registration.")) {
    const id = str(d.registrationId);
    const r = id
      ? await tx.selectFrom("registration.registration").select(["occurrence_id", "event_id", "email", "name", "status", "invitation_id"]).where("id", "=", id).executeTakeFirst()
      : null;
    if (!r?.email) return false; // gone or anonymised
    if (!(r.invitation_id ? target.settings.syncInvitedGuests : target.settings.syncOpenAttendees)) return false;
    if (!(await eventIsSynced(tx, target.id, r.event_id))) return false;
    if (r.status === "confirmed") await integrations.markContact(tx, tenantId, target.id, { email: r.email, name: r.name });
    await integrations.markMarketingEvent(tx, tenantId, target.id, r.occurrence_id);
    await integrations.markAttendance(tx, tenantId, target.id, r.occurrence_id, r.email, r.status === "confirmed" ? "registered" : "cancelled");
    // Moved to another occurrence: no longer coming to the one it left.
    const from = str(d.occurrenceId);
    if (from && from !== r.occurrence_id) await integrations.markAttendance(tx, tenantId, target.id, from, r.email, "cancelled");
    return true;
  }

  if (event.type.startsWith("event.")) {
    const eventId = str(d.id);
    if (!eventId || !(await eventIsSynced(tx, target.id, eventId))) return false;
    const since = new Date(Date.now() - 24 * 3600_000);
    const occ = await tx.selectFrom("catalog.occurrence").select("id").where("event_id", "=", eventId).where("end_utc", ">=", since).execute();
    for (const o of occ) await integrations.markMarketingEvent(tx, tenantId, target.id, o.id);
    return occ.length > 0;
  }

  if (event.type.startsWith("occurrence.")) {
    const occurrenceId = str(d.id);
    const eventId = str(d.eventId);
    if (!occurrenceId || !eventId) return false;
    const known = (await integrations.remoteIds(tx, target.id, "marketing_event", [occurrenceId])).size > 0;
    if (!known && !(await eventIsSynced(tx, target.id, eventId))) return false;
    if (event.type === "occurrence.deleted.v1" && !known) return false;
    await integrations.markMarketingEvent(tx, tenantId, target.id, occurrenceId);
    return true;
  }
  return false;
}

/** Marks what an outbox event changes in HubSpot and queues the account's sync job. */
export const queueHubSpotSync: InternalHandler = {
  name: "hubspot-sync",
  types: TYPES,
  async handle(tx, event) {
    const target = await integrations.syncTarget(tx, "hubspot");
    if (!target) return;
    if (await onEvent(tx, target, event)) await queueSync(tx, event.tenantId);
  },
};

interface Payload {
  tenantId: string;
}
const isPayload = (p: unknown): p is Payload => typeof p === "object" && p !== null && typeof (p as Payload).tenantId === "string";

const STATE: Record<integrations.AttendanceTarget, AttendanceState> = { registered: "register", cancelled: "cancel", attended: "attend" };

function splitName(name: unknown): { firstname: string | null; lastname: string | null } {
  const parts = typeof name === "string" ? name.trim().split(/\s+/).filter(Boolean) : [];
  if (!parts.length) return { firstname: null, lastname: null };
  return { firstname: parts[0]!, lastname: parts.length > 1 ? parts.slice(1).join(" ") : null };
}

/** A refusal that concerns the items in the call, as opposed to the connection or HubSpot being down. */
const itemRefusal = (e: unknown): e is HubSpotError => e instanceof HubSpotError && !e.retryable && !e.unauthorized;

/**
 * Pushes the account's dirty items: contacts first (attendance needs them, and the cleanup needs
 * to know who created each one), then marketing events, then attendance for contacts and events
 * HubSpot has. Queues itself again while it is making progress and more is waiting.
 */
export function hubspotSyncTask(db: Db, deps: HubSpotDeps | null): Task {
  return async (payload, helpers) => {
    if (!isPayload(payload)) throw new Error(`Invalid ${HUBSPOT_SYNC_TASK} payload`);
    if (!deps) {
      helpers.logger.warn("HubSpot is not configured (HUBSPOT_CLIENT_ID); sync skipped");
      return;
    }
    const { tenantId } = payload;
    const scope = { tenantId };
    const t = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(db, scope, fn);

    const run = await withHubSpot(db, tenantId, deps.client, async (accessToken, connection) => {
      const ref = { id: connection.id, generation: connection.generation };
      let pushed = 0;

      // Contacts.
      const contacts = await t((tx) => integrations.dirtyItems(tx, ref.id, "contact", 100));
      if (contacts.length) {
        try {
          const results = await deps.client.upsertContacts(
            accessToken,
            contacts.map((c) => ({ email: String(c.data.email ?? c.localKey), ...splitName(c.data.name) })),
          );
          const byEmail = new Map(results.map((r) => [r.email, r]));
          await t(async (tx) => {
            for (const c of contacts) {
              const r = byEmail.get(c.localKey);
              if (r) await integrations.recordSynced(tx, ref, c, { remoteId: r.id, createdByUs: r.created });
              else await integrations.recordFailed(tx, ref, c, "HubSpot returned no contact for this email");
            }
          });
          pushed += results.length;
        } catch (e) {
          if (!itemRefusal(e)) throw e;
          await t(async (tx) => {
            for (const c of contacts) await integrations.recordFailed(tx, ref, c, e.message);
          });
        }
      }

      // Marketing events.
      const events = await t((tx) => integrations.dirtyItems(tx, ref.id, "marketing_event", 50));
      if (events.length) {
        const sources = await t((tx) => integrations.marketingEventSources(tx, events.map((e) => e.localKey)));
        for (const item of events) {
          const src = sources.get(item.localKey);
          try {
            if (!src) {
              // The occurrence was deleted.
              if (item.remoteId) await deps.client.cancelMarketingEvent(accessToken, tenantId, item.localKey);
              await t((tx) => (item.remoteId ? integrations.recordSynced(tx, ref, item, {}) : integrations.recordSkipped(tx, ref, item)));
              continue;
            }
            if (src.eventStatus !== "published" && src.eventStatus !== "cancelled") {
              // Unpublished or archived: HubSpot keeps what it has.
              await t((tx) => integrations.recordSkipped(tx, ref, item));
              continue;
            }
            const saved = await deps.client.saveMarketingEvent(
              accessToken,
              {
                externalAccountId: tenantId,
                externalEventId: src.occurrenceId,
                eventName: src.title,
                eventOrganizer: src.organizer,
                eventType: "In person",
                startDateTime: src.startUtc!,
                endDateTime: src.endUtc!,
                eventUrl: src.externalUrl,
                eventCancelled: src.eventStatus === "cancelled" || src.occurrenceStatus === "cancelled",
              },
              !!item.remoteId,
            );
            await t((tx) => integrations.recordSynced(tx, ref, item, { remoteId: saved.objectId ?? item.remoteId }));
            pushed++;
          } catch (e) {
            if (!itemRefusal(e)) throw e;
            await t((tx) => integrations.recordFailed(tx, ref, item, e.message));
          }
        }
      }

      // Attendance, once HubSpot has both the contact and the marketing event. Recording it by
      // email would otherwise create the contact in HubSpot behind our back.
      const attendance = await t((tx) => integrations.dirtyItems(tx, ref.id, "attendance", 500));
      if (attendance.length) {
        const emails = [...new Set(attendance.map((a) => String(a.data.email)))];
        const occurrences = [...new Set(attendance.map((a) => String(a.data.occurrenceId)))];
        const [haveContact, haveEvent] = await t(async (tx) => [
          await integrations.remoteIds(tx, ref.id, "contact", emails),
          await integrations.remoteIds(tx, ref.id, "marketing_event", occurrences),
        ]);
        const groups = new Map<string, typeof attendance>();
        for (const a of attendance) {
          const email = String(a.data.email);
          const occurrenceId = String(a.data.occurrenceId);
          if (!haveContact.has(email) || !haveEvent.has(occurrenceId)) continue; // waits for the next run
          const key = `${occurrenceId}|${String(a.data.target)}`;
          groups.set(key, [...(groups.get(key) ?? []), a]);
        }
        for (const [key, items] of groups) {
          const [occurrenceId, target] = key.split("|") as [string, integrations.AttendanceTarget];
          for (let i = 0; i < items.length; i += 100) {
            const chunk = items.slice(i, i + 100);
            try {
              await deps.client.recordAttendance(accessToken, tenantId, occurrenceId, STATE[target], chunk.map((a) => String(a.data.email)), new Date());
              await t(async (tx) => {
                for (const a of chunk) await integrations.recordSynced(tx, ref, a, { syncedState: target });
              });
              pushed += chunk.length;
            } catch (e) {
              if (!itemRefusal(e)) throw e;
              await t(async (tx) => {
                for (const a of chunk) await integrations.recordFailed(tx, ref, a, e.message);
              });
            }
          }
        }
      }

      const more = pushed > 0 && (await t((tx) => integrations.hasDirty(tx, ref.id)));
      return { pushed, more };
    });

    if (!run) return; // not connected, or waiting for a reconnect: the items wait
    if (run.value.more) await t((tx) => queueSync(tx, tenantId, 0));
    if (run.value.pushed) helpers.logger.info(`hubspot sync pushed ${run.value.pushed} item(s) for ${tenantId}`);
  };
}
