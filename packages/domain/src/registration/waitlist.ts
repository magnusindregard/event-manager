import { sql, type Tx } from "@event-manager/db";
import * as admission from "../admission/index.js";
import * as catalog from "../catalog/index.js";
import * as inventory from "../inventory/index.js";
import { emit } from "../outbox/index.js";
import { DomainError } from "../shared/index.js";
import { attendeeRights, getRegistration, locked, type Registration } from "./registrations.js";

// Waitlist (docs/registration.md, milestone 5). A registration that finds the occurrence full
// joins the line (waitlisted) when the event has a waitlist and its cutoff has not passed.
// Whenever places come free (a cancellation, a smaller party, more capacity, an offer that ran
// out), promoteWaitlist offers them to the first in line whose party fits: each offer is a hold
// on the pool until the claim deadline, so nobody else can take those places meanwhile. The
// attendee claims the offer from their manage page (confirmed, with the QR code); if they don't
// in time, the offer is cancelled as expired and the places go to the next in line.
//
// Lock order, to stay clear of deadlocks: promotion locks the pool first and then rows of the
// line. Anything that locks a waiting row and then touches the pool (claiming or declining an
// offer) is only ever a row that promotion skips while it is locked (SKIP LOCKED).

/** Pure: whether the event takes people on the waitlist now (offers stop at the cutoff). */
export function waitlistOpen(target: catalog.RegistrationTarget, now: Date): boolean {
  return target.event.waitlistEnabled && target.occurrence.status === "scheduled" && target.event.status === "published" &&
    now < catalog.waitlistCutoff(target.occurrence.startUtc, target.event.waitlistCutoffMin);
}

/** Whether anyone is waiting for this occurrence (waitlisted, not yet offered). */
export async function hasWaiting(tx: Tx, occurrenceId: string): Promise<boolean> {
  const r = await tx.selectFrom("registration.registration").select("id").where("occurrence_id", "=", occurrenceId).where("status", "=", "waitlisted").limit(1).executeTakeFirst();
  return !!r;
}

/** Position in line (1 = next) of the given registrations that are waitlisted. Offered ones are not in the map. */
export async function waitlistRanks(tx: Tx, registrationIds: readonly string[]): Promise<Map<string, number>> {
  if (registrationIds.length === 0) return new Map();
  const rows = await sql<{ id: string; rank: string }>`
    select id, rank from (
      select w.id, row_number() over (partition by w.occurrence_id order by w.waitlist_position) as rank
        from registration.registration w
       where w.status = 'waitlisted'
         and w.occurrence_id in (select r.occurrence_id from registration.registration r where r.id in (${sql.join(registrationIds)}))
    ) x where id in (${sql.join(registrationIds)})`.execute(tx);
  return new Map(rows.rows.map((r) => [r.id, Number(r.rank)]));
}

/** How many waiting registrations promotion reads at a time. */
export const LINE_BATCH = 1000;

export interface Promotion {
  /** Registrations that got an offer. */
  offered: string[];
  /** Offers that ran out and were cancelled. */
  expired: string[];
}

/**
 * Ends offers whose deadline has passed and offers free places to the line, first in line whose
 * party fits first, until the places run out. No offers after the waitlist cutoff or for a
 * cancelled occurrence; expired offers are ended regardless. Safe to call any time: it does
 * nothing when there is nothing to do.
 */
export async function promoteWaitlist(tx: Tx, tenantId: string, occurrenceId: string, now: Date = new Date()): Promise<Promotion> {
  const out: Promotion = { offered: [], expired: [] };
  // Serializes promotion per occurrence, so two cancellations never offer the same places twice.
  const pool = await tx.selectFrom("inventory.capacity_pool").select("id").where("occurrence_id", "=", occurrenceId).forUpdate().executeTakeFirst();
  if (!pool) return out;

  // Offers past their deadline. A row locked by someone else is being claimed or declined
  // right now; that settles it (a claim after the deadline fails, and its job comes back).
  const due = await tx.selectFrom("registration.registration")
    .select(["id", "event_id", "invitation_id", "party_size", "offer_hold_id"])
    .where("occurrence_id", "=", occurrenceId).where("status", "=", "offered").where("offer_expires_at", "<=", now)
    .orderBy("waitlist_position").forUpdate().skipLocked().execute();
  for (const d of due) {
    if (d.offer_hold_id) await inventory.endHold(tx, d.offer_hold_id, false, now);
    await tx.updateTable("registration.registration")
      .set({
        status: "cancelled", cancelled_at: now, cancelled_by: "expired", waitlist_position: null, offer_hold_id: null, offer_expires_at: null,
        version: sql<number>`version + 1`,
      })
      .where("id", "=", d.id).execute();
    // As when an invited guest cancels: the invitation link still lets them try again.
    if (d.invitation_id) {
      await tx.updateTable("registration.guest_invitation").set({ status: "declined", responded_at: now, version: sql<number>`version + 1` })
        .where("id", "=", d.invitation_id).where("status", "=", "accepted").execute();
    }
    await emit(tx, tenantId, {
      type: "registration.cancelled.v1", subject: `registration/${d.id}`,
      data: { registrationId: d.id, occurrenceId, eventId: d.event_id, status: "cancelled", previousStatus: "offered", partySize: d.party_size, by: "expired" },
    });
    out.expired.push(d.id);
  }

  const target = await catalog.getRegistrationTarget(tx, occurrenceId);
  const { occurrence, event } = target;
  const cutoff = catalog.waitlistCutoff(occurrence.startUtc, event.waitlistCutoffMin);
  if (occurrence.status !== "scheduled" || event.status !== "published" || now >= cutoff) return out;
  const free = target.pool?.bookableLimit === null ? Infinity : (target.pool?.available ?? 0);
  if (free <= 0) return out;
  const expiresAt = catalog.claimDeadline(now, occurrence.startUtc, event.claimWindowMin);
  if (expiresAt <= now) return out;

  let left = free;
  // The line in batches, in position order, until the places run out or nobody is left.
  let after: string | number | null = null;
  scan: while (left > 0) {
    let q = tx.selectFrom("registration.registration")
      .select(["id", "party_size", "waitlist_position"])
      .where("occurrence_id", "=", occurrenceId).where("status", "=", "waitlisted");
    if (after !== null) q = q.where("waitlist_position", ">", after);
    const line = await q.orderBy("waitlist_position").limit(LINE_BATCH).forUpdate().execute();
    for (const w of line) {
      after = w.waitlist_position;
      if (left <= 0) break scan;
      // First in line whose party fits: a party of two waits while a single place goes to the next.
      if (w.party_size > left) continue;
      const holdId = await inventory.placeHold(tx, tenantId, occurrenceId, w.party_size, expiresAt);
      if (!holdId) break scan;
      await tx.updateTable("registration.registration")
        .set({ status: "offered", offer_hold_id: holdId, offer_expires_at: expiresAt, version: sql<number>`version + 1` })
        .where("id", "=", w.id).execute();
      await emit(tx, tenantId, {
        type: "registration.offered.v1", subject: `registration/${w.id}`,
        data: { registrationId: w.id, occurrenceId, eventId: event.id, status: "offered", partySize: w.party_size, expiresAt: expiresAt.toISOString() },
      });
      out.offered.push(w.id);
      left -= w.party_size;
    }
    if (line.length < LINE_BATCH) break;
  }
  return out;
}

/**
 * The attendee claims their offer: the hold becomes taken places, the registration is confirmed
 * with its admission (and the confirmation email with the QR code). Claiming twice is a no-op.
 * Throws offer_expired after the deadline and no_offer when there is nothing to claim.
 */
export async function claimOffer(tx: Tx, tenantId: string, id: string, now: Date = new Date()): Promise<Registration> {
  const before = await locked(tx, id);
  if (before.status === "confirmed" && before.confirmedAt) return before;
  if (before.status === "cancelled" && before.cancelledBy === "expired") throw new DomainError("offer_expired", "The offer was not claimed in time");
  if (before.status !== "offered") throw new DomainError("no_offer", "There is no offer to claim");
  if (before.offerExpiresAt && now >= before.offerExpiresAt) throw new DomainError("offer_expired", "The offer was not claimed in time");
  const target = await catalog.getRegistrationTarget(tx, before.occurrenceId);
  if (!attendeeRights(before, target, now).claim) throw new DomainError("registration_closed", "The offer can no longer be claimed");
  const holdId = (await tx.selectFrom("registration.registration").select("offer_hold_id").where("id", "=", id).executeTakeFirstOrThrow()).offer_hold_id;
  // Converts only before the hold expires; checked again here (ADR 0003), not only by the job.
  if (!holdId || !(await inventory.endHold(tx, holdId, true, now))) throw new DomainError("offer_expired", "The offer was not claimed in time");
  await tx.updateTable("registration.registration")
    .set({ status: "confirmed", confirmed_at: sql<Date>`now()`, waitlist_position: null, offer_hold_id: null, offer_expires_at: null, version: sql<number>`version + 1` })
    .where("id", "=", id).execute();
  await admission.issueAdmission(tx, tenantId, id, before.occurrenceId, before.partySize);
  await emit(tx, tenantId, {
    type: "registration.confirmed.v1", subject: `registration/${id}`,
    data: {
      registrationId: id, occurrenceId: before.occurrenceId, eventId: before.eventId, status: "confirmed", partySize: before.partySize, source: before.source,
      fromWaitlist: true, ...(before.invitationId ? { invitationId: before.invitationId } : {}),
    },
  });
  return getRegistration(tx, id);
}

/** How long to wait before trying again when an overdue offer was locked by someone else. */
export const EXPIRY_RETRY_MS = 60_000;

/**
 * For the job scheduled at an offer's deadline: ends it if it is still open and past due, and
 * offers the places to the next in line. Returns when to run again, otherwise null: the deadline
 * if the job ran early, or shortly after now if promotion had to skip the offer because someone
 * held its row (a late claim that will fail, an attendee editing it), so it is not left holding
 * its places with nothing left to end it.
 */
export async function expireOffer(tx: Tx, tenantId: string, id: string, now: Date = new Date()): Promise<Date | null> {
  const reg = await tx.selectFrom("registration.registration").select(["occurrence_id", "status", "offer_expires_at"]).where("id", "=", id).executeTakeFirst();
  if (!reg || reg.status !== "offered" || !reg.offer_expires_at) return null;
  if (reg.offer_expires_at > now) return reg.offer_expires_at;
  const { expired } = await promoteWaitlist(tx, tenantId, reg.occurrence_id, now);
  return expired.includes(id) ? null : new Date(now.getTime() + EXPIRY_RETRY_MS);
}
