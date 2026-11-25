import { type Db, sql, withTenant } from "@event-manager/db";
import { integrations, registration } from "@event-manager/domain";
import type { InternalHandler } from "../handlers.js";
import { INVITATION_EMAIL_TASK } from "../invitation-email.js";
import { REMINDER_TASK } from "../reminder.js";
import { CLEANUP_SCOPES, HubSpotError, SENT_RESULTS, type SendStatus } from "@event-manager/hubspot";
import { prepareForSend } from "./cleanup.js";
import { queueEventEmails } from "./emails.js";
import { withHubSpot } from "./session.js";
import type { HubSpotDeps } from "./setup.js";

// HubSpot sending, milestone 5 (docs/hubspot.md, "Sending to a guest"): one email to one guest
// through the single-send API. The invitation, reminder and welcome jobs call this when their
// event sends through HubSpot, and send the platform's own email instead when it says so.
//
// Per guest: the contact is upserted (recording whether the platform made it), its subscription
// to the event type is checked, then the cleanup's preparation runs (what it was, and out of
// every other subscription type if it is not a marketing contact yet), and only then the send,
// with our own id as `sendId`. HubSpot's status id is kept before the result is read, so a
// retried job reads that result instead of sending again.

export interface GuestSend {
  kind: integrations.EmailKind;
  eventId: string;
  email: string;
  name: string | null;
  /** Our id for the send (the invitation send, or the registration for the welcome): HubSpot's `sendId`. */
  sendId: string;
  customProperties: Record<string, string>;
  /** What HubSpot took earlier for this send, if it did: its status id and the portal that took it. */
  taken: { statusId: string; portalId: string | null } | null;
  saveStatusId(statusId: string, portalId: string): Promise<void>;
  /** The job's last attempt: give up on HubSpot and let the platform send, rather than fail. */
  lastAttempt: boolean;
}

/**
 * `pending`: HubSpot took the send and has not said whether it went. Neither sent nor refused,
 * so the platform sends nothing. `recheck`: we are connected to the portal that took it, so the
 * caller checks again later; otherwise (our access to that portal went) it stays unresolved
 * until that portal is connected again.
 */
export type GuestSendResult =
  | { sent: true; statusId: string }
  | { sent: false; pending?: false; reason: string }
  | { sent: false; pending: true; recheck: boolean; statusId: string; reason: string };

/** Reads of a send's status per job attempt before the job tries again later. */
const POLLS = 5;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const draft = (e: unknown) => e instanceof HubSpotError && e.status === 400 && /draft state/i.test(e.message);
const fallback = (reason: string): GuestSendResult => ({ sent: false, reason });
const unresolved = (statusId: string, recheck: boolean, reason: string): GuestSendResult => ({ sent: false, pending: true, recheck, statusId, reason });
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** HubSpot refuses addresses with a plus (spike run 12): the platform sends to those without asking. */
export const hubspotRefusesAddress = (email: string) => (email.split("@")[0] ?? "").includes("+");

function splitName(name: string | null): { firstname: string | null; lastname: string | null } {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstname: null, lastname: null };
  return { firstname: parts.slice(0, -1).join(" ") || parts[0]!, lastname: parts.length > 1 ? parts.at(-1)! : null };
}

/**
 * Sends one guest's email through HubSpot, or says why the platform should send it instead.
 * Throws (so the job is retried) when HubSpot is down, rate limits us, has not accepted the
 * published email yet, or has not finished the send; on the job's last attempt it gives up instead.
 *
 * Once HubSpot has taken the send, only HubSpot's own answer settles it: the platform never sends
 * a second email for it. Without that answer the send is `pending` (see GuestSendResult).
 */
export async function sendThroughHubSpot(db: Db, tenantId: string, deps: HubSpotDeps | null, g: GuestSend): Promise<GuestSendResult> {
  const t = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db, { tenantId }, fn);
  const email = integrations.contactKey(g.email);
  let taken = g.taken;
  if (!deps) {
    return taken ? unresolved(taken.statusId, false, "HubSpot took the send, but HubSpot is not configured on this platform any more") : fallback("HubSpot is not configured on this platform");
  }
  if (!taken && hubspotRefusesAddress(email)) return fallback("HubSpot does not send to addresses with a +");
  const pollMs = deps.pollMs ?? 2000;

  try {
    const run = await withHubSpot(db, tenantId, deps.client, async (accessToken, connection): Promise<GuestSendResult> => {
      const ref = { id: connection.id, generation: connection.generation };
      const client = deps.client;
      // Only the portal that took a send can say how it went.
      if (taken?.portalId && taken.portalId !== connection.portalId) {
        return unresolved(taken.statusId, false, `HubSpot portal ${taken.portalId} took the send, and another portal is connected now. Reconnecting portal ${taken.portalId} checks it again`);
      }

      if (!taken) {
        const blocker = integrations.sendingBlocker(connection, CLEANUP_SCOPES);
        if (blocker) return fallback(blocker);
        const ready = await t((tx) => integrations.readyEmail(tx, connection.id, g.eventId, g.kind));
        if (!ready) {
          await t((tx) => queueEventEmails(tx, tenantId, g.eventId));
          return fallback(`The event's ${g.kind} email is not ready in HubSpot`);
        }

        const [contact] = await client.upsertContacts(accessToken, [{ email, ...splitName(g.name) }]);
        if (!contact) return fallback("HubSpot returned no contact for the address");
        await t((tx) => integrations.recordContactFromSend(tx, tenantId, ref, { email, name: g.name, id: contact.id, created: contact.created }));

        // A refused send still makes the contact a marketing contact (runs 7–9), so never try one HubSpot would refuse.
        const eventType = connection.settings.eventSubscriptionTypeId!;
        const subs = (await client.subscriptionStatuses(accessToken, [email])).get(email);
        if (subs?.get(eventType) === "UNSUBSCRIBED") return fallback("The guest has unsubscribed from event emails in HubSpot");

        await prepareForSend(tenantId, client, accessToken, connection, t, [{ email, contactId: contact.id }]);

        let accepted: SendStatus;
        try {
          accepted = await client.singleSend(accessToken, { emailId: ready.remoteId!, to: email, sendId: g.sendId, customProperties: g.customProperties });
        } catch (e) {
          // A 403 here is the plan or a scope refusing single-send, not our token (which just worked).
          if (e instanceof HubSpotError && (e.status === 403 || (!e.retryable && !e.unauthorized && !draft(e)))) return fallback(`HubSpot refused the send: ${e.message}`);
          throw e;
        }
        taken = { statusId: accepted.statusId, portalId: connection.portalId };
        await g.saveStatusId(accepted.statusId, connection.portalId);
        await t((tx) => integrations.markEmailSentFrom(tx, connection.id, g.eventId, g.kind));
        if (accepted.status === "COMPLETE" || accepted.status === "CANCELED") return result(accepted);
      }

      const statusId = taken.statusId;
      try {
        for (let i = 0; i < POLLS; i++) {
          if (pollMs) await sleep(pollMs);
          const s = await client.sendStatus(accessToken, statusId);
          if (s.status === "COMPLETE" || s.status === "CANCELED") return result(s);
        }
      } catch (e) {
        // Connected, but HubSpot failed to answer: check again later rather than give up.
        if (!g.lastAttempt) throw e;
        return unresolved(statusId, true, `HubSpot did not say how the send went: ${message(e)}. Checked again later`);
      }
      // Still processing: HubSpot can yet cancel it, so it is not sent until HubSpot says so.
      if (!g.lastAttempt) throw new Error(`HubSpot is still processing send ${statusId}`);
      return unresolved(statusId, true, "HubSpot is still processing the send. Checked again later");
    });
    if (run) return run.value;
    // HubSpot took the send before our access went (disconnected, refused): it may still deliver
    // it, or cancel it. The job tries again, and after its last try a reconnect resumes it.
    if (taken) {
      if (!g.lastAttempt) throw new Error(`HubSpot access is gone; send ${taken.statusId} is read again later`);
      return unresolved(taken.statusId, false, "HubSpot took the send, but our access went before it said whether it went out. Reconnecting checks it again");
    }
    return fallback("HubSpot is not connected, or refuses our access");
  } catch (e) {
    if (!g.lastAttempt) throw e;
    // Out of attempts. If HubSpot took the send, it is unresolved and checked again later; otherwise the platform sends.
    if (taken) return unresolved(taken.statusId, true, `HubSpot took the send, but did not say whether it went out: ${message(e)}. Checked again later`);
    return fallback(draft(e) ? "HubSpot did not accept the published email in time" : `HubSpot did not answer: ${message(e)}`);
  }
}

function result(s: SendStatus): GuestSendResult {
  if (s.status === "COMPLETE" && s.sendResult && (SENT_RESULTS as readonly string[]).includes(s.sendResult)) return { sent: true, statusId: s.statusId };
  return fallback(`HubSpot did not send it: ${s.sendResult ?? s.status}`);
}

// ── Sends left unresolved ───────────────────────────────────────────────────

/**
 * Once a portal is connected again, the sends it took but never confirmed are read again: their
 * jobs are queued anew under their own keys, and find HubSpot's status id on the send.
 */
export const resumeHubSpotSends: InternalHandler = {
  name: "resume-hubspot-sends",
  types: ["integration.connected.v1"],
  async handle(tx, event, log) {
    const { provider, portalId } = event.data as { provider?: string; portalId?: string };
    if (provider !== "hubspot" || !portalId) return;
    // Only sends the reconnected portal took: another portal cannot say how they went.
    const { sends, welcomes } = await registration.unresolvedProviderSends(tx, portalId);
    for (const id of sends) {
      await sql`select graphile_worker.add_job(
        ${INVITATION_EMAIL_TASK},
        json_build_object('tenantId', ${event.tenantId}::text, 'sendId', ${id}::text),
        job_key := ${`invsend:${id}`},
        max_attempts := 8)`.execute(tx);
    }
    for (const id of welcomes) {
      await sql`select graphile_worker.add_job(
        ${REMINDER_TASK},
        json_build_object('tenantId', ${event.tenantId}::text, 'registrationId', ${id}::text),
        job_key := ${`reminder:${id}`},
        max_attempts := 10)`.execute(tx);
    }
    if (sends.length || welcomes.length) log.info("unresolved HubSpot sends queued again", { sends: sends.length, welcomes: welcomes.length });
  },
};
