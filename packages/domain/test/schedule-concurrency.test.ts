import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, type Tx, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { type ActorContext, catalog, tenancy } from "../src/index.js";

// Schedule changes that race each other (#37, #38, #39). Each test holds one transaction open
// after its change, starts the competing one, then commits the first: the order is fixed
// without hooks in the domain code.

let tdb: TestDatabase;
let db: Db;
let ctx: ActorContext;

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  const account = await tenancy.createAccount(db, { slug: "sched", name: "Sched", ownerEmail: "o@sched.test" });
  const userId = await tenancy.login(db, { issuer: "t", subject: "o", email: "o@sched.test", name: null });
  ctx = { tenantId: account.id, userId, clientId: null, roles: ["owner"] };
});
afterAll(async () => {
  await db?.destroy();
  await tdb?.stop();
});

const run = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(db, ctx, fn);
const settle = <T>(p: Promise<T>) => p.then((value) => ({ ok: true as const, value }), (error: { code?: string; message?: string }) => ({ ok: false as const, error }));
const pause = (ms = 250) => new Promise((r) => setTimeout(r, ms));

/** Runs `fn` in a transaction and keeps it open until `commit()`; resolves `done` once `fn` has run. */
function held<T>(fn: (tx: Tx) => Promise<T>) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let ran!: (v: T) => void;
  const done = new Promise<T>((r) => (ran = r));
  const tx = run(async (t) => {
    const v = await fn(t);
    ran(v);
    await gate;
    return v;
  });
  return { done, commit: async () => { release(); return tx; } };
}

const occurrences = (eventId: string) => run((tx) => catalog.listOccurrences(tx, { eventId, limit: 1000 }));
const event = (title: string) => run((tx) => catalog.createEvent(tx, ctx, { translations: { nb: { title } } }));

describe("archived events (#37)", () => {
  it("refuses to update or delete their occurrences", async () => {
    const e = await event("Archive");
    const occ = await run((tx) => catalog.createOccurrence(tx, ctx, e.id, { startUtc: new Date("2027-05-01T10:00:00Z") }));
    await run((tx) => catalog.transitionEvent(tx, ctx, e.id, e.version, "archive"));

    await expect(run((tx) => catalog.updateOccurrence(tx, ctx, occ.id, occ.version, { startUtc: new Date("2027-05-02T10:00:00Z") })))
      .rejects.toMatchObject({ code: "conflict", message: "The event is archived" });
    await expect(run((tx) => catalog.updateOccurrence(tx, ctx, occ.id, occ.version, { status: "cancelled" }))).rejects.toMatchObject({ code: "conflict" });
    await expect(run((tx) => catalog.deleteOccurrence(tx, ctx, occ.id, occ.version))).rejects.toMatchObject({ code: "conflict" });
    await expect(run((tx) => catalog.reattachOccurrence(tx, ctx, occ.id, occ.version))).rejects.toMatchObject({ code: "conflict" });
    expect(await occurrences(e.id)).toEqual([expect.objectContaining({ id: occ.id, version: occ.version, status: "scheduled", startUtc: occ.startUtc })]);
  });

  it("an occurrence edit that waits for an archive sees the event archived", async () => {
    const e = await event("Archive race");
    const occ = await run((tx) => catalog.createOccurrence(tx, ctx, e.id, { startUtc: new Date("2027-05-01T10:00:00Z") }));
    const archive = held((tx) => catalog.transitionEvent(tx, ctx, e.id, e.version, "archive"));
    await archive.done;
    const edit = settle(run((tx) => catalog.updateOccurrence(tx, ctx, occ.id, occ.version, { startUtc: new Date("2027-05-02T10:00:00Z") })));
    await pause();
    await archive.commit();
    expect(await edit).toMatchObject({ ok: false, error: { message: "The event is archived" } });
    expect((await occurrences(e.id))[0]).toMatchObject({ version: occ.version, startUtc: occ.startUtc });
  });

  it("an archive waits for an occurrence edit in progress", async () => {
    const e = await event("Archive after edit");
    const occ = await run((tx) => catalog.createOccurrence(tx, ctx, e.id, { startUtc: new Date("2027-05-01T10:00:00Z") }));
    const edit = held((tx) => catalog.updateOccurrence(tx, ctx, occ.id, occ.version, { startUtc: new Date("2027-05-02T10:00:00Z") }));
    await edit.done;
    let archived = false;
    const archive = run((tx) => catalog.transitionEvent(tx, ctx, e.id, e.version, "archive")).then((r) => ((archived = true), r));
    await pause();
    expect(archived).toBe(false);
    await edit.commit();
    expect((await archive).status).toBe("archived");
  });
});

describe("series regeneration and hand edits (#38)", () => {
  // Daily at 10:00 Oslo from 4 January 2027.
  async function daily(rrule = "FREQ=DAILY;COUNT=5") {
    const e = await event("Daily");
    const s = (await run((tx) => catalog.createSeries(tx, ctx, e.id, { rrule, dtstartLocal: "2027-01-04T10:00" }))).series!;
    const first = (await occurrences(e.id))[0]!;
    return { e, s, first };
  }
  const handEdited = new Date("2027-01-04T15:00:00Z"); // 16:00 Oslo

  it("a hand edit committed while regeneration waits is kept and reported as a conflict", async () => {
    const { e, s, first } = await daily();
    const edit = held((tx) => catalog.updateOccurrence(tx, ctx, first.id, first.version, { startUtc: handEdited }));
    await edit.done;
    const series = settle(run((tx) => catalog.updateSeries(tx, ctx, s.id, s.version, { dtstartLocal: "2027-01-04T11:00" })));
    await pause();
    await edit.commit();
    const r = await series;
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.value.changes.counts).toMatchObject({ moved: 4, conflicts: 1 });
    const after = (await occurrences(e.id)).find((o) => o.id === first.id)!;
    expect(after).toMatchObject({ startUtc: handEdited, detached: true, conflict: true });
  });

  it("a hand edit started during regeneration fails its version check instead of being overwritten", async () => {
    const { e, s, first } = await daily();
    const series = held((tx) => catalog.updateSeries(tx, ctx, s.id, s.version, { dtstartLocal: "2027-01-04T11:00" }));
    await series.done;
    const edit = settle(run((tx) => catalog.updateOccurrence(tx, ctx, first.id, first.version, { startUtc: handEdited })));
    await pause();
    await series.commit();
    expect(await edit).toMatchObject({ ok: false, error: { code: "version_conflict" } });
    expect((await occurrences(e.id))[0]).toMatchObject({ id: first.id, startUtc: new Date("2027-01-04T10:00:00Z"), detached: false });
  });

  it("an occurrence detached while regeneration waits is not deleted by it", async () => {
    const { e, s } = await daily();
    const last = (await occurrences(e.id)).at(-1)!;
    const edit = held((tx) => catalog.updateOccurrence(tx, ctx, last.id, last.version, { startUtc: new Date("2027-01-08T15:00:00Z") }));
    await edit.done;
    const series = settle(run((tx) => catalog.updateSeries(tx, ctx, s.id, s.version, { rrule: "FREQ=DAILY;COUNT=4" })));
    await pause();
    await edit.commit();
    const r = await series;
    expect(r.ok && r.value.changes.counts).toMatchObject({ deleted: 0, conflicts: 1 });
    expect((await occurrences(e.id)).find((o) => o.id === last.id)).toMatchObject({ detached: true, conflict: true });
  });
});

describe("horizon extension (#39)", () => {
  const created = new Date("2027-01-01T00:00:00Z");
  const later = new Date("2027-02-01T02:00:00Z");
  async function openEnded() {
    const e = await event("Open-ended");
    const s = (await run((tx) => catalog.createSeries(tx, ctx, e.id, { rrule: "FREQ=DAILY", dtstartLocal: "2027-01-04T10:00" }, { now: created }))).series!;
    return { e, s };
  }
  const shorten = (s: { id: string; version: number }) => run((tx) => catalog.updateSeries(tx, ctx, s.id, s.version, { rrule: "FREQ=DAILY;COUNT=2" }));

  it("a rule shortened while an extension is in progress removes the extension's slots", async () => {
    const { e, s } = await openEnded();
    const extend = held((tx) => catalog.extendSeriesHorizon(tx, ctx.tenantId, s.id, later));
    expect(await extend.done).toBeGreaterThan(20);
    const edit = shorten(s);
    await pause();
    await extend.commit();
    await edit;
    expect(await occurrences(e.id)).toHaveLength(2);
    expect(await run((tx) => catalog.getSeries(tx, s.id))).toMatchObject({ rrule: "FREQ=DAILY;COUNT=2", complete: true });
  });

  it("an extension that waits for a rule change extends the new rule", async () => {
    const { e, s } = await openEnded();
    const edit = held(async (tx) => catalog.updateSeries(tx, ctx, s.id, s.version, { rrule: "FREQ=DAILY;COUNT=2" }));
    await edit.done;
    const extend = run((tx) => catalog.extendSeriesHorizon(tx, ctx.tenantId, s.id, later));
    await pause();
    await edit.commit();
    expect(await extend).toBe(0);
    expect(await occurrences(e.id)).toHaveLength(2);
    expect(await run((tx) => catalog.getSeries(tx, s.id))).toMatchObject({ complete: true });
  });

  it("overlapping extensions create each slot once", async () => {
    const { e, s } = await openEnded();
    const before = (await occurrences(e.id)).length;
    const [a, b] = await Promise.all([
      run((tx) => catalog.extendSeriesHorizon(tx, ctx.tenantId, s.id, later)),
      run((tx) => catalog.extendSeriesHorizon(tx, ctx.tenantId, s.id, later)),
    ]);
    expect(a + b).toBe((await occurrences(e.id)).length - before);
    expect(Math.min(a, b)).toBe(0);
  });
});

describe("rule saves and resolution (#41, #42)", () => {
  async function setup(withOccurrence = true) {
    const e = await event("Rules");
    const [low, high] = await Promise.all(["Low", "High"].map((name) => run((tx) => catalog.createLocation(tx, ctx, { kind: "venue", name }))));
    const occ = withOccurrence ? await run((tx) => catalog.createOccurrence(tx, ctx, e.id, { startUtc: new Date("2027-05-01T10:00:00Z") })) : null;
    return { e, low: low!, high: high!, occ };
  }
  const locationRule = (eventId: string, locationId: string, priority: number) =>
    (tx: Tx) => catalog.createRule(tx, ctx, eventId, { name: `p${priority}`, priority, effects: [{ type: "location", targetRef: null, value: locationId }] });
  const effectiveLocation = async (eventId: string) => (await occurrences(eventId))[0]!.effective.location;

  it("a lower-priority rule saved after a higher one does not overwrite its result", async () => {
    const { e, low, high } = await setup();
    const higher = held(locationRule(e.id, high.id, 10));
    await higher.done;
    const lower = run(locationRule(e.id, low.id, 0));
    await pause();
    await higher.commit();
    expect((await lower).resolution).toBe("none"); // the waiting save previews against the higher rule: nothing changes
    expect(await effectiveLocation(e.id)).toMatchObject({ value: high.id, source: "rule" });
  });

  it("an occurrence created while a rule is saved gets the rule", async () => {
    const { e, low } = await setup(false);
    const rule = held(locationRule(e.id, low.id, 0));
    expect((await rule.done).resolution).toBe("none"); // no occurrences yet
    const created = run((tx) => catalog.createOccurrence(tx, ctx, e.id, { startUtc: new Date("2027-05-01T10:00:00Z") }));
    await pause();
    await rule.commit();
    await created;
    expect(await effectiveLocation(e.id)).toMatchObject({ value: low.id, source: "rule" });
  });

  it("a rule saved while an occurrence is created resolves that occurrence", async () => {
    const { e, low } = await setup(false);
    const created = held((tx) => catalog.createOccurrence(tx, ctx, e.id, { startUtc: new Date("2027-05-01T10:00:00Z") }));
    await created.done;
    const rule = run(locationRule(e.id, low.id, 0));
    await pause();
    await created.commit();
    expect((await rule).resolution).toBe("done");
    expect(await effectiveLocation(e.id)).toMatchObject({ value: low.id, source: "rule" });
  });
});
