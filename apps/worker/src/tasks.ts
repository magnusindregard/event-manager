import type { Task, TaskList } from "graphile-worker";
import { type Db, withTenant } from "@event-manager/db";
import { outbox } from "@event-manager/domain";
import type { InternalHandler } from "./handlers.js";
import { HORIZON_TASK, horizonTask } from "./horizon.js";
import { HUBSPOT_CLEANUP_TASK, HUBSPOT_NIGHTLY_CLEANUP_TASK, hubspotCleanupTask, hubspotNightlyCleanupTask } from "./hubspot/cleanup.js";
import { HUBSPOT_EMAILS_TASK, HUBSPOT_MARKETING_CHECK_TASK, hubspotEmailsTask, hubspotMarketingCheckTask } from "./hubspot/emails.js";
import { HUBSPOT_GUEST_LIST_TASK, hubspotGuestListTask } from "./hubspot/guest-lists.js";
import { HUBSPOT_RECONCILE_TASK, hubspotReconcileTask } from "./hubspot/reconcile.js";
import { HUBSPOT_SETUP_TASK, type HubSpotDeps, hubspotSetupTask } from "./hubspot/setup.js";
import { HUBSPOT_SYNC_TASK, hubspotSyncTask } from "./hubspot/sync.js";
import { INVITATION_EMAIL_TASK, invitationEmailTask } from "./invitation-email.js";
import { OCCURRENCE_NOTICE_TASK, occurrenceNoticeTask } from "./occurrence-notice.js";
import { PROVISION_TASK, type ProvisionDeps, provisionTask } from "./provision.js";
import { REGISTRATION_EMAIL_TASK, type RegistrationEmailDeps, registrationEmailTask } from "./registration-email.js";
import { REMINDER_TASK, reminderTask } from "./reminder.js";
import { RESERVATION_SWEEP_TASK, reservationSweepTask } from "./reservations.js";
import { RETENTION_TASK, retentionTask } from "./retention.js";
import { RESOLVE_TASK, resolveTask } from "./resolver.js";
import { TICKETS_EMAIL_TASK, ticketsEmailTask } from "./tickets-email.js";
import { OFFER_EXPIRY_TASK, offerExpiryTask } from "./waitlist.js";
import {
  abandonPaymentTask, PAYMENT_ABANDON_TASK, PAYMENT_PROCESS_TASK, PAYMENT_RECEIPT_TASK, PAYMENTS_RECONCILE_TASK, type PaymentsWorkerDeps, processPaymentTask, receiptTask, reconcileTask,
} from "./payments.js";

interface DispatchPayload {
  eventId: string;
  tenantId: string;
}

function isDispatchPayload(p: unknown): p is DispatchPayload {
  return typeof p === "object" && p !== null && typeof (p as DispatchPayload).eventId === "string" && typeof (p as DispatchPayload).tenantId === "string";
}

/** outbox.dispatch: enqueued by the outbox insert trigger, runs under the event's tenant. */
export function dispatchTask(db: Db, handlers: InternalHandler[]): Task {
  return async (payload, helpers) => {
    if (!isDispatchPayload(payload)) throw new Error("Invalid outbox.dispatch payload");
    await withTenant(db, { tenantId: payload.tenantId }, async (tx) => {
      const event = await outbox.loadEvent(tx, payload.eventId);
      if (!event) {
        helpers.logger.warn(`outbox event ${payload.eventId} not found`);
        return;
      }
      for (const h of handlers) {
        if (h.types !== "*" && !h.types.includes(event.type)) continue;
        if (!(await outbox.claimHandling(tx, h.name, event))) continue;
        await h.handle(tx, event, { info: (m, meta) => helpers.logger.info(`${m} ${meta ? JSON.stringify(meta) : ""}`) });
      }
      await outbox.markDispatched(tx, event.id);
    });
  };
}

export function buildTaskList(db: Db, handlers: InternalHandler[], provision?: ProvisionDeps, registrationEmail?: RegistrationEmailDeps, hubspotDeps: HubSpotDeps | null = null, paymentsDeps: PaymentsWorkerDeps | null = null): TaskList {
  // The links in the event's HubSpot emails go to the same attendee pages as the platform's own.
  const hubspot = hubspotDeps ? { ...hubspotDeps, attendeeUrl: hubspotDeps.attendeeUrl ?? registrationEmail?.attendeeUrl } : null;
  return {
    "outbox.dispatch": dispatchTask(db, handlers),
    [HORIZON_TASK]: horizonTask(db),
    [RESOLVE_TASK]: resolveTask(db),
    [RETENTION_TASK]: retentionTask(db),
    [OFFER_EXPIRY_TASK]: offerExpiryTask(db),
    [RESERVATION_SWEEP_TASK]: reservationSweepTask(db),
    // Always registered: jobs queued by a connection never sit unknown when HubSpot is not configured.
    [HUBSPOT_SETUP_TASK]: hubspotSetupTask(db, hubspot),
    [HUBSPOT_SYNC_TASK]: hubspotSyncTask(db, hubspot),
    [HUBSPOT_RECONCILE_TASK]: hubspotReconcileTask(db, hubspot),
    [HUBSPOT_CLEANUP_TASK]: hubspotCleanupTask(db, hubspot),
    [HUBSPOT_NIGHTLY_CLEANUP_TASK]: hubspotNightlyCleanupTask(db, hubspot),
    [HUBSPOT_EMAILS_TASK]: hubspotEmailsTask(db, hubspot),
    [HUBSPOT_MARKETING_CHECK_TASK]: hubspotMarketingCheckTask(db, hubspot),
    [HUBSPOT_GUEST_LIST_TASK]: hubspotGuestListTask(db, hubspot),
    ...(provision ? { [PROVISION_TASK]: provisionTask(db, provision) } : {}),
    ...(paymentsDeps
      ? {
          [PAYMENT_PROCESS_TASK]: processPaymentTask(db, paymentsDeps),
          [PAYMENTS_RECONCILE_TASK]: reconcileTask(db, paymentsDeps),
          [PAYMENT_RECEIPT_TASK]: receiptTask(db, paymentsDeps),
          [PAYMENT_ABANDON_TASK]: abandonPaymentTask(db, paymentsDeps),
        }
      : {}),
    ...(registrationEmail
      ? {
          [REGISTRATION_EMAIL_TASK]: registrationEmailTask(db, registrationEmail),
          [OCCURRENCE_NOTICE_TASK]: occurrenceNoticeTask(db, registrationEmail),
          [INVITATION_EMAIL_TASK]: invitationEmailTask(db, registrationEmail, hubspot),
          [REMINDER_TASK]: reminderTask(db, registrationEmail, undefined, hubspot),
          [TICKETS_EMAIL_TASK]: ticketsEmailTask(db, registrationEmail),
        }
      : {}),
  };
}
