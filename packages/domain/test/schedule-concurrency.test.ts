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

