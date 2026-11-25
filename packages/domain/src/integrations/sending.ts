import { type HubSpotEmailKind, type SendChannel, sql, type Tx } from "@event-manager/db";
import * as catalog from "../catalog/index.js";
import { emit } from "../outbox/index.js";
import { type ActorContext, DomainError } from "../shared/index.js";
import { assertCan, getAccount, recordAudit } from "../tenancy/index.js";
import { type Connection, type ConnectionRef, loadConnection } from "./index.js";
import { contactKey } from "./sync.js";

// HubSpot sending (docs/hubspot.md, milestone 5). Per event, the staff choose who sends its
// invitations, reminders and welcome: the platform (default) or HubSpot's single-send API. On
// HubSpot the platform makes the event's own emails from the account's template emails (clones
// with the event's links, published), and sends one per guest, timed by the platform. Everything
// else (confirmations, changes, cancellations, waitlist) stays with the platform.
//
// This module holds the event's choice, its emails' state and what the last check of its guests
// found. The worker makes the HubSpot calls; the registration module records each send.

export type EmailKind = HubSpotEmailKind;
export type { SendChannel };
export const EMAIL_KINDS: readonly EmailKind[] = ["invitation", "reminder", "welcome"];

/** A template email the setup found: saved for the single-send API in the portal. */
export interface SingleSendTemplate {
  id: string;
  name: string;
  subscriptionId: string | null;
  /** The content has `[[em:invitation_link]]`. */
  hasInvitationLink: boolean;
  /** The content has `[[em:manage_link]]` (for the welcome). */
  hasManageLink: boolean;
}

export interface EmailTexts {
  subject: string;
  previewText: string;
}

/** What the last check of the event's guests in HubSpot found, before anything is sent. */
export interface MarketingCheck {
  checkedAt: string;
  /** Guests HubSpot would send to: not declined, no plus address. */
  guests: number;
  /** Already marketing contacts: nothing changes for them. */
  marketing: number;
  /** Not marketing contacts yet (or no contact at all): a HubSpot send makes them ones. */
  wouldBecome: number;
  /** Guests with a `+` in their address, whom HubSpot refuses: the platform sends to them. */
  plusAddresses: number;
  error?: string;
}

export interface EventEmail {
  kind: EmailKind;
  templateId: string;
  remoteId: string | null;
  name: string | null;
  subject: string | null;
  previewText: string | null;
  status: "pending" | "ready" | "failed";
  error: string | null;
  warnings: string[];
  firstSentAt: Date | null;
}

export interface EventSending {
  eventId: string;
  channel: SendChannel;
  /** The event's own choice of template per kind; missing: the account's default. */
  templates: Partial<Record<EmailKind, string>>;
  /** The template each kind uses: the event's, else the account's default; null: none chosen. */
  effectiveTemplates: Record<EmailKind, string | null>;
  /** Subject and preview text per kind, as set or as made from the event. */
  texts: Record<EmailKind, EmailTexts>;
  /** Kinds whose subject and preview text were set by staff. */
  customTexts: EmailKind[];
  marketingCheck: MarketingCheck | null;
  /** An invitation has been sent: the channel can no longer change. */
  locked: boolean;
  emails: EventEmail[];
  /** Why HubSpot cannot be chosen for this event; null when it can. */
  hubspotBlocker: string | null;
  portalId: string | null;
  /** 0 until the event's sending is first saved. */
  version: number;
}

export interface EventSendingPatch {
  channel?: SendChannel;
  templates?: Partial<Record<EmailKind, string | null>>;
  texts?: Partial<Record<EmailKind, { subject: string; previewText?: string } | null>>;
}

const live = (c: Connection) => (c.portalSetup.portalId === c.portalId ? c.portalSetup : {});

/** The account's default template per kind (Settings → Integrations). */
export const defaultTemplates = (c: Connection | null): Record<EmailKind, string | null> => ({
  invitation: c?.settings.invitationTemplateId ?? null,
  reminder: c?.settings.reminderTemplateId ?? null,
  welcome: c?.settings.welcomeTemplateId ?? null,
});

/**
 * Why the account cannot send through HubSpot, or null. `cleanupScopes` are the scopes the
 * cleanup needs (`CLEANUP_SCOPES` in @event-manager/hubspot): sending without the cleanup would
 * leave marketing contacts behind.
 */
export function sendingBlocker(c: Connection | null, cleanupScopes: readonly string[]): string | null {
  if (!c || c.status === "disconnected") return "HubSpot is not connected";
  if (c.status === "needs_reconnect") return "HubSpot refuses our access: reconnect in Settings → Integrations";
  const missing = cleanupScopes.filter((s) => !c.scopes.includes(s));
  if (missing.length) return `A portal admin has not allowed the cleanup scopes: ${missing.join(", ")}`;
  if (!c.settings.eventSubscriptionTypeId) return "Choose the subscription type for event emails in Settings → Integrations";
  const setup = live(c);
  if (!setup.temporaryListId || !setup.nonMarketingListId || !setup.workflowId) return "The cleanup is not set up in the portal: repair setup in Settings → Integrations";
  if (setup.workflowEnabled === false) return "The workflow EM · Set to non-marketing is off or missing in HubSpot: repair setup in Settings → Integrations";
  if (!setup.singleSendEmails?.length) return "The portal has no email saved for the single-send API. HubSpot sending needs Marketing Hub Enterprise and a template email saved for single-send";
  return null;
}

/** Pure: the subject made from the event when staff have set none. */
export function defaultTexts(kind: EmailKind, title: string, locale: string): EmailTexts {
  const nb = locale.startsWith("n");
  const subject =
    kind === "invitation" ? (nb ? `Invitasjon: ${title}` : `You're invited: ${title}`)
    : kind === "reminder" ? (nb ? `Påminnelse: Invitasjon til ${title}` : `Reminder: You're invited to ${title}`)
    : nb ? `Velkommen til ${title}` : `Welcome to ${title}`;
  return { subject, previewText: "" };
}

type SendingRow = { channel: SendChannel; templates: unknown; texts: unknown; marketing_check: unknown; version: number };

async function row(tx: Tx, eventId: string, lock = false): Promise<SendingRow | null> {
  let q = tx.selectFrom("integrations.event_sending").select(["channel", "templates", "texts", "marketing_check", "version"]).where("event_id", "=", eventId);
  if (lock) q = q.forUpdate();
  return (await q.executeTakeFirst()) ?? null;
}

// The connection, without a permission check of its own (the caller made one).
const connectionRow = (tx: Tx): Promise<Connection | null> => loadConnection(tx, "hubspot");

const emailColumns = ["kind", "template_id", "remote_id", "name", "subject", "preview_text", "status", "error", "warnings", "first_sent_at"] as const;
const toEmail = (r: {
  kind: EmailKind; template_id: string; remote_id: string | null; name: string | null; subject: string | null; preview_text: string | null;
  status: "pending" | "ready" | "failed"; error: string | null; warnings: string[]; first_sent_at: Date | null;
}): EventEmail => ({
  kind: r.kind, templateId: r.template_id, remoteId: r.remote_id, name: r.name, subject: r.subject, previewText: r.preview_text,
  status: r.status, error: r.error, warnings: r.warnings, firstSentAt: r.first_sent_at,
});

/** The event's emails in the connected portal. */
export async function eventEmails(tx: Tx, connectionId: string, eventId: string): Promise<EventEmail[]> {
  const rows = await tx.selectFrom("integrations.event_email").select(emailColumns).where("connection_id", "=", connectionId).where("event_id", "=", eventId).execute();
  return rows.map(toEmail).sort((a, b) => EMAIL_KINDS.indexOf(a.kind) - EMAIL_KINDS.indexOf(b.kind));
}

/** An invitation of the event has gone out (by any channel): the channel is settled. */
async function invitationsSent(tx: Tx, eventId: string): Promise<boolean> {
  const r = await tx
    .selectFrom("registration.invitation_send as s")
    .innerJoin("registration.guest_invitation as i", "i.id", "s.invitation_id")
    .select("s.id")
    .where("i.event_id", "=", eventId)
    .where("s.sent_at", "is not", null)
    .limit(1)
    .executeTakeFirst();
  return !!r;
}

async function build(tx: Tx, event: catalog.CatalogEvent, r: SendingRow | null, c: Connection | null, cleanupScopes: readonly string[]): Promise<EventSending> {
  const account = await getAccount(tx);
  const locale = account.defaultLocale;
  const title = event.translations[locale]?.title ?? Object.values(event.translations)[0]?.title ?? event.slug;
  const templates = (r?.templates ?? {}) as Partial<Record<EmailKind, string>>;
  const setTexts = (r?.texts ?? {}) as Partial<Record<EmailKind, EmailTexts>>;
  const defaults = defaultTemplates(c);
  const usable = c && c.status !== "disconnected" ? c : null;
  return {
    eventId: event.id,
    channel: r?.channel ?? "platform",
    templates,
    effectiveTemplates: Object.fromEntries(EMAIL_KINDS.map((k) => [k, templates[k] ?? defaults[k]])) as Record<EmailKind, string | null>,
    texts: Object.fromEntries(EMAIL_KINDS.map((k) => [k, setTexts[k] ?? defaultTexts(k, title, locale)])) as Record<EmailKind, EmailTexts>,
    customTexts: EMAIL_KINDS.filter((k) => setTexts[k]),
    marketingCheck: (r?.marketing_check ?? null) as MarketingCheck | null,
    locked: await invitationsSent(tx, event.id),
    emails: usable ? await eventEmails(tx, usable.id, event.id) : [],
    hubspotBlocker: sendingBlocker(c, cleanupScopes),
    portalId: usable?.portalId ?? null,
    version: r?.version ?? 0,
  };
}

/** The event's sending: who sends, which templates, the event's HubSpot emails. */
export async function getEventSending(tx: Tx, ctx: ActorContext, eventId: string, cleanupScopes: readonly string[]): Promise<EventSending> {
  assertCan(ctx, "registrations.read");
  const event = await catalog.getEvent(tx, eventId);
  return build(tx, event, await row(tx, eventId), await connectionRow(tx), cleanupScopes);
}

const invalid = (field: string, message: string) => new DomainError("validation_failed", message, { field });

/**
 * Changes who sends the event's invitations, reminders and welcome, its template emails or their
 * subject and preview text. Requires the version the change was made from (0 before the first
 * save). The channel is settled once an invitation has gone out; a kind's template and texts once
 * its HubSpot email has been sent from. Choosing HubSpot needs the account ready for it and a
 * template for the invitation, and asks the worker to count who would become a marketing contact.
 */
export async function updateEventSending(
  tx: Tx, ctx: ActorContext, eventId: string, expectedVersion: number, patch: EventSendingPatch, cleanupScopes: readonly string[],
): Promise<EventSending> {
  assertCan(ctx, "registrations.write");
  const event = await catalog.getEvent(tx, eventId);
  if (event.admissionMode !== "registration") throw new DomainError("conflict", "The event does not take registrations", { eventId });
  const before = await row(tx, eventId, true);
  const current = before?.version ?? 0;
  if (current !== expectedVersion) throw new DomainError("version_conflict", "The event's sending was changed by someone else", { currentVersion: current });
  const c = await connectionRow(tx);
  const emails = c && c.status !== "disconnected" ? await eventEmails(tx, c.id, eventId) : [];
  const sentFrom = new Set(emails.filter((e) => e.firstSentAt).map((e) => e.kind));

  const channel = patch.channel ?? before?.channel ?? "platform";
  const templates = { ...((before?.templates ?? {}) as Partial<Record<EmailKind, string>>) };
  const texts = { ...((before?.texts ?? {}) as Partial<Record<EmailKind, EmailTexts>>) };

  if (patch.channel && patch.channel !== (before?.channel ?? "platform") && (await invitationsSent(tx, eventId))) {
    throw new DomainError("conflict", "Invitations have been sent, so who sends them can no longer change", { field: "channel" });
  }
  const known = new Map((c ? (live(c).singleSendEmails ?? []) : []).map((t) => [t.id, t]));
  for (const [k, v] of Object.entries(patch.templates ?? {}) as [EmailKind, string | null][]) {
    if (!EMAIL_KINDS.includes(k)) continue;
    if (sentFrom.has(k) && (v ?? null) !== (templates[k] ?? null)) throw invalid(`templates.${k}`, "The email has been sent from HubSpot already; its template can no longer change");
    if (v === null) delete templates[k];
    else if (!known.has(v)) throw invalid(`templates.${k}`, "The portal has no single-send email by that id. Repair setup to read the portal's emails again");
    else templates[k] = v;
  }
  for (const [k, v] of Object.entries(patch.texts ?? {}) as [EmailKind, { subject: string; previewText?: string } | null][]) {
    if (!EMAIL_KINDS.includes(k)) continue;
    if (sentFrom.has(k)) throw invalid(`texts.${k}`, "The email has been sent from HubSpot already; its subject can no longer change");
    if (v === null) {
      delete texts[k];
      continue;
    }
    const subject = v.subject.replace(/\s+/g, " ").trim();
    const previewText = (v.previewText ?? "").replace(/\s+/g, " ").trim();
    if (!subject || subject.length > 200) throw invalid(`texts.${k}.subject`, "A subject is 1 to 200 characters");
    if (previewText.length > 300) throw invalid(`texts.${k}.previewText`, "Preview text is at most 300 characters");
    texts[k] = { subject, previewText };
  }
  if (channel === "hubspot") {
    const blocker = sendingBlocker(c, cleanupScopes);
    if (blocker) throw new DomainError("conflict", blocker, { field: "channel" });
    if (!(templates.invitation ?? defaultTemplates(c).invitation)) throw invalid("templates.invitation", "Choose a template email for the invitation, here or as the account's default");
  }

  const values = { channel, templates: JSON.stringify(templates), texts: JSON.stringify(texts), updated_by: ctx.userId };
  if (before) await tx.updateTable("integrations.event_sending").set({ ...values, version: sql<number>`version + 1` }).where("event_id", "=", eventId).execute();
  else await tx.insertInto("integrations.event_sending").values({ tenant_id: ctx.tenantId, event_id: eventId, ...values }).execute();
  await recordAudit(tx, ctx, { action: "event.sending_updated", entityType: "event", entityId: eventId, diff: { channel, templates, texts: Object.keys(texts) } });
  await emit(tx, ctx.tenantId, { type: "integration.event_sending_changed.v1", subject: `event/${eventId}`, data: { eventId, provider: "hubspot", channel } });
  if (channel === "hubspot" && (before?.channel ?? "platform") !== "hubspot") {
    await emit(tx, ctx.tenantId, { type: "integration.marketing_check_requested.v1", subject: `event/${eventId}`, data: { eventId, provider: "hubspot" } });
  }
  return build(tx, event, await row(tx, eventId), c, cleanupScopes);
}

/** Counts again how many of the event's guests would become marketing contacts (the worker asks HubSpot). */
export async function requestMarketingCheck(tx: Tx, ctx: ActorContext, eventId: string): Promise<void> {
  assertCan(ctx, "registrations.read");
  await catalog.getEvent(tx, eventId);
  await emit(tx, ctx.tenantId, { type: "integration.marketing_check_requested.v1", subject: `event/${eventId}`, data: { eventId, provider: "hubspot" } });
}

// ── Connector (worker) ──────────────────────────────────────────────────────

/** Who sends the event's invitations, reminders and welcome. */
export async function eventChannel(tx: Tx, eventId: string): Promise<SendChannel> {
  return (await row(tx, eventId))?.channel ?? "platform";
}

export interface EventSendingPlan {
  channel: SendChannel;
  event: catalog.CatalogEvent;
  /** The template each kind needs, or null when none is chosen; welcome only when the event has a reminder before it. */
  wanted: Partial<Record<EmailKind, { templateId: string | null; texts: EmailTexts }>>;
  locale: string;
  title: string;
}

/** What the event's HubSpot emails should be: per kind, its template and texts. */
export async function eventSendingPlan(tx: Tx, connection: Connection, eventId: string): Promise<EventSendingPlan> {
  const [event, r, account] = await Promise.all([catalog.getEvent(tx, eventId), row(tx, eventId), getAccount(tx)]);
  const locale = account.defaultLocale;
  const title = event.translations[locale]?.title ?? Object.values(event.translations)[0]?.title ?? event.slug;
  const templates = (r?.templates ?? {}) as Partial<Record<EmailKind, string>>;
  const texts = (r?.texts ?? {}) as Partial<Record<EmailKind, EmailTexts>>;
  const defaults = defaultTemplates(connection);
  const kinds = EMAIL_KINDS.filter((k) => k !== "welcome" || event.registration.reminderMinBefore !== null);
  return {
    channel: r?.channel ?? "platform",
    event,
    locale,
    title,
    wanted: Object.fromEntries(kinds.map((k) => [k, { templateId: templates[k] ?? defaults[k], texts: texts[k] ?? defaultTexts(k, title, locale) }])),
  };
}

/** The event's email for a kind, as the send needs it: ready, with HubSpot's id. */
export async function readyEmail(tx: Tx, connectionId: string, eventId: string, kind: EmailKind): Promise<EventEmail | null> {
  const r = await tx.selectFrom("integrations.event_email").select(emailColumns).where("connection_id", "=", connectionId).where("event_id", "=", eventId).where("kind", "=", kind).executeTakeFirst();
  return r && r.status === "ready" && r.remote_id ? toEmail(r) : null;
}

const connectionLive = (tx: Tx, ref: ConnectionRef) =>
  tx.selectFrom("integrations.connection").select("id").where("id", "=", ref.id).where("generation", "=", ref.generation).where("status", "=", "active").executeTakeFirst();

/** Records the email the worker made (or failed to make), for the generation that made it. */
export async function saveEventEmail(
  tx: Tx, tenantId: string, ref: ConnectionRef, eventId: string, kind: EmailKind,
  e: { templateId: string; remoteId: string | null; name: string | null; subject: string | null; previewText: string | null; status: "pending" | "ready" | "failed"; error: string | null; warnings: string[] },
): Promise<boolean> {
  if (!(await connectionLive(tx, ref))) return false;
  const values = { template_id: e.templateId, remote_id: e.remoteId, name: e.name, subject: e.subject, preview_text: e.previewText, status: e.status, error: e.error?.slice(0, 1000) ?? null, warnings: e.warnings };
  await tx
    .insertInto("integrations.event_email")
    .values({ tenant_id: tenantId, connection_id: ref.id, event_id: eventId, kind, ...values })
    .onConflict((oc) => oc.columns(["connection_id", "event_id", "kind"]).doUpdateSet(values))
    .execute();
  return true;
}

export async function dropEventEmail(tx: Tx, ref: ConnectionRef, eventId: string, kind: EmailKind): Promise<void> {
  await tx.deleteFrom("integrations.event_email").where("connection_id", "=", ref.id).where("event_id", "=", eventId).where("kind", "=", kind).execute();
}

/** A guest got the email through HubSpot: from now on it is not made again. */
export async function markEmailSentFrom(tx: Tx, connectionId: string, eventId: string, kind: EmailKind, now = new Date()): Promise<void> {
  await tx
    .updateTable("integrations.event_email")
    .set({ first_sent_at: sql<Date>`coalesce(first_sent_at, ${now})` })
    .where("connection_id", "=", connectionId)
    .where("event_id", "=", eventId)
    .where("kind", "=", kind)
    .execute();
}

/** Events whose HubSpot emails need looking at after the account's templates changed: on HubSpot, or with emails left. */
export async function eventsWithHubSpotEmails(tx: Tx, connectionId: string): Promise<string[]> {
  const rows = await sql<{ event_id: string }>`
    SELECT s.event_id FROM integrations.event_sending s JOIN catalog.event e ON e.id = s.event_id
     WHERE s.channel = 'hubspot' AND e.status <> 'archived'
    UNION
    SELECT event_id FROM integrations.event_email WHERE connection_id = ${connectionId}
  `.execute(tx);
  return rows.rows.map((r) => r.event_id);
}

export async function recordMarketingCheck(tx: Tx, eventId: string, check: MarketingCheck): Promise<void> {
  const tenant = await tx.selectFrom("catalog.event").select("tenant_id").where("id", "=", eventId).executeTakeFirst();
  if (!tenant) return;
  await tx
    .insertInto("integrations.event_sending")
    .values({ tenant_id: tenant.tenant_id, event_id: eventId, marketing_check: JSON.stringify(check) })
    .onConflict((oc) => oc.columns(["tenant_id", "event_id"]).doUpdateSet({ marketing_check: JSON.stringify(check) }))
    .execute();
}

/** The event's guests a HubSpot invitation would go to: those who have not declined. */
export async function guestEmails(tx: Tx, eventId: string): Promise<string[]> {
  const rows = await tx.selectFrom("registration.guest_invitation").select("email").where("event_id", "=", eventId).where("status", "<>", "declined").execute();
  return [...new Set(rows.map((r) => contactKey(r.email)))];
}

/**
 * The contact a HubSpot send upserted, as the contact sync would record it: its id, and whether
 * HubSpot made it now. The first answer about who created it wins, so the sync upserting the same
 * contact afterwards (HubSpot then says not new) cannot hide that the platform made it.
 */
export async function recordContactFromSend(tx: Tx, tenantId: string, ref: ConnectionRef, contact: { email: string; name: string | null; id: string; created: boolean }): Promise<void> {
  if (!(await connectionLive(tx, ref))) return;
  const data = JSON.stringify({ email: contact.email.trim(), name: contact.name });
  await tx
    .insertInto("integrations.sync_item")
    .values({ tenant_id: tenantId, connection_id: ref.id, kind: "contact", local_key: contactKey(contact.email), data, remote_id: contact.id, created_by_us: contact.created, dirty: false, last_synced_at: sql<Date>`now()` })
    .onConflict((oc) =>
      oc.columns(["connection_id", "kind", "local_key"]).doUpdateSet({
        remote_id: contact.id,
        created_by_us: sql<boolean>`coalesce(integrations.sync_item.created_by_us, ${contact.created})`,
      }),
    )
    .execute();
}
