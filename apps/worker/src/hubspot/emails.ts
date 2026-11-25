import type { Task } from "graphile-worker";
import { type Db, sql, type Tx, withTenant } from "@event-manager/db";
import { DomainError, integrations } from "@event-manager/domain";
import { type HubSpotClient, HubSpotError, SINGLE_SEND_TYPE } from "@event-manager/hubspot";
import type { InternalHandler } from "../handlers.js";
import { withHubSpot } from "./session.js";
import type { HubSpotDeps } from "./setup.js";

// HubSpot sending, milestone 5 (docs/hubspot.md, "Template emails" and "The event's own emails").
// The setup reads which of the portal's emails are saved for the single-send API: the templates
// the account can choose from. When an event sends through HubSpot, the platform makes the
// event's own email per kind from its template: a clone, named for the event, with subject and
// preview text, the placeholders replaced by the event's links, published (a draft cannot be
// sent, run 7). An email is made again while nothing has been sent from it; the event's emails
// are deleted when it is archived or goes back to the platform before anything was sent.
//
// Also the check, before anything is sent, of how many guests would become marketing contacts.

export const HUBSPOT_EMAILS_TASK = "hubspot.event_emails";
export const HUBSPOT_MARKETING_CHECK_TASK = "hubspot.marketing_check";

/** The platform's own emails in the portal are named like this; they are never offered as templates. */
export const OWN_EMAIL_PREFIX = "EM · ";

/** Literal text in a template that the platform replaces in the event's email. */
export const PLACEHOLDERS = {
  invitationLink: "[[em:invitation_link]]",
  manageLink: "[[em:manage_link]]",
  eventLink: "[[em:event_link]]",
} as const;

const KIND_NAMES: Record<integrations.EmailKind, string> = { invitation: "Invitation", reminder: "Reminder", welcome: "Welcome" };

type InTenant = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
const inTenant = (db: Db, tenantId: string): InTenant => (fn) => withTenant(db, { tenantId }, fn);
const itemRefusal = (e: unknown): e is HubSpotError => e instanceof HubSpotError && !e.retryable && !e.unauthorized;
const text = (content: unknown) => JSON.stringify(content ?? {});

/**
 * Reads the portal's single-send emails (the templates to choose from, the platform's own clones
 * left out) and the client's emails that use the event subscription type, into `portal_setup`.
 */
export async function readSingleSendEmails(client: HubSpotClient, accessToken: string, connection: integrations.Connection, t: InTenant): Promise<void> {
  const all = (await client.listEmails(accessToken)).filter((e) => !e.name.startsWith(OWN_EMAIL_PREFIX));
  const singleSendEmails: integrations.SingleSendTemplate[] = [];
  for (const e of all.filter((x) => x.type === SINGLE_SEND_TYPE).slice(0, 50)) {
    const full = (await client.getEmail(accessToken, e.id)) ?? e;
    const body = text(full.content);
    singleSendEmails.push({
      id: e.id, name: e.name, subscriptionId: full.subscriptionId ?? e.subscriptionId,
      hasInvitationLink: body.includes(PLACEHOLDERS.invitationLink), hasManageLink: body.includes(PLACEHOLDERS.manageLink),
    });
  }
  const eventType = connection.settings.eventSubscriptionTypeId;
  const eventTypeUsedBy = eventType ? all.filter((e) => e.type !== SINGLE_SEND_TYPE && e.subscriptionId === eventType).slice(0, 10).map((e) => ({ id: e.id, name: e.name })) : [];
  await t((tx) => integrations.recordPortalSetup(tx, { id: connection.id, generation: connection.generation }, { portalId: connection.portalId, singleSendEmails, eventTypeUsedBy }));
}

/** Pure: the template's content with the placeholders replaced by the event's links. */
export function fillPlaceholders(content: unknown, links: { attendeeUrl: string; eventUrl: string }): unknown {
  const base = links.attendeeUrl.replace(/\/+$/, "");
  const filled = text(content)
    .split(PLACEHOLDERS.invitationLink).join(`${base}/i/{{ custom.invitation_token }}`)
    .split(PLACEHOLDERS.manageLink).join(`${base}/m/{{ custom.manage_token }}`)
    .split(PLACEHOLDERS.eventLink).join(JSON.stringify(links.eventUrl).slice(1, -1));
  return JSON.parse(filled);
}

/** Pure: sets the preview text, which is a module in the content (spike run 1). False when the email has none. */
export function setPreviewText(content: unknown, previewText: string): boolean {
  const widget = (content as { widgets?: { preview_text?: { body?: Record<string, unknown> } } } | null)?.widgets?.preview_text;
  if (!widget) return false;
  widget.body = { ...(widget.body ?? {}), value: previewText };
  return true;
}

/** Pure: what staff should know about an email made from a template. */
export function emailWarnings(kind: integrations.EmailKind, content: unknown, subscriptionId: string | null, eventType: string | null, hasPreview: boolean, previewText: string, hasEventUrl: boolean): string[] {
  const body = text(content);
  const w: string[] = [];
  if (kind !== "welcome" && !body.includes(PLACEHOLDERS.invitationLink)) w.push(`The template has no ${PLACEHOLDERS.invitationLink}: guests get no link to answer with`);
  if (kind === "welcome" && !body.includes(PLACEHOLDERS.manageLink)) w.push(`The template has no ${PLACEHOLDERS.manageLink}: guests get no link to their ticket and QR code`);
  if (eventType && subscriptionId !== eventType) w.push("The template does not use the subscription type for event emails");
  if (previewText && !hasPreview) w.push("The template has no preview text module, so the preview text was not set");
  if (!hasEventUrl && body.includes(PLACEHOLDERS.eventLink)) w.push(`The event has no external URL, so ${PLACEHOLDERS.eventLink} links to the attendee site`);
  return w;
}

/** Makes, remakes or deletes the event's HubSpot emails so they match what the event wants. */
export async function syncEventEmails(db: Db, tenantId: string, eventId: string, deps: HubSpotDeps): Promise<void> {
  const t = inTenant(db, tenantId);
  const client = deps.client;
  const attendeeUrl = deps.attendeeUrl ?? "http://localhost:3020";
  await withHubSpot(db, tenantId, client, async (accessToken, connection) => {
    const ref = { id: connection.id, generation: connection.generation };
    let plan: integrations.EventSendingPlan;
    try {
      plan = await t((tx) => integrations.eventSendingPlan(tx, connection, eventId));
    } catch (e) {
      if (e instanceof DomainError && e.code === "not_found") return;
      throw e;
    }
    const existing = await t((tx) => integrations.eventEmails(tx, connection.id, eventId));
    const archived = plan.event.status === "archived";
    const off = archived || plan.channel !== "hubspot";

    // Archived: every email goes, sent ones too (their sends stay on the contacts' timelines).
    // Back on the platform, or a kind no longer wanted: only emails nothing was sent from.
    for (const e of existing) {
      const unwanted = off || !(e.kind in plan.wanted);
      if (!unwanted || (e.firstSentAt && !archived)) continue;
      if (e.remoteId) await client.deleteEmail(accessToken, e.remoteId);
      await t((tx) => integrations.dropEventEmail(tx, ref, eventId, e.kind));
    }
    if (off) return;

    const eventType = connection.settings.eventSubscriptionTypeId;
    const eventUrl = plan.event.externalUrl ?? attendeeUrl;
    for (const [kind, want] of Object.entries(plan.wanted) as [integrations.EmailKind, { templateId: string | null; texts: integrations.EmailTexts }][]) {
      const e = existing.find((x) => x.kind === kind);
      if (e?.firstSentAt) continue; // sent from: settled
      const name = `${OWN_EMAIL_PREFIX}${plan.title} · ${KIND_NAMES[kind]}`;
      if (!want.templateId) {
        if (e?.remoteId) await client.deleteEmail(accessToken, e.remoteId);
        await t((tx) => integrations.saveEventEmail(tx, tenantId, ref, eventId, kind, {
          templateId: e?.templateId ?? "", remoteId: null, name: null, subject: null, previewText: null, status: "failed",
          error: `No template email is chosen for the ${KIND_NAMES[kind].toLowerCase()}: the platform sends it`, warnings: [],
        }));
        continue;
      }
      const same = e?.status === "ready" && e.templateId === want.templateId && e.name === name && e.subject === want.texts.subject && (e.previewText ?? "") === want.texts.previewText;
      if (same) continue;
      try {
        if (e?.remoteId) await client.deleteEmail(accessToken, e.remoteId);
        const template = await client.getEmail(accessToken, want.templateId);
        if (!template) throw new HubSpotError(`HubSpot has no template email ${want.templateId} any more: choose another`, 404);
        const id = await client.cloneEmail(accessToken, want.templateId, name);
        // Recorded at once, so a failure further on still knows which email to delete.
        const base = { templateId: want.templateId, remoteId: id, name, subject: want.texts.subject, previewText: want.texts.previewText };
        await t((tx) => integrations.saveEventEmail(tx, tenantId, ref, eventId, kind, { ...base, status: "pending", error: null, warnings: [] }));
        const clone = (await client.getEmail(accessToken, id)) ?? template;
        const content = fillPlaceholders(clone.content, { attendeeUrl, eventUrl });
        const hasPreview = setPreviewText(content, want.texts.previewText);
        const warnings = emailWarnings(kind, clone.content, clone.subscriptionId, eventType, hasPreview, want.texts.previewText, !!plan.event.externalUrl);
        await client.updateEmail(accessToken, id, { subject: want.texts.subject, content });
        await client.publishEmail(accessToken, id);
        await t((tx) => integrations.saveEventEmail(tx, tenantId, ref, eventId, kind, { ...base, status: "ready", error: null, warnings }));
      } catch (err) {
        if (!itemRefusal(err)) throw err;
        const after = (await t((tx) => integrations.eventEmails(tx, connection.id, eventId))).find((x) => x.kind === kind);
        await t((tx) => integrations.saveEventEmail(tx, tenantId, ref, eventId, kind, {
          templateId: want.templateId!, remoteId: after?.remoteId ?? null, name, subject: want.texts.subject, previewText: want.texts.previewText,
          status: "failed", error: err.message, warnings: [],
        }));
      }
    }
  });
}

/** Counts, before anything is sent, how many of the event's guests are not marketing contacts yet. */
export async function checkMarketing(db: Db, tenantId: string, eventId: string, deps: HubSpotDeps, now = new Date()): Promise<integrations.MarketingCheck | null> {
  const t = inTenant(db, tenantId);
  const done = await withHubSpot(db, tenantId, deps.client, async (accessToken) => {
    const emails = await t((tx) => integrations.guestEmails(tx, eventId));
    const plus = emails.filter((e) => e.split("@")[0]!.includes("+"));
    const rest = emails.filter((e) => !plus.includes(e));
    let marketing = 0;
    for (let i = 0; i < rest.length; i += 100) {
      for (const c of (await deps.client.contactsByEmail(accessToken, rest.slice(i, i + 100))).values()) if (c.marketable) marketing++;
    }
    const check: integrations.MarketingCheck = { checkedAt: now.toISOString(), guests: rest.length, marketing, wouldBecome: rest.length - marketing, plusAddresses: plus.length };
    await t((tx) => integrations.recordMarketingCheck(tx, eventId, check));
    return check;
  });
  return done?.value ?? null;
}

// ── Jobs ────────────────────────────────────────────────────────────────────

export async function queueEventEmails(tx: Tx, tenantId: string, eventId: string): Promise<void> {
  await sql`select graphile_worker.add_job(
    ${HUBSPOT_EMAILS_TASK},
    json_build_object('tenantId', ${tenantId}::text, 'eventId', ${eventId}::text),
    run_at := now() + interval '2 seconds',
    job_key := ${`hubspot-emails:${eventId}`},
    max_attempts := 8)`.execute(tx);
}

const str = (v: unknown) => (typeof v === "string" ? v : null);

/** What makes the event's HubSpot emails worth looking at again. */
export const queueHubSpotEmails: InternalHandler = {
  name: "queue-hubspot-emails",
  types: ["integration.event_sending_changed.v1", "integration.marketing_check_requested.v1", "integration.changed.v1", "integration.setup_requested.v1", "event.changed.v1", "event.published.v1", "event.cancelled.v1"],
  async handle(tx, event) {
    const d = event.data as Record<string, unknown>;
    if (event.type === "integration.marketing_check_requested.v1") {
      const eventId = str(d.eventId);
      if (!eventId) return;
      await sql`select graphile_worker.add_job(
        ${HUBSPOT_MARKETING_CHECK_TASK},
        json_build_object('tenantId', ${event.tenantId}::text, 'eventId', ${eventId}::text),
        job_key := ${`hubspot-marketing-check:${eventId}`},
        max_attempts := 5)`.execute(tx);
      return;
    }
    if (event.type === "integration.event_sending_changed.v1") {
      const eventId = str(d.eventId);
      if (eventId) await queueEventEmails(tx, event.tenantId, eventId);
      return;
    }
    const target = await integrations.syncTarget(tx, "hubspot");
    if (!target) return;
    if (event.type.startsWith("integration.")) {
      // The account's default templates or the event type changed, or the setup ran again.
      if (str(d.provider) !== "hubspot" || (event.type === "integration.changed.v1" && str(d.change) !== "settings")) return;
      for (const eventId of await integrations.eventsWithHubSpotEmails(tx, target.id)) await queueEventEmails(tx, event.tenantId, eventId);
      return;
    }
    // The event changed (title, reminder setting, archived): only events with HubSpot emails care.
    const eventId = str(d.id);
    if (!eventId) return;
    const has = (await integrations.eventChannel(tx, eventId)) === "hubspot" || (await integrations.eventEmails(tx, target.id, eventId)).length > 0;
    if (has) await queueEventEmails(tx, event.tenantId, eventId);
  },
};

interface Payload {
  tenantId: string;
  eventId: string;
}
const isPayload = (p: unknown): p is Payload => typeof p === "object" && p !== null && typeof (p as Payload).tenantId === "string" && typeof (p as Payload).eventId === "string";

export function hubspotEmailsTask(db: Db, deps: HubSpotDeps | null): Task {
  return async (payload, helpers) => {
    if (!isPayload(payload)) throw new Error(`Invalid ${HUBSPOT_EMAILS_TASK} payload`);
    if (!deps) return;
    await syncEventEmails(db, payload.tenantId, payload.eventId, deps);
    helpers.logger.info(`hubspot emails checked for event ${payload.eventId}`);
  };
}

export function hubspotMarketingCheckTask(db: Db, deps: HubSpotDeps | null): Task {
  return async (payload) => {
    if (!isPayload(payload)) throw new Error(`Invalid ${HUBSPOT_MARKETING_CHECK_TASK} payload`);
    if (!deps) return;
    try {
      await checkMarketing(db, payload.tenantId, payload.eventId, deps);
    } catch (e) {
      if (!itemRefusal(e)) throw e;
      await withTenant(db, { tenantId: payload.tenantId }, (tx) =>
        integrations.recordMarketingCheck(tx, payload.eventId, { checkedAt: new Date().toISOString(), guests: 0, marketing: 0, wouldBecome: 0, plusAddresses: 0, error: e.message }),
      );
    }
  };
}
