import { type Db, withTenant } from "@event-manager/db";
import { integrations } from "@event-manager/domain";
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
  /** HubSpot's status id from an earlier attempt of this job. */
  statusId: string | null;
  saveStatusId(statusId: string): Promise<void>;
  /** The job's last attempt: give up on HubSpot and let the platform send, rather than fail. */
  lastAttempt: boolean;
}

export type GuestSendResult = { sent: true; statusId: string } | { sent: false; reason: string };

/** Reads of a send's status per job attempt before the job tries again later. */
const POLLS = 5;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const draft = (e: unknown) => e instanceof HubSpotError && e.status === 400 && /draft state/i.test(e.message);
const fallback = (reason: string): GuestSendResult => ({ sent: false, reason });

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
 */
export async function sendThroughHubSpot(db: Db, tenantId: string, deps: HubSpotDeps, g: GuestSend): Promise<GuestSendResult> {
  const t = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db, { tenantId }, fn);
  const email = integrations.contactKey(g.email);
  if (!g.statusId && hubspotRefusesAddress(email)) return fallback("HubSpot does not send to addresses with a +");
  const pollMs = deps.pollMs ?? 2000;
  // Set once HubSpot has taken the send: from then on the guest has it, or will.
  let taken = g.statusId;

  try {
    const run = await withHubSpot(db, tenantId, deps.client, async (accessToken, connection): Promise<GuestSendResult> => {
      const ref = { id: connection.id, generation: connection.generation };
      const client = deps.client;
      let statusId = g.statusId;

      if (!statusId) {
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
        statusId = accepted.statusId;
        taken = statusId;
        await g.saveStatusId(statusId);
        await t((tx) => integrations.markEmailSentFrom(tx, connection.id, g.eventId, g.kind));
        if (accepted.status === "COMPLETE") return result(accepted);
      }

      for (let i = 0; i < POLLS; i++) {
        if (pollMs) await sleep(pollMs);
        const s = await client.sendStatus(accessToken, statusId);
        if (s.status === "COMPLETE" || s.status === "CANCELED") return result(s);
      }
      // HubSpot accepted it and is still working on it: it will most likely go.
      if (g.lastAttempt) return { sent: true, statusId };
      throw new Error(`HubSpot is still processing send ${statusId}`);
    });
    return run?.value ?? fallback("HubSpot is not connected, or refuses our access");
  } catch (e) {
    if (!g.lastAttempt) throw e;
    // Out of attempts. If HubSpot took the send, the guest has it (or will); otherwise the platform sends.
    if (taken) return { sent: true, statusId: taken };
    return fallback(draft(e) ? "HubSpot did not accept the published email in time" : `HubSpot did not answer: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function result(s: SendStatus): GuestSendResult {
  if (s.status === "COMPLETE" && s.sendResult && (SENT_RESULTS as readonly string[]).includes(s.sendResult)) return { sent: true, statusId: s.statusId };
  return fallback(`HubSpot did not send it: ${s.sendResult ?? s.status}`);
}
