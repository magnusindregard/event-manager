import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, sql, type Tx, withTenant } from "@event-manager/db";
import { migrations, startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { type ActorContext, catalog, DomainError, registration, tenancy } from "../../src/index.js";

// Registration milestone 5 (docs/registration.md): the waitlist. Full occurrences take people
// on a waitlist, freed places are offered to the first in line whose party fits as a hold until
// the claim deadline, and an offer that is not claimed goes to the next.

let tdb: TestDatabase;
let db: Db;
let ctx: ActorContext;
const attendee = { kind: "attendee" } as const;

const run = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(db, ctx, fn);
const title = (t: string) => ({ nb: { title: t }, en: { title: `${t} (en)` } });
const NOW = new Date("2027-02-01T12:00:00Z");
const START = new Date("2027-03-01T17:00:00Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);
const HOUR = 3_600_000;
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof DomainError ? e.code : String(e)));

async function talk(settings: Partial<catalog.RegistrationSettings> = {}, startUtc = START) {
  const event = await run(async (tx) => {
    const e = await catalog.createEvent(tx, ctx, {
      translations: title("Foredrag"), admissionMode: "registration",
      registration: { capacity: 40, overbookingPct: 10, waitlistEnabled: true, guestAllowed: true, ...settings },
    });
    return catalog.transitionEvent(tx, ctx, e.id, e.version, "publish");
  });
  const occ = await run((tx) => catalog.createOccurrence(tx, ctx, event.id, { startUtc }));
  return { event, occ };
}

const person = (i: number, extra: Partial<registration.RegistrationInput> = {}) => ({ name: `Person ${i}`, email: `p${i}@example.com`, ...extra });
const register = (occId: string, i: number, extra: Partial<registration.RegistrationInput> = {}, now = NOW) =>
  run((tx) => registration.register(tx, ctx.tenantId, occId, person(i, extra), attendee, now));
const get = (id: string) => run((tx) => registration.getRegistration(tx, id));
const pool = async (occId: string) => (await run((tx) => catalog.getOccurrence(tx, occId))).pool!;
const outbox = (id: string) => run((tx) => tx.selectFrom("outbox.event").select(["type", "data"]).where("subject", "=", `registration/${id}`).orderBy("created_at").orderBy("id").execute());

// Columns copied when cloning a waiting registration in bulk (id, email and position are new).
const copyColumns = ["tenant_id", "event_id", "occurrence_id", "name", "locale", "party_size", "status", "source"];

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl, { max: 20 });
  const account = await tenancy.createAccount(db, { slug: "waitlist", name: "Waitlist", ownerEmail: "owner@waitlist.test" });
  const userId = await tenancy.login(db, { issuer: "https://idp.test", subject: "owner@waitlist.test", email: "owner@waitlist.test", name: null });
  ctx = { tenantId: account.id, userId, clientId: null, roles: ["owner"] };
});
afterAll(async () => {
  await db?.destroy();
  await tdb?.stop();
});

describe("acceptance: an open talk with 40 places, 10 % overbooking and a waitlist", () => {
  it("takes 44, then waitlists; a cancellation offers the place to the first whose party fits, and an unclaimed offer goes to the next", async () => {
    const { occ } = await talk({ claimWindowMin: 24 * 60 });
    const confirmed: registration.Registration[] = [];
    for (let i = 0; i < 44; i++) confirmed.push(await register(occ.id, i));
    expect(confirmed.every((r) => r.status === "confirmed")).toBe(true);

    const target = await run((tx) => catalog.getRegistrationTarget(tx, occ.id));
    expect(catalog.targetAvailability(target, NOW).status).toBe("waitlist");

    // A party of two first in line, then two single people.
    const pair = await register(occ.id, 100, { partySize: 2 });
    const first = await register(occ.id, 101);
    const second = await register(occ.id, 102);
    expect([pair.status, first.status, second.status]).toEqual(["waitlisted", "waitlisted", "waitlisted"]);
    expect(await run((tx) => registration.waitlistRanks(tx, [pair.id, first.id, second.id]))).toEqual(new Map([[pair.id, 1], [first.id, 2], [second.id, 3]]));
    expect(await run((tx) => registration.admissionToken(tx, ctx.tenantId, first))).toBeNull();
    expect((await outbox(first.id)).map((e) => e.type)).toEqual(["registration.waitlisted.v1"]);
    expect(await pool(occ.id)).toMatchObject({ taken: 44, held: 0 });

    // One place comes free: the pair does not fit, so the first single person gets it.
    await run((tx) => registration.cancelRegistration(tx, ctx.tenantId, confirmed[0]!.id, attendee, NOW));
    const offered = await get(first.id);
    expect(offered).toMatchObject({ status: "offered", offerExpiresAt: later(24 * HOUR) });
    expect(await get(pair.id)).toMatchObject({ status: "waitlisted" });
    expect(await pool(occ.id)).toMatchObject({ taken: 43, held: 1, available: 0 });
    expect((await outbox(first.id)).map((e) => e.type)).toEqual(["registration.waitlisted.v1", "registration.offered.v1"]);

    // Nobody can take the held place meanwhile.
    expect((await register(occ.id, 103)).status).toBe("waitlisted");

    // Not claimed in time: the offer expires and goes to the next single person.
    await run((tx) => registration.expireOffer(tx, ctx.tenantId, first.id, later(25 * HOUR)));
    expect(await get(first.id)).toMatchObject({ status: "cancelled", cancelledBy: "expired", offerExpiresAt: null });
    expect(await get(second.id)).toMatchObject({ status: "offered" });
    expect(await code(run((tx) => registration.claimOffer(tx, ctx.tenantId, first.id, later(25 * HOUR))))).toBe("offer_expired");

    // Claimed in time: confirmed, with an admission, and the place is taken.
    const claimed = await run((tx) => registration.claimOffer(tx, ctx.tenantId, second.id, later(26 * HOUR)));
    expect(claimed).toMatchObject({ status: "confirmed", offerExpiresAt: null });
    expect(await run((tx) => registration.admissionToken(tx, ctx.tenantId, claimed))).toMatch(/^[A-Za-z0-9_-]{72}$/);
    expect(await pool(occ.id)).toMatchObject({ taken: 44, held: 0 });
    expect((await outbox(second.id)).at(-1)).toMatchObject({ type: "registration.confirmed.v1", data: expect.objectContaining({ fromWaitlist: true }) });
    // Claiming twice is a no-op.
    expect(await run((tx) => registration.claimOffer(tx, ctx.tenantId, second.id, later(26 * HOUR)))).toMatchObject({ status: "confirmed" });

    // The next single place goes to the single person behind the pair; once two are free, the pair fits.
    await run((tx) => registration.cancelRegistration(tx, ctx.tenantId, confirmed[1]!.id, attendee, later(27 * HOUR)));
    expect(await get(pair.id)).toMatchObject({ status: "waitlisted" });
    expect(await run((tx) => tx.selectFrom("registration.registration").select("status").where("email", "=", "p103@example.com").executeTakeFirstOrThrow())).toEqual({ status: "offered" });
    await run((tx) => registration.cancelRegistration(tx, ctx.tenantId, confirmed[2]!.id, attendee, later(27 * HOUR)));
    expect(await get(pair.id)).toMatchObject({ status: "waitlisted" });
    await run((tx) => registration.cancelRegistration(tx, ctx.tenantId, confirmed[3]!.id, attendee, later(27 * HOUR)));
    expect(await get(pair.id)).toMatchObject({ status: "offered" });
  });
});

describe("joining the waitlist", () => {
  it("is not possible without a waitlist, after its cutoff, or for staff who do not ask", async () => {
    const none = await talk({ capacity: 1, overbookingPct: 0, waitlistEnabled: false });
    await register(none.occ.id, 1);
    expect(await code(register(none.occ.id, 2))).toBe("full");
    const t = await run((tx) => catalog.getRegistrationTarget(tx, none.occ.id));
    expect(catalog.targetAvailability(t, NOW).status).toBe("full");

    const { occ } = await talk({ capacity: 1, overbookingPct: 0, waitlistCutoffMin: 120 });
    await register(occ.id, 3);
    const nearStart = new Date(START.getTime() - 90 * 60_000);
    expect(await code(register(occ.id, 4, {}, nearStart))).toBe("full");
    const target = await run((tx) => catalog.getRegistrationTarget(tx, occ.id));
    expect(catalog.targetAvailability(target, nearStart).status).toBe("full");

    const staff = { kind: "staff", ctx } as const;
    expect(await code(run((tx) => registration.register(tx, ctx.tenantId, occ.id, person(5), staff, NOW)))).toBe("full");
    expect(await run((tx) => registration.register(tx, ctx.tenantId, occ.id, person(5, { waitlist: true }), staff, NOW))).toMatchObject({ status: "waitlisted", source: "staff" });
  });

  it("keeps one active registration per email, waiting or not", async () => {
    const { occ } = await talk({ capacity: 1, overbookingPct: 0 });
    await register(occ.id, 1);
    await register(occ.id, 2);
    expect(await code(register(occ.id, 2))).toBe("already_registered");
  });

  it("lets the person waiting change their party freely, and leave the line", async () => {
    const { occ } = await talk({ capacity: 1, overbookingPct: 0 });
    await register(occ.id, 1);
    const w = await register(occ.id, 2);
    expect(await run((tx) => registration.updateRegistration(tx, ctx.tenantId, w.id, { partySize: 2 }, attendee, { now: NOW }))).toMatchObject({ partySize: 2, status: "waitlisted" });
    expect(await pool(occ.id)).toMatchObject({ taken: 1, held: 0 });
    const left = await run((tx) => registration.cancelRegistration(tx, ctx.tenantId, w.id, attendee, NOW));
    expect(left).toMatchObject({ status: "cancelled", cancelledBy: "attendee" });
    expect((await outbox(w.id)).at(-1)).toMatchObject({ type: "registration.cancelled.v1", data: expect.objectContaining({ previousStatus: "waitlisted" }) });
  });
});

describe("offers", () => {
  it("shorten the claim window to half the time left when the occurrence is close", async () => {
    expect(catalog.claimDeadline(NOW, later(10 * HOUR), 24 * 60)).toEqual(later(5 * HOUR));
    expect(catalog.claimDeadline(NOW, later(100 * HOUR), 24 * 60)).toEqual(later(24 * HOUR));

    const start = later(6 * HOUR);
    const { occ } = await talk({ capacity: 1, overbookingPct: 0, waitlistCutoffMin: 60 }, start);
    const a = await register(occ.id, 1);
    const b = await register(occ.id, 2);
    await run((tx) => registration.cancelRegistration(tx, ctx.tenantId, a.id, attendee, NOW));
    expect(await get(b.id)).toMatchObject({ status: "offered", offerExpiresAt: later(3 * HOUR) });
  });

  it("are not made after the waitlist cutoff or for a cancelled occurrence", async () => {
    const { occ } = await talk({ capacity: 1, overbookingPct: 0, waitlistCutoffMin: 120 });
    const a = await register(occ.id, 1);
    const b = await register(occ.id, 2);
    await run((tx) => registration.cancelRegistration(tx, ctx.tenantId, a.id, attendee, new Date(START.getTime() - 60 * 60_000)));
    expect(await get(b.id)).toMatchObject({ status: "waitlisted" });
    expect(await pool(occ.id)).toMatchObject({ taken: 0, held: 0 });

    const other = await talk({ capacity: 1, overbookingPct: 0 });
    const c = await register(other.occ.id, 3);
    const d = await register(other.occ.id, 4);
    const o = await run((tx) => catalog.getOccurrence(tx, other.occ.id));
    await run((tx) => catalog.updateOccurrence(tx, ctx, o.id, o.version, { status: "cancelled" }));
    await run((tx) => registration.cancelRegistration(tx, ctx.tenantId, c.id, attendee, NOW));
    expect(await get(d.id)).toMatchObject({ status: "waitlisted" });
  });

  it("can be declined, which passes the place on", async () => {
    const { occ } = await talk({ capacity: 1, overbookingPct: 0 });
    const a = await register(occ.id, 1);
    const b = await register(occ.id, 2);
    const c = await register(occ.id, 3);
    await run((tx) => registration.cancelRegistration(tx, ctx.tenantId, a.id, attendee, NOW));
    expect(await get(b.id)).toMatchObject({ status: "offered" });
    expect(await code(run((tx) => registration.updateRegistration(tx, ctx.tenantId, b.id, { partySize: 2 }, attendee, { now: NOW })))).toBe("conflict");
    await run((tx) => registration.cancelRegistration(tx, ctx.tenantId, b.id, attendee, NOW));
    expect(await get(c.id)).toMatchObject({ status: "offered" });
    expect(await pool(occ.id)).toMatchObject({ taken: 0, held: 1 });
    expect(await code(run((tx) => registration.claimOffer(tx, ctx.tenantId, b.id, NOW)))).toBe("no_offer");
  });

  it("follow a smaller party and more capacity", async () => {
    const { occ } = await talk({ capacity: 2, overbookingPct: 0 });
    const pair = await register(occ.id, 1, { partySize: 2 });
    const w1 = await register(occ.id, 2);
    const w2 = await register(occ.id, 3);
    await run((tx) => registration.updateRegistration(tx, ctx.tenantId, pair.id, { partySize: 1 }, attendee, { now: NOW }));
    expect(await get(w1.id)).toMatchObject({ status: "offered" });
    // More capacity: the worker promotes on capacity.changed.
    const o = await run((tx) => catalog.getOccurrence(tx, occ.id));
    await run((tx) => catalog.updateOccurrence(tx, ctx, o.id, o.version, { capacityOverride: 3 }));
    expect(await get(w2.id)).toMatchObject({ status: "waitlisted" });
    expect(await run((tx) => registration.promoteWaitlist(tx, ctx.tenantId, occ.id, NOW))).toEqual({ offered: [w2.id], expired: [] });
    expect(await pool(occ.id)).toMatchObject({ taken: 1, held: 2, available: 0 });
  });

  it("go to people already waiting before a newcomer can take a freed place", async () => {
    const { occ } = await talk({ capacity: 1, overbookingPct: 0 });
    await register(occ.id, 1);
    const w = await register(occ.id, 2);
    // Capacity grows, and someone registers before the worker has promoted the line.
    const o = await run((tx) => catalog.getOccurrence(tx, occ.id));
    await run((tx) => catalog.updateOccurrence(tx, ctx, o.id, o.version, { capacityOverride: 2 }));
    expect((await register(occ.id, 3)).status).toBe("waitlisted");
    expect(await get(w.id)).toMatchObject({ status: "offered" });
  });

  it("can be claimed by exactly one of two simultaneous claims, and never after the deadline", async () => {
    const { occ } = await talk({ capacity: 1, overbookingPct: 0, claimWindowMin: 60 });
    const a = await register(occ.id, 1);
    const b = await register(occ.id, 2);
    await run((tx) => registration.cancelRegistration(tx, ctx.tenantId, a.id, attendee, NOW));
    const results = await Promise.all([1, 2, 3].map(() => code(run((tx) => registration.claimOffer(tx, ctx.tenantId, b.id, later(30 * 60_000))))));
    expect(results).toEqual(["ok", "ok", "ok"]);
    expect(await pool(occ.id)).toMatchObject({ taken: 1, held: 0 });

    const c = await register(occ.id, 3);
    await run((tx) => registration.cancelRegistration(tx, ctx.tenantId, b.id, attendee, NOW));
    expect(await code(run((tx) => registration.claimOffer(tx, ctx.tenantId, c.id, later(2 * HOUR))))).toBe("offer_expired");
    // Until the job runs, the hold still keeps the place; then it goes back.
    expect(await pool(occ.id)).toMatchObject({ held: 1 });
    expect(await run((tx) => registration.expireOffer(tx, ctx.tenantId, c.id, later(30 * 60_000)))).toEqual(later(HOUR));
    expect(await run((tx) => registration.expireOffer(tx, ctx.tenantId, c.id, later(2 * HOUR)))).toBeNull();
    expect(await pool(occ.id)).toMatchObject({ taken: 0, held: 0 });
  });

  it("are retried when the expiry job finds the offer locked by someone else (review #69)", async () => {
    const { occ } = await talk({ capacity: 1, overbookingPct: 0, claimWindowMin: 60 });
    const a = await register(occ.id, 1);
    const b = await register(occ.id, 2);
    const c = await register(occ.id, 3);
    await run((tx) => registration.cancelRegistration(tx, ctx.tenantId, a.id, attendee, NOW));
    expect(await get(b.id)).toMatchObject({ status: "offered" });
    // Someone holds the offered row (a late claim, an edit) while the job runs after the deadline.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = run(async (tx) => {
      await tx.selectFrom("registration.registration").select("id").where("id", "=", b.id).forUpdate().execute();
      locked();
      await held;
    });
    await isLocked;
    const retry = await run((tx) => registration.expireOffer(tx, ctx.tenantId, b.id, later(2 * HOUR)));
    release();
    await holder;
    expect(retry).toEqual(new Date(later(2 * HOUR).getTime() + registration.EXPIRY_RETRY_MS));
    expect(await get(b.id)).toMatchObject({ status: "offered" });
    // The retry ends it and passes the place on.
    expect(await run((tx) => registration.expireOffer(tx, ctx.tenantId, b.id, retry!))).toBeNull();
    expect(await get(b.id)).toMatchObject({ status: "cancelled", cancelledBy: "expired" });
    expect(await get(c.id)).toMatchObject({ status: "offered" });
  });

  it("go to a waiting party that shrinks and now fits (review #69)", async () => {
    const { occ } = await talk({ capacity: 2, overbookingPct: 0 });
    await register(occ.id, 1);
    const pair = await register(occ.id, 2, { partySize: 2 });
    expect(pair.status).toBe("waitlisted");
    expect(await pool(occ.id)).toMatchObject({ taken: 1, available: 1 });
    const updated = await run((tx) => registration.updateRegistration(tx, ctx.tenantId, pair.id, { partySize: 1 }, attendee, { now: NOW }));
    const stored = await get(pair.id);
    expect(stored).toMatchObject({ status: "offered", partySize: 1 });
    // What the update returns (and announces) is the offer, not the row before promotion.
    expect(updated).toEqual(stored);
    const changed = (await outbox(pair.id)).find((e) => e.type === "registration.changed.v1");
    expect(changed?.data).toMatchObject({ status: "offered" });
    expect(await pool(occ.id)).toMatchObject({ taken: 1, held: 1, available: 0 });
  });

  it("look further down a line longer than one batch for a party that fits (review #69)", async () => {
    const { occ } = await talk({ capacity: 1, overbookingPct: 0 });
    const holder = await register(occ.id, 1);
    const pair = await register(occ.id, 2, { partySize: 2 });
    // A whole batch of waiting pairs ahead of a single person.
    await run((tx) => sql`
      insert into registration.registration (${sql.raw(copyColumns.join(", "))}, id, email, waitlist_position)
      select ${sql.raw(copyColumns.join(", "))}, gen_random_uuid(), 'pair' || g || '@example.com', nextval('registration.waitlist_seq')
        from registration.registration, generate_series(1, ${registration.LINE_BATCH - 1}) g where id = ${pair.id}`.execute(tx));
    const single = await register(occ.id, 3);
    expect(single.status).toBe("waitlisted");
    await run((tx) => registration.cancelRegistration(tx, ctx.tenantId, holder.id, attendee, NOW));
    expect(await get(single.id)).toMatchObject({ status: "offered" });
    expect((await register(occ.id, 4)).status).toBe("waitlisted");
  });

  it("never offer more places than came free when cancellations race", async () => {
    const { occ } = await talk({ capacity: 4, overbookingPct: 0 });
    const regs: registration.Registration[] = [];
    for (let i = 0; i < 4; i++) regs.push(await register(occ.id, i));
    const line: registration.Registration[] = [];
    for (let i = 10; i < 16; i++) line.push(await register(occ.id, i));
    await Promise.all(regs.slice(0, 3).map((r) => run((tx) => registration.cancelRegistration(tx, ctx.tenantId, r.id, attendee, NOW))));
    const statuses = await Promise.all(line.map((r) => get(r.id).then((x) => x.status)));
    expect(statuses).toEqual(["offered", "offered", "offered", "waitlisted", "waitlisted", "waitlisted"]);
    expect(await pool(occ.id)).toMatchObject({ taken: 1, held: 3 });
  });

  it("do not deadlock when a resize and a cancellation queue behind a promotion of the same registration (review #69)", async () => {
    const { occ } = await talk({ capacity: 1, overbookingPct: 0 });
    const holder = await register(occ.id, 1);
    const w = await register(occ.id, 2);
    expect(w.status).toBe("waitlisted");
    // Promotion holds the pool and the now offered row; the resize read the row as waiting.
    let release!: () => void;
    let promoted!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ready = new Promise<void>((r) => (promoted = r));
    const promotion = run(async (tx) => {
      await registration.cancelRegistration(tx, ctx.tenantId, holder.id, attendee, NOW);
      promoted();
      await gate;
    });
    await ready;
    const resize = code(run((tx) => registration.updateRegistration(tx, ctx.tenantId, w.id, { partySize: 2 }, attendee, { now: NOW })));
    await lockWaiters(1);
    const cancel = code(run((tx) => registration.cancelRegistration(tx, ctx.tenantId, w.id, attendee, NOW)));
    await lockWaiters(2);
    release();
    await promotion;
    // The resize finds an offer (claim it first); the cancellation ends it. Neither deadlocks.
    expect(await Promise.all([resize, cancel])).toEqual(["conflict", "ok"]);
    expect(await get(w.id)).toMatchObject({ status: "cancelled" });
    expect(await pool(occ.id)).toMatchObject({ taken: 0, held: 0 });
  });

  it("do not deadlock when a claim and a capacity edit of the occurrence overlap (review #69)", async () => {
    const { occ } = await talk({ capacity: 1, overbookingPct: 0 });
    const holder = await register(occ.id, 1);
    const w = await register(occ.id, 2);
    await run((tx) => registration.cancelRegistration(tx, ctx.tenantId, holder.id, attendee, NOW));
    expect(await get(w.id)).toMatchObject({ status: "offered" });
    const o = await run((tx) => catalog.getOccurrence(tx, occ.id));
    // The claim has taken its locks; the capacity edit starts before it issues the admission.
    let release!: () => void;
    let lockedIn!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ready = new Promise<void>((r) => (lockedIn = r));
    const claim = code(run(async (tx) => {
      await registration.lockedWithPool(tx, w.id);
      lockedIn();
      await gate;
      return registration.claimOffer(tx, ctx.tenantId, w.id, NOW);
    }));
    await ready;
    const edit = code(run((tx) => catalog.updateOccurrence(tx, ctx, o.id, o.version, { capacityOverride: 2 })));
    await lockWaiters(1);
    release();
    expect(await Promise.all([claim, edit])).toEqual(["ok", "ok"]);
    expect(await get(w.id)).toMatchObject({ status: "confirmed" });
    expect(await pool(occ.id)).toMatchObject({ taken: 1, held: 0 });
  });
});

/** Waits until n sessions are waiting for a lock. */
async function lockWaiters(n: number) {
  for (let i = 0; i < 200; i++) {
    const r = await sql<{ n: number }>`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`.execute(db);
    if (r.rows[0]!.n >= n) return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`fewer than ${n} sessions waiting for a lock`);
}

describe("invited guests", () => {
  it("join the waitlist when the time they accept is full", async () => {
    const { event, occ } = await talk({ capacity: 1, overbookingPct: 0, accessPolicy: "invite_only" });
    const [i1, i2] = await run(async (tx) => [
      await registration.createInvitation(tx, ctx, event.id, { email: "g1@example.com", name: "Gjest 1" }),
      await registration.createInvitation(tx, ctx, event.id, { email: "g2@example.com", name: "Gjest 2" }),
    ]);
    const r1 = await run((tx) => registration.acceptInvitation(tx, ctx.tenantId, i1.id, { occurrenceId: occ.id }, NOW));
    const r2 = await run((tx) => registration.acceptInvitation(tx, ctx.tenantId, i2.id, { occurrenceId: occ.id }, NOW));
    expect([r1.status, r2.status]).toEqual(["confirmed", "waitlisted"]);
    expect(await run((tx) => registration.getInvitation(tx, i2.id))).toMatchObject({ status: "accepted" });
    await run((tx) => registration.cancelRegistration(tx, ctx.tenantId, r1.id, attendee, NOW));
    await run((tx) => registration.expireOffer(tx, ctx.tenantId, r2.id, later(48 * HOUR)));
    expect(await run((tx) => registration.getInvitation(tx, i2.id))).toMatchObject({ status: "declined" });
  });
});

// Last: it rolls the schema back and forward again.
describe("migration 0015", () => {
  it("rolls back with open offers, giving their held places back to the pool (review #69)", async () => {
    const { occ } = await talk({ capacity: 1, overbookingPct: 0 });
    const holder = await register(occ.id, 1);
    const w = await register(occ.id, 2);
    await run((tx) => registration.cancelRegistration(tx, ctx.tenantId, holder.id, attendee, NOW));
    expect(await get(w.id)).toMatchObject({ status: "offered" });
    expect(await pool(occ.id)).toMatchObject({ held: 1 });
    const su = createDb(tdb.superuserUrl) as unknown as Parameters<(typeof migrations)[string]["up"]>[0];
    try {
      await migrations["0015_waitlist"]!.down!(su);
      const r = await sql<{ status: string; held: number; holds: number }>`
        select r.status, p.held, (select count(*)::int from inventory.hold h where h.pool_id = p.id) as holds
          from registration.registration r join inventory.capacity_pool p on p.occurrence_id = r.occurrence_id
         where r.id = ${w.id}`.execute(su);
      expect(r.rows).toEqual([{ status: "cancelled", held: 0, holds: 0 }]);
      await migrations["0015_waitlist"]!.up(su);
    } finally {
      await su.destroy();
    }
  });
});
