import { type DeliveryStatus, type InvitationStatus, newId, type SendChannel, type SendKind, sql, type Tx } from "@event-manager/db";
import * as catalog from "../catalog/index.js";
import { emit } from "../outbox/index.js";
import { type ActorContext, DomainError } from "../shared/index.js";
import { assertCan, getAccount, recordAudit } from "../tenancy/index.js";
import type { AnswerInput } from "./forms.js";
import { assertPartySize, formAnswers, insertConfirmed, normalizeContact, pickLocale, type Registration } from "./registrations.js";
import { issueToken, verifyToken } from "./tokens.js";

// Guest invitations (docs/registration.md, milestone 3). An invitation belongs to an event
// and carries a personal link; the guest picks one of the event's occurrences and accepts,
// or declines. Accepted means an active registration exists. Invitations are sent from the
// worker, one logged send per email, with Postmark's delivery status written back by its
// webhook. Clients who send from their own tool export the links instead.

export interface GuestInvitation {
  id: string;
  eventId: string;
  email: string;
  name: string | null;
  locale: string | null;
  /** Null: the event's setting. */
  guestAllowed: boolean | null;
  externalContactId: string | null;
  status: InvitationStatus;
  tokenVersion: number;
  firstSentAt: Date | null;
  lastSentAt: Date | null;
  respondedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface InvitationSend {
  id: string;
  kind: SendKind;
  requestedAt: Date;
  sentAt: Date | null;
  deliveryStatus: DeliveryStatus;
  deliveryDetail: string | null;
  deliveryAt: Date | null;
  /** Who sent it: the platform's mail service or HubSpot (docs/hubspot.md, "Delivery"). */
  channel: SendChannel;
  /** Why the platform sent it although the event sends through HubSpot. */
  fallbackReason: string | null;
}

/** An invitation as the guest list shows it: with its last send and its registration. */
export interface GuestInvitationView extends GuestInvitation {
  lastSend: InvitationSend | null;
  registration: { id: string; occurrenceId: string; partySize: number } | null;
}

export interface InvitationCounts {
  total: number;
  pending: number;
  sent: number;
  accepted: number;
  declined: number;
  /** Invitations whose last email bounced or was marked as spam. */
  undeliverable: number;
  /** Places taken by accepted guests (party sizes). */
  places: number;
}

export interface InvitationInput {
  email: string;
  name?: string | null;
  locale?: string | null;
  guestAllowed?: boolean | null;
  externalContactId?: string | null;
}

export type InvitationPatch = Omit<InvitationInput, "email">;

export const invitationColumns = [
  "id", "event_id", "email", "name", "locale", "guest_allowed", "external_contact_id", "status", "token_version",
  "first_sent_at", "last_sent_at", "responded_at", "version", "created_at", "updated_at",
] as const;
type Row = {
  id: string; event_id: string; email: string; name: string | null; locale: string | null; guest_allowed: boolean | null;
  external_contact_id: string | null; status: InvitationStatus; token_version: number; first_sent_at: Date | null;
  last_sent_at: Date | null; responded_at: Date | null; version: number; created_at: Date; updated_at: Date;
};

export const toInvitation = (r: Row): GuestInvitation => ({
  id: r.id, eventId: r.event_id, email: r.email, name: r.name, locale: r.locale, guestAllowed: r.guest_allowed,
  externalContactId: r.external_contact_id, status: r.status, tokenVersion: r.token_version, firstSentAt: r.first_sent_at,
  lastSentAt: r.last_sent_at, respondedAt: r.responded_at, version: r.version, createdAt: r.created_at, updatedAt: r.updated_at,
});

const invalid = (field: string, message: string) => new DomainError("validation_failed", message, { field });
const pgCode = (e: unknown) => (typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Pure: an email as stored, or null when it is not one. */
export function normalizeEmail(email: string | null | undefined): string | null {
  const e = (email ?? "").trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

/** Pure: a trimmed optional name, at most 200 characters; null when empty. */
export function normalizeName(name: string | null | undefined): string | null {
  const n = (name ?? "").replace(/\s+/g, " ").trim();
  if (n.length > 200) throw invalid("name", "A name is at most 200 characters");
  return n || null;
}

function normalizeContactId(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  if (s.length > 200) throw invalid("externalContactId", "At most 200 characters");
  return s || null;
}

async function assertLocale(tx: Tx, locale: string | null | undefined, field = "locale"): Promise<string | null> {
  if (locale === null || locale === undefined || locale === "") return null;
  const account = await getAccount(tx);
  if (!account.locales.includes(locale)) throw invalid(field, `Use one of the account's languages: ${account.locales.join(", ")}`);
  return locale;
}

async function eventForInvitations(tx: Tx, eventId: string): Promise<catalog.CatalogEvent> {
  const event = await catalog.getEvent(tx, eventId);
  if (event.admissionMode !== "registration") throw new DomainError("conflict", "The event does not take registrations", { eventId });
  return event;
}

const alreadyInvited = (e: unknown) => {
  if (pgCode(e) === "23505") throw new DomainError("conflict", "This email address is already on the guest list", { field: "email" });
  throw e;
};

// ── Staff: the guest list ─────────────────────────────────────────────────────

export interface InvitationFilter {
  status?: InvitationStatus[];
}

export async function listInvitations(tx: Tx, ctx: ActorContext, eventId: string, f: InvitationFilter = {}): Promise<{ items: GuestInvitationView[]; counts: InvitationCounts }> {
  assertCan(ctx, "registrations.read");
  const rows = await tx.selectFrom("registration.guest_invitation").select(invitationColumns).where("event_id", "=", eventId).orderBy("created_at").orderBy("id").execute();
  const ids = rows.map((r) => r.id);
  const [sends, regs] = ids.length
    ? await Promise.all([
        tx.selectFrom("registration.invitation_send")
          .distinctOn("invitation_id")
          .select(["invitation_id", "id", "kind", "requested_at", "sent_at", "delivery_status", "delivery_detail", "delivery_at", "channel", "fallback_reason"])
          .where("invitation_id", "in", ids)
          .orderBy("invitation_id").orderBy("requested_at", "desc").orderBy("id", "desc")
          .execute(),
        tx.selectFrom("registration.registration").select(["id", "invitation_id", "occurrence_id", "party_size"])
          .where("invitation_id", "in", ids).where("status", "<>", "cancelled").execute(),
      ])
    : [[], []];
  const sendBy = new Map(sends.map((s) => [s.invitation_id, s]));
  const regBy = new Map(regs.map((r) => [r.invitation_id!, r]));
  const all: GuestInvitationView[] = rows.map((r) => {
    const s = sendBy.get(r.id);
    const g = regBy.get(r.id);
    return {
      ...toInvitation(r),
      lastSend: s
        ? {
            id: s.id, kind: s.kind, requestedAt: s.requested_at, sentAt: s.sent_at, deliveryStatus: s.delivery_status, deliveryDetail: s.delivery_detail, deliveryAt: s.delivery_at,
            channel: s.channel, fallbackReason: s.fallback_reason,
          }
        : null,
      registration: g ? { id: g.id, occurrenceId: g.occurrence_id, partySize: g.party_size } : null,
    };
  });
  const counts: InvitationCounts = { total: all.length, pending: 0, sent: 0, accepted: 0, declined: 0, undeliverable: 0, places: 0 };
  for (const i of all) {
    counts[i.status] += 1;
    if (i.lastSend && (i.lastSend.deliveryStatus === "bounced" || i.lastSend.deliveryStatus === "spam_complaint")) counts.undeliverable += 1;
    if (i.registration) counts.places += i.registration.partySize;
  }
  const items = f.status?.length ? all.filter((i) => f.status!.includes(i.status)) : all;
  return { items, counts };
}

export async function getInvitation(tx: Tx, id: string): Promise<GuestInvitation> {
  const row = await tx.selectFrom("registration.guest_invitation").select(invitationColumns).where("id", "=", id).executeTakeFirst();
  if (!row) throw new DomainError("not_found", "Invitation not found");
  return toInvitation(row);
}

async function lockedInvitation(tx: Tx, id: string): Promise<GuestInvitation> {
  const row = await tx.selectFrom("registration.guest_invitation").select(invitationColumns).where("id", "=", id).forUpdate().executeTakeFirst();
  if (!row) throw new DomainError("not_found", "Invitation not found");
  return toInvitation(row);
}

/** Staff add one guest by hand. */
export async function createInvitation(tx: Tx, ctx: ActorContext, eventId: string, input: InvitationInput): Promise<GuestInvitation> {
  assertCan(ctx, "registrations.write");
  await eventForInvitations(tx, eventId);
  const email = normalizeEmail(input.email);
  if (!email) throw invalid("email", "Enter a valid email address");
  const row = await tx
    .insertInto("registration.guest_invitation")
    .values({
      id: newId(), tenant_id: ctx.tenantId, event_id: eventId, email, name: normalizeName(input.name), locale: await assertLocale(tx, input.locale),
      guest_allowed: input.guestAllowed ?? null, external_contact_id: normalizeContactId(input.externalContactId),
    })
    .returning(invitationColumns)
    .executeTakeFirstOrThrow()
    .catch(alreadyInvited);
  await recordAudit(tx, ctx, { action: "invitation.created", entityType: "event", entityId: eventId, diff: { invitationId: row.id } });
  return toInvitation(row);
}

export async function updateInvitation(tx: Tx, ctx: ActorContext, id: string, patch: InvitationPatch, expectedVersion?: number): Promise<GuestInvitation> {
  assertCan(ctx, "registrations.write");
  const before = await lockedInvitation(tx, id);
  if (expectedVersion !== undefined && expectedVersion !== before.version) {
    throw new DomainError("version_conflict", "Invitation was changed by someone else", { currentVersion: before.version });
  }
  const set = {
    ...(patch.name !== undefined ? { name: normalizeName(patch.name) } : {}),
    ...(patch.locale !== undefined ? { locale: await assertLocale(tx, patch.locale) } : {}),
    ...(patch.guestAllowed !== undefined ? { guest_allowed: patch.guestAllowed } : {}),
    ...(patch.externalContactId !== undefined ? { external_contact_id: normalizeContactId(patch.externalContactId) } : {}),
  };
  if (Object.keys(set).length === 0) return before;
  const row = await tx.updateTable("registration.guest_invitation").set({ ...set, version: sql<number>`version + 1` }).where("id", "=", id).returning(invitationColumns).executeTakeFirstOrThrow();
  await recordAudit(tx, ctx, { action: "invitation.updated", entityType: "event", entityId: before.eventId, diff: { invitationId: id, changed: Object.keys(set) } });
  return toInvitation(row);
}

/**
 * Removes guests from the list. Guests who have accepted are kept and reported as blocked:
 * cancel their registration first. Never removes anything not asked for.
 */
export async function removeInvitations(tx: Tx, ctx: ActorContext, eventId: string, ids: readonly string[]): Promise<{ removed: string[]; blocked: string[] }> {
  assertCan(ctx, "registrations.write");
  if (ids.length === 0) return { removed: [], blocked: [] };
  const rows = await tx.selectFrom("registration.guest_invitation").select(["id", "status"]).where("event_id", "=", eventId).where("id", "in", ids).forUpdate().execute();
  const blocked = rows.filter((r) => r.status === "accepted").map((r) => r.id);
  const removable = rows.filter((r) => r.status !== "accepted").map((r) => r.id);
  if (removable.length) await tx.deleteFrom("registration.guest_invitation").where("id", "in", removable).execute();
  if (removable.length) await recordAudit(tx, ctx, { action: "invitation.removed", entityType: "event", entityId: eventId, diff: { invitationIds: removable } });
  return { removed: removable, blocked };
}

/** Invalidates the guest's personal link; the next send or export has a new one. */
export async function rotateInvitationLink(tx: Tx, ctx: ActorContext, id: string): Promise<GuestInvitation> {
  assertCan(ctx, "registrations.write");
  const before = await lockedInvitation(tx, id);
  const row = await tx.updateTable("registration.guest_invitation")
    .set({ token_version: sql<number>`token_version + 1`, version: sql<number>`version + 1` })
    .where("id", "=", id).returning(invitationColumns).executeTakeFirstOrThrow();
  await recordAudit(tx, ctx, { action: "invitation.link_rotated", entityType: "event", entityId: before.eventId, diff: { invitationId: id } });
  return toInvitation(row);
}

export const invitationToken = (tx: Tx, tenantId: string, inv: Pick<GuestInvitation, "id" | "tokenVersion">) =>
  issueToken(tx, tenantId, "invitation", inv.id, inv.tokenVersion);

/** Who may get which email: invitations go to guests not yet answered, reminders to guests who were sent one and have not answered. */
const eligible: Record<SendKind, InvitationStatus[]> = { invitation: ["pending", "sent"], reminder: ["sent"] };

export interface SendRequest {
  kind: SendKind;
  /** These guests; omitted: every guest the kind applies to (invitation: not yet sent, reminder: no answer). */
  ids?: readonly string[];
}

/**
 * Queues invitation or reminder emails. Asking for specific guests resends to guests who
 * already got one; asking for everyone sends invitations only to guests who have none yet.
 * The worker sends them and logs each send.
 */
export async function requestSends(tx: Tx, ctx: ActorContext, eventId: string, req: SendRequest): Promise<{ queued: number; skipped: number }> {
  assertCan(ctx, "registrations.write");
  const event = await eventForInvitations(tx, eventId);
  if (event.status !== "published") throw new DomainError("conflict", "Publish the event before sending invitations", { eventId });
  // Locks the guests (in id order, so overlapping requests never deadlock): a second request for the same
  // guests waits here until this one commits, then sees its queued sends and skips them.
  let q = tx.selectFrom("registration.guest_invitation").select(["id", "status"]).where("event_id", "=", eventId).orderBy("id").forUpdate();
  if (req.ids) {
    if (req.ids.length === 0) return { queued: 0, skipped: 0 };
    q = q.where("id", "in", req.ids);
  }
  const rows = await q.execute();
  const statuses = req.ids ? eligible[req.kind] : req.kind === "invitation" ? (["pending"] as InvitationStatus[]) : eligible.reminder;
  // A guest whose email of this kind is still waiting in the queue does not get a second one.
  const waiting = rows.length
    ? new Set((await tx.selectFrom("registration.invitation_send").select("invitation_id")
        .where("invitation_id", "in", rows.map((r) => r.id)).where("kind", "=", req.kind).where("delivery_status", "=", "queued").execute()).map((s) => s.invitation_id))
    : new Set<string>();
  const targets = rows.filter((r) => statuses.includes(r.status) && !waiting.has(r.id)).map((r) => r.id);
  const skipped = (req.ids ? req.ids.length : rows.length) - targets.length;
  if (targets.length === 0) return { queued: 0, skipped };
  const sends = targets.map((invitationId) => ({ id: newId(), tenant_id: ctx.tenantId, invitation_id: invitationId, kind: req.kind, requested_by: ctx.userId }));
  for (let i = 0; i < sends.length; i += 1000) await tx.insertInto("registration.invitation_send").values(sends.slice(i, i + 1000)).execute();
  // Internal: the worker queues one email job per send.
  await emit(tx, ctx.tenantId, {
    type: "invitation.sends_requested.v1", subject: `event/${eventId}`,
    data: { eventId, kind: req.kind, sendIds: sends.map((s) => s.id) },
  });
  await recordAudit(tx, ctx, { action: req.kind === "invitation" ? "invitation.sent" : "invitation.reminded", entityType: "event", entityId: eventId, diff: { count: targets.length } });
  return { queued: targets.length, skipped };
}

/** For links sent from the client's own tool: marks unsent guests as sent, logged as an external send. */
export async function markSentExternally(tx: Tx, ctx: ActorContext, eventId: string, ids: readonly string[], now: Date = new Date()): Promise<{ marked: number }> {
  assertCan(ctx, "registrations.write");
  if (ids.length === 0) return { marked: 0 };
  const rows = await tx.updateTable("registration.guest_invitation")
    .set({ status: "sent", first_sent_at: sql<Date>`coalesce(first_sent_at, ${now})`, last_sent_at: now, version: sql<number>`version + 1` })
    .where("event_id", "=", eventId).where("id", "in", ids).where("status", "=", "pending")
    .returning("id").execute();
  if (rows.length === 0) return { marked: 0 };
  await tx.insertInto("registration.invitation_send").values(rows.map((r) => ({
    id: newId(), tenant_id: ctx.tenantId, invitation_id: r.id, kind: "invitation" as const, requested_by: ctx.userId,
    sent_at: now, delivery_status: "sent" as const, delivery_detail: "external",
  }))).execute();
  for (const r of rows) {
    await emit(tx, ctx.tenantId, { type: "invitation.sent.v1", subject: `invitation/${r.id}`, data: { invitationId: r.id, eventId, kind: "invitation", channel: "external" } });
  }
  await recordAudit(tx, ctx, { action: "invitation.marked_sent", entityType: "event", entityId: eventId, diff: { count: rows.length } });
  return { marked: rows.length };
}

export interface InvitationLink {
  id: string;
  email: string;
  name: string | null;
  locale: string | null;
  externalContactId: string | null;
  status: InvitationStatus;
  token: string;
}

/** Every guest's personal link token, for clients who send from their own tool. */
export async function invitationLinks(tx: Tx, ctx: ActorContext, eventId: string): Promise<InvitationLink[]> {
  assertCan(ctx, "registrations.read");
  await eventForInvitations(tx, eventId);
  const rows = await tx.selectFrom("registration.guest_invitation").select(invitationColumns).where("event_id", "=", eventId).orderBy("created_at").orderBy("id").execute();
  const out: InvitationLink[] = [];
  for (const r of rows) {
    out.push({ id: r.id, email: r.email, name: r.name, locale: r.locale, externalContactId: r.external_contact_id, status: r.status, token: await invitationToken(tx, ctx.tenantId, toInvitation(r)) });
  }
  return out;
}

// ── Worker: sending ───────────────────────────────────────────────────────────

export interface InvitationMessage {
  /** `providerStatusId`: HubSpot accepted the send already (a retried job reads its result instead of sending again). */
  send: { id: string; kind: SendKind; sentAt: Date | null; providerStatusId: string | null };
  invitation: GuestInvitation;
  event: catalog.CatalogEvent;
  /** Occurrences still to come, soonest first. */
  occurrences: catalog.RegistrationTarget[];
  account: { name: string; defaultLocale: string };
  locale: string;
  token: string;
}

/** Everything an invitation email needs; null when the send or its guest is gone. */
export async function loadInvitationMessage(tx: Tx, tenantId: string, sendId: string, now: Date = new Date()): Promise<InvitationMessage | null> {
  const send = await tx.selectFrom("registration.invitation_send").select(["id", "kind", "sent_at", "invitation_id", "provider_status_id"]).where("id", "=", sendId).executeTakeFirst();
  if (!send) return null;
  const row = await tx.selectFrom("registration.guest_invitation").select(invitationColumns).where("id", "=", send.invitation_id).executeTakeFirst();
  if (!row) return null;
  const invitation = toInvitation(row);
  const [event, account, occurrences] = await Promise.all([
    catalog.getEvent(tx, invitation.eventId), getAccount(tx), catalog.upcomingRegistrationTargets(tx, invitation.eventId, now, 20),
  ]);
  const locale = invitation.locale && account.locales.includes(invitation.locale) ? invitation.locale : account.defaultLocale;
  return {
    send: { id: send.id, kind: send.kind, sentAt: send.sent_at, providerStatusId: send.provider_status_id },
    invitation, event, occurrences, account: { name: account.name, defaultLocale: account.defaultLocale }, locale,
    token: await invitationToken(tx, tenantId, invitation),
  };
}

/** Whether a queued send should still go out: the guest has not answered, and a reminder only to someone who got the invitation. */
export function shouldSend(m: InvitationMessage): boolean {
  if (m.send.sentAt) return false;
  if (m.event.status !== "published") return false;
  return m.send.kind === "invitation" ? m.invitation.status === "pending" || m.invitation.status === "sent" : m.invitation.status === "sent";
}

/** How a send went out: by HubSpot, or by the platform (with why, when the event sends through HubSpot). */
export interface SentVia {
  channel: SendChannel;
  fallbackReason?: string | null;
}

export async function recordSent(tx: Tx, tenantId: string, sendId: string, messageId: string | null, now: Date = new Date(), via: SentVia = { channel: "platform" }): Promise<void> {
  const send = await tx.updateTable("registration.invitation_send")
    .set({ sent_at: now, message_id: messageId, delivery_status: "sent", delivery_at: now, channel: via.channel, fallback_reason: via.fallbackReason?.slice(0, 500) ?? null })
    .where("id", "=", sendId).where("sent_at", "is", null)
    .returning(["invitation_id", "kind"]).executeTakeFirst();
  if (!send) return;
  const inv = await tx.updateTable("registration.guest_invitation")
    .set({
      status: sql<InvitationStatus>`case when status = 'pending' then 'sent'::registration.invitation_status else status end`,
      first_sent_at: sql<Date>`coalesce(first_sent_at, ${now})`, last_sent_at: now,
    })
    .where("id", "=", send.invitation_id).returning(["event_id"]).executeTakeFirst();
  await emit(tx, tenantId, {
    type: "invitation.sent.v1", subject: `invitation/${send.invitation_id}`,
    data: { invitationId: send.invitation_id, eventId: inv?.event_id ?? null, kind: send.kind, sendId, channel: via.channel === "hubspot" ? "hubspot" : "email" },
  });
}

/** HubSpot accepted the send: its status id, so a retry reads the result rather than sending again. */
export async function recordProviderStatus(tx: Tx, sendId: string, statusId: string): Promise<void> {
  await tx.updateTable("registration.invitation_send").set({ provider_status_id: statusId, channel: "hubspot" }).where("id", "=", sendId).where("sent_at", "is", null).execute();
}

/** Marks a send that will not go out (the guest answered or the event was unpublished meanwhile, or the mail service refused it). */
export async function recordNotSent(tx: Tx, sendId: string, detail: string, fallbackReason: string | null = null): Promise<void> {
  await tx.updateTable("registration.invitation_send").set({ delivery_status: "failed", delivery_detail: detail.slice(0, 500), delivery_at: new Date(), ...(fallbackReason ? { fallback_reason: fallbackReason.slice(0, 500) } : {}) })
    .where("id", "=", sendId).where("sent_at", "is", null).execute();
}

const RANK: Record<DeliveryStatus, number> = { queued: 0, failed: 1, sent: 2, delivered: 3, bounced: 4, spam_complaint: 5 };

/**
 * A delivery report from the mail service (Postmark webhook). Matched on the send id and the
 * message id, so a report can only touch the send it is about. A later, weaker report (a
 * delivery after a bounce) does not overwrite a stronger one.
 */
export async function recordDelivery(
  tx: Tx, sendId: string, messageId: string, status: "delivered" | "bounced" | "spam_complaint", detail: string | null, at: Date,
): Promise<boolean> {
  const send = await tx.selectFrom("registration.invitation_send").select(["delivery_status"]).where("id", "=", sendId).where("message_id", "=", messageId).forUpdate().executeTakeFirst();
  if (!send) return false;
  if (RANK[send.delivery_status] > RANK[status]) return true;
  await tx.updateTable("registration.invitation_send").set({ delivery_status: status, delivery_detail: detail?.slice(0, 500) ?? null, delivery_at: at }).where("id", "=", sendId).execute();
  return true;
}

// ── Attendee: the invitation link ─────────────────────────────────────────────

/** The invitation behind a personal link, or null for a forged, rotated or foreign token. */
export async function invitationByToken(tx: Tx, token: string): Promise<GuestInvitation | null> {
  const claims = await verifyToken(tx, token, "invitation");
  if (!claims) return null;
  const row = await tx.selectFrom("registration.guest_invitation").select(invitationColumns).where("id", "=", claims.subjectId).executeTakeFirst();
  return row && row.token_version === claims.tokenVersion ? toInvitation(row) : null;
}

/** The guest's active registration, if they have accepted. */
export async function activeRegistrationFor(tx: Tx, invitationId: string): Promise<string | null> {
  const r = await tx.selectFrom("registration.registration").select("id").where("invitation_id", "=", invitationId).where("status", "<>", "cancelled").executeTakeFirst();
  return r?.id ?? null;
}

export const effectiveGuestAllowed = (inv: Pick<GuestInvitation, "guestAllowed">, event: { guestAllowed: boolean }) => inv.guestAllowed ?? event.guestAllowed;

export interface AcceptInput extends AnswerInput {
  occurrenceId: string;
  /** Needed when the guest list has no name for the guest. */
  name?: string;
  partySize?: number;
  locale?: string;
}

/**
 * Accepts an invitation for one of the event's occurrences: a confirmed registration from
 * the invitation, whatever the occurrence's access policy, or a place on its waitlist when it is
 * full. Throws already_registered when the guest has accepted already, registration_closed
 * outside the window and full without places or waitlist.
 */
export async function acceptInvitation(tx: Tx, tenantId: string, invitationId: string, input: AcceptInput, now: Date = new Date()): Promise<Registration> {
  const inv = await lockedInvitation(tx, invitationId);
  if (inv.status === "accepted" || (await activeRegistrationFor(tx, inv.id))) throw new DomainError("already_registered", "You have already accepted this invitation");
  const target = await catalog.getRegistrationTarget(tx, input.occurrenceId).catch(() => null);
  if (!target || target.event.id !== inv.eventId) throw new DomainError("not_found", "Occurrence not found", { field: "occurrenceId" });
  if (target.event.admissionMode !== "registration" || !target.pool) throw new DomainError("conflict", "This occurrence does not take registrations");
  if (catalog.targetAvailability(target, now).status === "closed") throw new DomainError("registration_closed", "Registration is closed");
  const { name, email } = normalizeContact(input.name ?? inv.name ?? "", inv.email);
  const partySize = input.partySize ?? 1;
  assertPartySize(partySize, effectiveGuestAllowed(inv, target.event), { kind: "attendee" });
  const locale = await pickLocale(tx, input.locale ?? inv.locale ?? undefined);
  const answers = await formAnswers(tx, inv.eventId, input, { kind: "attendee" });
  // Full: the guest joins the waitlist when the event has one (docs/registration.md, "Closed event", step 7).
  const reg = await insertConfirmed(tx, tenantId, target, { name, email, locale, partySize, source: "invitation", invitationId: inv.id }, answers, { waitlist: true, now });
  await tx.updateTable("registration.guest_invitation")
    .set({ status: "accepted", responded_at: now, name: inv.name ?? name, version: sql<number>`version + 1` })
    .where("id", "=", inv.id).execute();
  return reg;
}

/** Declines. A guest who has accepted cancels the registration instead (from the manage page). */
export async function declineInvitation(tx: Tx, tenantId: string, invitationId: string, now: Date = new Date()): Promise<GuestInvitation> {
  const inv = await lockedInvitation(tx, invitationId);
  if (inv.status === "accepted") throw new DomainError("already_registered", "You have accepted; cancel the registration instead");
  if (inv.status === "declined") return inv;
  const row = await tx.updateTable("registration.guest_invitation")
    .set({ status: "declined", responded_at: now, version: sql<number>`version + 1` })
    .where("id", "=", inv.id).returning(invitationColumns).executeTakeFirstOrThrow();
  await emit(tx, tenantId, { type: "invitation.declined.v1", subject: `invitation/${inv.id}`, data: { invitationId: inv.id, eventId: inv.eventId, status: "declined" } });
  return toInvitation(row);
}
