import { type CancelledBy, newId, type RegistrationSource, type RegistrationStatus, sql, type Tx } from "@event-manager/db";
import * as admission from "../admission/index.js";
import * as catalog from "../catalog/index.js";
import * as inventory from "../inventory/index.js";
import { emit } from "../outbox/index.js";
import { type ActorContext, DomainError } from "../shared/index.js";
import { assertCan, can, getAccount, recordAudit } from "../tenancy/index.js";
import { type AnswerInput, checkAnswers, type CheckedAnswers, getForm, readAnswers, writeAnswers } from "./forms.js";
import { issueToken, peekToken, verifyToken } from "./tokens.js";
import { hasWaiting, promoteWaitlist, waitlistOpen, waitlistRanks } from "./waitlist.js";

// Registrations (docs/registration.md, milestone 2): open registration from the hosted
// pages, and staff adding people by hand. A registration is confirmed at once and takes its
// party size from the occurrence's pool with the conditional update (ADR 0003), so the last
// place goes to exactly one person. When the occurrence is full and the event has a waitlist,
// the registration joins the waitlist instead (waitlist.ts, milestone 5); invitations
// (milestone 3) build on the same rows.

export interface Registration {
  id: string;
  eventId: string;
  occurrenceId: string;
  /** The guest invitation it came from, if any. */
  invitationId: string | null;
  name: string;
  email: string;
  locale: string;
  partySize: number;
  status: RegistrationStatus;
  source: RegistrationSource;
  cancelledAt: Date | null;
  /** expired: a waitlist offer that was not claimed in time. */
  cancelledBy: CancelledBy | null;
  /** While offered: when the offer must be claimed. */
  offerExpiresAt: Date | null;
  /** When the places were taken: at once, or when a waitlist offer was claimed. */
  confirmedAt: Date | null;
  tokenVersion: number;
  /** When the reminder before the event went out. */
  remindedAt: Date | null;
  /** The form version the answers were given to; null when none were. */
  formVersion: number | null;
  /** When the attendee agreed to sensitive answers being stored. */
  sensitiveConsentAt: Date | null;
  /** Name, email and answers removed by retention; name and email are then empty. */
  anonymisedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Who acts: the attendee through a link or the open page, or staff in the admin. */
export type Actor = { kind: "attendee" } | { kind: "staff"; ctx: ActorContext };

export interface RegistrationInput extends AnswerInput {
  name: string;
  email: string;
  /** One of the account's locales; falls back to the account default. */
  locale?: string;
  /** 1, or 2 with a guest. */
  partySize?: number;
  /**
   * Staff: join the waitlist when the occurrence is full, instead of failing with full.
   * Attendees always join it when the event has one.
   */
  waitlist?: boolean;
}

export interface RegistrationPatch {
  name?: string;
  partySize?: number;
  locale?: string;
  /** Replaces all answers (with consent for sensitive ones). Left out: answers unchanged. */
  answers?: Record<string, unknown>;
  consent?: boolean;
}

const columns = [
  "id", "event_id", "occurrence_id", "invitation_id", "name", "email", "locale", "party_size", "status", "source", "cancelled_at", "cancelled_by",
  "offer_hold_id", "offer_expires_at", "confirmed_at", "token_version", "reminded_at", "form_version", "sensitive_consent_at", "anonymised_at", "version", "created_at", "updated_at",
] as const;
type Row = {
  id: string; event_id: string; occurrence_id: string; invitation_id: string | null; name: string | null; email: string | null; locale: string; party_size: number;
  status: RegistrationStatus; source: RegistrationSource; cancelled_at: Date | null; cancelled_by: CancelledBy | null;
  offer_hold_id: string | null; offer_expires_at: Date | null; confirmed_at: Date | null; token_version: number; reminded_at: Date | null; form_version: number | null; sensitive_consent_at: Date | null; anonymised_at: Date | null;
  version: number; created_at: Date; updated_at: Date;
};

const toRegistration = (r: Row): Registration => ({
  id: r.id, eventId: r.event_id, occurrenceId: r.occurrence_id, invitationId: r.invitation_id, name: r.name ?? "", email: r.email ?? "", locale: r.locale, partySize: r.party_size,
  status: r.status, source: r.source, cancelledAt: r.cancelled_at, cancelledBy: r.cancelled_by,
  offerExpiresAt: r.offer_expires_at, confirmedAt: r.confirmed_at, tokenVersion: r.token_version,
  remindedAt: r.reminded_at, formVersion: r.form_version, sensitiveConsentAt: r.sensitive_consent_at, anonymisedAt: r.anonymised_at,
  version: r.version, createdAt: r.created_at, updatedAt: r.updated_at,
});

const invalid = (field: string, message: string) => new DomainError("validation_failed", message, { field });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Pure: trims and checks a name and email. */
export function normalizeContact(name: string, email: string): { name: string; email: string } {
  const n = (name ?? "").replace(/\s+/g, " ").trim();
  if (n.length < 1 || n.length > 200) throw invalid("name", "Enter a name (at most 200 characters)");
  const e = (email ?? "").trim().toLowerCase();
  if (e.length > 254 || !EMAIL_RE.test(e)) throw invalid("email", "Enter a valid email address");
  return { name: n, email: e };
}

export function assertPartySize(partySize: number, guestAllowed: boolean, actor: Actor) {
  if (partySize !== 1 && partySize !== 2) throw invalid("partySize", "Party size is 1, or 2 with a guest");
  // Staff may add a guest even where the event does not offer one.
  if (partySize === 2 && !guestAllowed && actor.kind === "attendee") throw invalid("partySize", "This event does not take guests");
}

export async function pickLocale(tx: Tx, locale: string | undefined): Promise<string> {
  const account = await getAccount(tx);
  return locale && account.locales.includes(locale) ? locale : account.defaultLocale;
}

const pgCode = (e: unknown) => (typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined);

/**
 * Whether the attendee may still change or cancel. Changes follow the registration window and
 * need a scheduled occurrence of a published event. Cancelling is possible until the occurrence
 * starts, also when staff cancelled the occurrence or event: registrations are kept then, and the
 * attendee must still be able to withdraw (and free the places if it is restored).
 */
export function attendeeRights(
  reg: Pick<Registration, "status" | "offerExpiresAt">, target: catalog.RegistrationTarget, now: Date,
): { change: boolean; cancel: boolean; claim: boolean } {
  const held = reg.status !== "cancelled";
  const active = held && target.occurrence.status === "scheduled" && target.event.status === "published";
  const { closesAt } = catalog.registrationWindow(target.occurrence.startUtc, target.event.opensMinBefore, target.event.closesMinBefore);
  // A waitlist offer can be claimed until it expires, also after registration has closed (offers
  // stop at the waitlist cutoff, and the deadline is always before the start).
  const claim = active && reg.status === "offered" && !!reg.offerExpiresAt && now < reg.offerExpiresAt && now < target.occurrence.startUtc;
  return { change: active && now < closesAt, cancel: held && target.event.status !== "archived" && now < target.occurrence.startUtc, claim };
}

/**
 * Registers for an occurrence. When it is full, the registration joins the waitlist if the event
 * has one that is still open (always for attendees; for staff only when they ask). Throws full,
 * registration_closed, already_registered or invitation_required.
 */
export async function register(
  tx: Tx, tenantId: string, occurrenceId: string, input: RegistrationInput, actor: Actor, now: Date = new Date(),
): Promise<Registration> {
  if (actor.kind === "staff") assertCan(actor.ctx, "registrations.write");
  const target = await catalog.getRegistrationTarget(tx, occurrenceId);
  if (target.event.admissionMode !== "registration" || !target.pool) throw new DomainError("conflict", "This occurrence does not take registrations", { occurrenceId });
  if (actor.kind === "attendee") {
    if (target.event.accessPolicy !== "open") throw new DomainError("invitation_required", "Registration is by invitation only");
    if (catalog.targetAvailability(target, now).status === "closed") throw new DomainError("registration_closed", "Registration is closed");
  } else if (target.occurrence.status === "cancelled" || target.event.status === "cancelled" || target.event.status === "archived") {
    throw new DomainError("registration_closed", "The occurrence is cancelled");
  }
  const { name, email } = normalizeContact(input.name, input.email);
  const partySize = input.partySize ?? 1;
  assertPartySize(partySize, target.event.guestAllowed, actor);
  const locale = await pickLocale(tx, input.locale);
  const { form, answers } = await formAnswers(tx, target.event.id, input, actor);
  const reg = await insertConfirmed(
    tx, tenantId, target, { name, email, locale, partySize, source: actor.kind === "staff" ? "staff" : "open", invitationId: null }, { form, answers },
    { waitlist: actor.kind === "attendee" || input.waitlist === true, now },
  );
  if (actor.kind === "staff") {
    await recordAudit(tx, actor.ctx, { action: "registration.created", entityType: "event", entityId: target.event.id, diff: { registrationId: reg.id, occurrenceId, partySize, status: reg.status } });
  }
  return reg;
}

/**
 * Checks answers against the event's current form. Attendees must answer required fields;
 * staff may leave them out, and give sensitive answers only with registrations.sensitive.
 */
export async function formAnswers(tx: Tx, eventId: string, input: AnswerInput, actor: Actor) {
  // saveForm locks the event FOR UPDATE, so a form save waits for registrations that read
  // the form until they commit, and then sees their answers when it checks whether a field
  // may change classification. Event edits (plain UPDATE) do not conflict with KEY SHARE.
  await tx.selectFrom("catalog.event").select("id").where("id", "=", eventId).forKeyShare().executeTakeFirst();
  const form = await getForm(tx, eventId);
  const answers = checkAnswers(form.fields, input, actor.kind === "attendee");
  if (actor.kind === "staff" && Object.keys(answers.sensitive).length && !can(actor.ctx, "registrations.sensitive")) {
    throw new DomainError("forbidden", "Missing permission registrations.sensitive");
  }
  return { form, answers };
}

/**
 * Internal: inserts a registration with its answers and takes its places: confirmed, with its
 * admission and registration.confirmed. When the places do not fit and opts.waitlist allows it
 * and the event's waitlist is open, it joins the waitlist instead (registration.waitlisted);
 * otherwise it throws full. The caller has checked who may register, the window and the answers.
 */
export async function insertConfirmed(
  tx: Tx, tenantId: string, target: catalog.RegistrationTarget,
  r: { name: string; email: string; locale: string; partySize: number; source: RegistrationSource; invitationId: string | null },
  a?: { form: Awaited<ReturnType<typeof getForm>>; answers: CheckedAnswers },
  opts: { waitlist?: boolean; now?: Date } = {},
): Promise<Registration> {
  const id = newId();
  const now = opts.now ?? new Date();
  const occurrenceId = target.occurrence.id;
  const row = await tx
    .insertInto("registration.registration")
    .values({
      id, tenant_id: tenantId, event_id: target.event.id, occurrence_id: occurrenceId, invitation_id: r.invitationId,
      name: r.name, email: r.email, locale: r.locale, party_size: r.partySize, status: "confirmed", source: r.source, confirmed_at: sql<Date>`now()`,
    })
    .returning(columns)
    .executeTakeFirstOrThrow()
    .catch((e: unknown) => {
      if (pgCode(e) === "23505") throw new DomainError("already_registered", "This email address is already registered for this occurrence");
      throw e;
    });
  // People already waiting go first: places that came free are offered to them before a
  // newcomer can take them.
  if (await hasWaiting(tx, occurrenceId)) await promoteWaitlist(tx, tenantId, occurrenceId, now);
  // Fails without changing anything if the places do not fit.
  const confirmed = await inventory.takePlaces(tx, occurrenceId, r.partySize);
  if (!confirmed) {
    // The transaction then rolls back.
    if (!opts.waitlist || !waitlistOpen(target, now)) throw new DomainError("full", "There are no places left");
    Object.assign(row, await tx.updateTable("registration.registration")
      .set({ status: "waitlisted", confirmed_at: null, waitlist_position: sql<string>`nextval('registration.waitlist_seq')` })
      .where("id", "=", id).returning(["status", "confirmed_at"]).executeTakeFirstOrThrow());
  }
  if (a && a.form.version > 0) {
    await writeAnswers(tx, tenantId, id, a.form, a.answers);
    Object.assign(row, await tx.selectFrom("registration.registration").select(["form_version", "sensitive_consent_at"]).where("id", "=", id).executeTakeFirstOrThrow());
  }
  if (confirmed) await admission.issueAdmission(tx, tenantId, id, occurrenceId, r.partySize);
  await catalog.detachForRegistrations(tx, occurrenceId);
  const status = confirmed ? "confirmed" : "waitlisted";
  await emit(tx, tenantId, {
    type: `registration.${status}.v1`, subject: `registration/${id}`,
    data: {
      registrationId: id, occurrenceId, eventId: target.event.id, status, partySize: r.partySize, source: r.source,
      ...(r.invitationId ? { invitationId: r.invitationId } : {}),
    },
  });
  return toRegistration(row);
}

export async function locked(tx: Tx, id: string): Promise<Registration> {
  const row = await tx.selectFrom("registration.registration").select(columns).where("id", "=", id).forUpdate().executeTakeFirst();
  if (!row) throw new DomainError("not_found", "Registration not found");
  return toRegistration(row);
}

/** Changes name, locale or party size. Adding the guest needs a free place. */
export async function updateRegistration(
  tx: Tx, tenantId: string, id: string, patch: RegistrationPatch, actor: Actor, opts: { expectedVersion?: number; now?: Date } = {},
): Promise<Registration> {
  if (actor.kind === "staff") assertCan(actor.ctx, "registrations.write");
  const now = opts.now ?? new Date();
  // A waiting party that shrinks may fit now, which promotes the line. Promotion locks the pool
  // and then rows of the line, so take the pool first here too, before this row.
  if (patch.partySize !== undefined) {
    const peek = await tx.selectFrom("registration.registration").select(["occurrence_id", "status"]).where("id", "=", id).executeTakeFirst();
    if (peek?.status === "waitlisted") await tx.selectFrom("inventory.capacity_pool").select("id").where("occurrence_id", "=", peek.occurrence_id).forUpdate().execute();
  }
  const before = await locked(tx, id);
  if (opts.expectedVersion !== undefined && opts.expectedVersion !== before.version) {
    throw new DomainError("version_conflict", "Registration was changed by someone else", { currentVersion: before.version });
  }
  if (before.status === "cancelled") throw new DomainError("conflict", "The registration is cancelled");
  if (before.anonymisedAt) throw new DomainError("conflict", "The registration has been anonymised");
  const target = await catalog.getRegistrationTarget(tx, before.occurrenceId);
  if (actor.kind === "attendee" && !attendeeRights(before, target, now).change) throw new DomainError("registration_closed", "Registration can no longer be changed");

  const name = patch.name !== undefined ? normalizeContact(patch.name, before.email).name : before.name;
  const partySize = patch.partySize ?? before.partySize;
  if (partySize !== before.partySize) assertPartySize(partySize, await guestAllowedFor(tx, before, target), actor);
  const locale = patch.locale !== undefined ? await pickLocale(tx, patch.locale) : before.locale;
  // Answers: staff without registrations.sensitive cannot see sensitive ones, so theirs stay as stored.
  let newAnswers: Awaited<ReturnType<typeof formAnswers>> | null = null;
  const keepSensitive = actor.kind === "staff" && !can(actor.ctx, "registrations.sensitive");
  if (patch.answers !== undefined) {
    const next = await formAnswers(tx, before.eventId, { answers: patch.answers, consent: patch.consent }, actor);
    const prev = (await readAnswers(tx, tenantId, [id], actor.kind === "staff" ? actor : { kind: "attendee" })).get(id)!;
    const merged = { ...next.answers.plain, ...(keepSensitive ? {} : next.answers.sensitive) };
    if (canonical(merged) !== canonical(prev) || (before.formVersion ?? 0) !== next.form.version) newAnswers = next;
  }
  const changed = [
    ...(name !== before.name ? ["name"] : []),
    ...(partySize !== before.partySize ? ["partySize"] : []),
    ...(locale !== before.locale ? ["locale"] : []),
    ...(newAnswers ? ["answers"] : []),
  ];
  if (changed.length === 0) return before;

  const delta = partySize - before.partySize;
  // An offer holds exactly the party's places: claim it (or decline it) first.
  if (delta !== 0 && before.status === "offered") throw new DomainError("conflict", "Claim the offered place before changing the party size", { field: "partySize" });
  // Only confirmed registrations hold places; a waiting one just changes the size it waits for.
  const holdsPlaces = before.status === "confirmed";
  if (holdsPlaces && delta > 0 && !(await inventory.takePlaces(tx, before.occurrenceId, delta))) throw new DomainError("full", "There is no place left for a guest");
  if (holdsPlaces && delta < 0) await inventory.releasePlaces(tx, before.occurrenceId, -delta);
  const row = await tx
    .updateTable("registration.registration")
    .set({ name, party_size: partySize, locale, version: sql<number>`version + 1` })
    .where("id", "=", id)
    .returning(columns)
    .executeTakeFirstOrThrow();
  if (holdsPlaces && delta !== 0) await admission.setAdmissionPartySize(tx, id, partySize);
  // The place given back, or a waiting party that now fits, goes to the first in line whose party fits.
  if (delta < 0 && (holdsPlaces || before.status === "waitlisted")) {
    const { offered } = await promoteWaitlist(tx, tenantId, before.occurrenceId, now);
    // Promotion may have offered this very registration a place: return (and announce) that.
    if (offered.includes(id)) Object.assign(row, await tx.selectFrom("registration.registration").select(columns).where("id", "=", id).executeTakeFirstOrThrow());
  }
  if (newAnswers) {
    await writeAnswers(tx, tenantId, id, newAnswers.form, newAnswers.answers, { keepSensitive, now });
    Object.assign(row, await tx.selectFrom("registration.registration").select(["form_version", "sensitive_consent_at"]).where("id", "=", id).executeTakeFirstOrThrow());
  }
  await emit(tx, tenantId, {
    type: "registration.changed.v1", subject: `registration/${id}`,
    data: { registrationId: id, occurrenceId: before.occurrenceId, eventId: before.eventId, status: row.status, partySize, changed },
  });
  if (actor.kind === "staff") {
    await recordAudit(tx, actor.ctx, { action: "registration.updated", entityType: "event", entityId: before.eventId, diff: { registrationId: id, changed, partySize } });
  }
  return toRegistration(row);
}

/** Pure: a stable text for comparing answers. */
const canonical = (a: Record<string, unknown>) => JSON.stringify(Object.keys(a).sort().map((k) => [k, a[k]]));

/** Whether the registration may bring a guest: the invitation's allowance if it came from one, else the event's. */
export async function guestAllowedFor(tx: Tx, reg: Pick<Registration, "invitationId">, target: catalog.RegistrationTarget): Promise<boolean> {
  if (!reg.invitationId) return target.event.guestAllowed;
  const r = await tx.selectFrom("registration.guest_invitation").select("guest_allowed").where("id", "=", reg.invitationId).executeTakeFirst();
  return r?.guest_allowed ?? target.event.guestAllowed;
}

/**
 * Cancels and gives the places back (a confirmed registration's, or the hold behind an offer),
 * which then go to the first in line on the waitlist. Leaving the waitlist is cancelling too.
 * Cancelling twice is a no-op.
 */
export async function cancelRegistration(tx: Tx, tenantId: string, id: string, actor: Actor, now: Date = new Date()): Promise<Registration> {
  if (actor.kind === "staff") assertCan(actor.ctx, "registrations.write");
  const before = await locked(tx, id);
  if (before.status === "cancelled") return before;
  if (actor.kind === "attendee") {
    const target = await catalog.getRegistrationTarget(tx, before.occurrenceId);
    if (!attendeeRights(before, target, now).cancel) throw new DomainError("registration_closed", "The registration can no longer be cancelled");
  }
  // Read before the update below clears it.
  const holdId = before.status === "offered"
    ? (await tx.selectFrom("registration.registration").select("offer_hold_id").where("id", "=", id).executeTakeFirst())?.offer_hold_id ?? null
    : null;
  const row = await tx
    .updateTable("registration.registration")
    .set({
      status: "cancelled", cancelled_at: now, cancelled_by: actor.kind, waitlist_position: null, offer_hold_id: null, offer_expires_at: null,
      version: sql<number>`version + 1`,
    })
    .where("id", "=", id)
    .returning(columns)
    .executeTakeFirstOrThrow();
  // Confirmed registrations hold places, offers a hold; waiting ones hold nothing.
  let freed = false;
  if (before.status === "confirmed") {
    await inventory.releasePlaces(tx, before.occurrenceId, before.partySize);
    freed = true;
  } else if (holdId) {
    freed = await inventory.endHold(tx, holdId, false, now);
  }
  await admission.voidAdmission(tx, id);
  if (freed) await promoteWaitlist(tx, tenantId, before.occurrenceId, now);
  // An invited guest who cancels has said no; the invitation link still lets them change their mind.
  if (before.invitationId) {
    await tx.updateTable("registration.guest_invitation").set({ status: "declined", responded_at: now, version: sql<number>`version + 1` })
      .where("id", "=", before.invitationId).where("status", "=", "accepted").execute();
  }
  await emit(tx, tenantId, {
    type: "registration.cancelled.v1", subject: `registration/${id}`,
    data: { registrationId: id, occurrenceId: before.occurrenceId, eventId: before.eventId, status: "cancelled", previousStatus: before.status, partySize: before.partySize, by: actor.kind },
  });
  if (actor.kind === "staff") {
    await recordAudit(tx, actor.ctx, { action: "registration.cancelled", entityType: "event", entityId: before.eventId, diff: { registrationId: id, occurrenceId: before.occurrenceId } });
  }
  return toRegistration(row);
}

export async function getRegistration(tx: Tx, id: string): Promise<Registration> {
  const row = await tx.selectFrom("registration.registration").select(columns).where("id", "=", id).executeTakeFirst();
  if (!row) throw new DomainError("not_found", "Registration not found");
  return toRegistration(row);
}

export interface RegistrationFilter {
  status?: RegistrationStatus[];
}

/** Staff: the registrations of one occurrence, oldest first. */
export async function listRegistrations(tx: Tx, ctx: ActorContext, occurrenceId: string, f: RegistrationFilter = {}): Promise<Registration[]> {
  assertCan(ctx, "registrations.read");
  let q = tx.selectFrom("registration.registration").select(columns).where("occurrence_id", "=", occurrenceId).orderBy("created_at").orderBy("id");
  if (f.status?.length) q = q.where("status", "in", f.status);
  return (await q.execute()).map(toRegistration);
}

// ── Attendee links ─────────────────────────────────────────────────────────────

/** The tenant a token claims; open its transaction, then call registrationByToken. */
export const tokenTenant = (token: string): string | null => peekToken(token)?.tenantId ?? null;

export const manageToken = (tx: Tx, tenantId: string, reg: Pick<Registration, "id" | "tokenVersion">) => issueToken(tx, tenantId, "manage", reg.id, reg.tokenVersion);

/** The admission QR code's token; null while the registration has no valid admission. */
export async function admissionToken(tx: Tx, tenantId: string, reg: Pick<Registration, "id" | "tokenVersion">): Promise<string | null> {
  const a = await admission.admissionFor(tx, reg.id);
  return a && a.status === "valid" ? issueToken(tx, tenantId, "admission", a.id, reg.tokenVersion) : null;
}

/** The registration a manage link points to, or null for a forged, rotated or foreign token. */
export async function registrationByToken(tx: Tx, token: string): Promise<Registration | null> {
  const claims = await verifyToken(tx, token, "manage");
  if (!claims) return null;
  const row = await tx.selectFrom("registration.registration").select(columns).where("id", "=", claims.subjectId).executeTakeFirst();
  return row && row.token_version === claims.tokenVersion ? toRegistration(row) : null;
}

/**
 * Finds the tenant of an occurrence for the open registration page, which only knows the
 * occurrence id. Runs without a tenant (SECURITY DEFINER lookup); null unless the occurrence
 * belongs to a published or cancelled registration event.
 */
export async function occurrenceTenant(tx: Tx, occurrenceId: string): Promise<string | null> {
  const r = await sql<{ t: string | null }>`select registration.occurrence_tenant(${occurrenceId}::uuid) as t`.execute(tx);
  return r.rows[0]?.t ?? null;
}

/** Confirmed registrations of the given occurrences: who to tell when an occurrence moves or is cancelled. */
export async function activeRegistrationIds(tx: Tx, occurrenceIds: readonly string[]): Promise<string[]> {
  if (occurrenceIds.length === 0) return [];
  const rows = await tx.selectFrom("registration.registration").select("id").where("occurrence_id", "in", occurrenceIds).where("status", "=", "confirmed").execute();
  return rows.map((r) => r.id);
}

/** Everything a registration email needs, in one read. */
export interface RegistrationMessage {
  registration: Registration;
  target: catalog.RegistrationTarget;
  account: { name: string; defaultLocale: string };
  /** Position in line while waitlisted; null otherwise. */
  waitlistRank: number | null;
}

export async function loadMessage(tx: Tx, id: string): Promise<RegistrationMessage | null> {
  const row = await tx.selectFrom("registration.registration").select(columns).where("id", "=", id).executeTakeFirst();
  // Nothing to send to an anonymised registration.
  if (!row || row.anonymised_at) return null;
  const [target, account, ranks] = await Promise.all([
    catalog.getRegistrationTarget(tx, row.occurrence_id), getAccount(tx), row.status === "waitlisted" ? waitlistRanks(tx, [id]) : Promise.resolve(new Map<string, number>()),
  ]);
  return { registration: toRegistration(row), target, account: { name: account.name, defaultLocale: account.defaultLocale }, waitlistRank: ranks.get(id) ?? null };
}

// ── Reminder before the event ─────────────────────────────────────────────────

/**
 * Pure: when to remind a registration, or null when no reminder is due: none set, sent
 * already, cancelled, started, or registered after the reminder time (the confirmation was
 * the reminder).
 */
export function reminderTime(
  reg: { status: RegistrationStatus; remindedAt: Date | null; createdAt: Date; confirmedAt?: Date | null }, target: catalog.RegistrationTarget, now: Date,
): Date | null {
  const before = target.event.reminderMinBefore;
  if (before === null || reg.remindedAt || reg.status !== "confirmed") return null;
  if (target.occurrence.status !== "scheduled" || target.event.status !== "published" || target.occurrence.startUtc <= now) return null;
  const at = new Date(target.occurrence.startUtc.getTime() - before * 60_000);
  // A place claimed from the waitlist counts from the claim.
  return (reg.confirmedAt ?? reg.createdAt) >= at ? null : at;
}

/** When to remind each of these confirmed registrations; for queueing reminder jobs. */
export async function reminderTimes(tx: Tx, registrationIds: readonly string[], now: Date = new Date()): Promise<{ id: string; runAt: Date }[]> {
  if (registrationIds.length === 0) return [];
  const rows = await tx.selectFrom("registration.registration").select(["id", "occurrence_id", "status", "reminded_at", "created_at", "confirmed_at"]).where("id", "in", registrationIds).execute();
  const targets = new Map<string, catalog.RegistrationTarget>();
  const out: { id: string; runAt: Date }[] = [];
  for (const r of rows) {
    if (r.status !== "confirmed" || r.reminded_at) continue;
    if (!targets.has(r.occurrence_id)) targets.set(r.occurrence_id, await catalog.getRegistrationTarget(tx, r.occurrence_id));
    const at = reminderTime({ status: r.status, remindedAt: r.reminded_at, createdAt: r.created_at, confirmedAt: r.confirmed_at }, targets.get(r.occurrence_id)!, now);
    if (at) out.push({ id: r.id, runAt: at });
  }
  return out;
}

/** Confirmed, not yet reminded registrations of an event's upcoming occurrences, e.g. after the reminder setting changed. */
export async function unremindedRegistrationIds(tx: Tx, eventId: string, now: Date = new Date()): Promise<string[]> {
  const occ = await catalog.upcomingOccurrenceIds(tx, eventId, now);
  if (occ.length === 0) return [];
  const rows = await tx.selectFrom("registration.registration").select("id")
    .where("occurrence_id", "in", occ).where("status", "=", "confirmed").where("reminded_at", "is", null).execute();
  return rows.map((r) => r.id);
}

/** Claims the reminder before sending it; false if it was claimed already. */
export async function markReminded(tx: Tx, id: string, now: Date = new Date()): Promise<boolean> {
  const r = await tx.updateTable("registration.registration").set({ reminded_at: now }).where("id", "=", id).where("reminded_at", "is", null).executeTakeFirst();
  return Number(r.numUpdatedRows) > 0;
}

/** Releases a claim when sending failed, so the retry sends. */
export async function unmarkReminded(tx: Tx, id: string, claimedAt: Date): Promise<void> {
  await tx.updateTable("registration.registration").set({ reminded_at: null }).where("id", "=", id).where("reminded_at", "=", claimedAt).execute();
}
