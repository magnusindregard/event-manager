import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, type Tx, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { type ActorContext, catalog, inventory, tenancy } from "../../src/index.js";

// Registration milestone 1 (docs/registration.md, "Capacity and holds"): pools per
// occurrence follow the effective capacity; places are taken with a conditional update.

let tdb: TestDatabase;
let db: Db;
let ctx: ActorContext;

const run = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(db, ctx, fn);
const title = (t: string) => ({ nb: { title: t } });

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  const account = await tenancy.createAccount(db, { slug: "capacity", name: "Capacity", ownerEmail: "owner@capacity.test" });
  const userId = await tenancy.login(db, { issuer: "https://idp.test", subject: "owner@capacity.test", email: "owner@capacity.test", name: null });
  ctx = { tenantId: account.id, userId, clientId: null, roles: ["owner"] };
});
afterAll(async () => {
  await db?.destroy();
  await tdb?.stop();
});

describe("bookable limit", () => {
  it("is capacity plus overbooking, rounded down", () => {
    expect(inventory.bookableLimit(40, 10)).toBe(44);
    expect(inventory.bookableLimit(15, 10)).toBe(16);
    expect(inventory.bookableLimit(null, 50)).toBeNull();
  });
});

describe("acceptance: open talk with 40 places and 10 % overbooking", () => {
  it("keeps pools in step with defaults, rules and overrides", async () => {
    const event = await run((tx) => catalog.createEvent(tx, ctx, {
      translations: title("Foredrag"), admissionMode: "registration", registration: { capacity: 40, overbookingPct: 10 },
    }));
    expect(event.registration).toMatchObject({ accessPolicy: "open", listed: true, capacity: 40, overbookingPct: 10 });

    const [mon, wed] = await run(async (tx) => [
      await catalog.createOccurrence(tx, ctx, event.id, { startUtc: new Date("2027-03-01T17:00:00Z") }), // Monday 18:00 Oslo
      await catalog.createOccurrence(tx, ctx, event.id, { startUtc: new Date("2027-03-03T17:00:00Z") }), // Wednesday
    ]);
    expect(mon!.pool).toMatchObject({ capacity: 40, overbookingPct: 10, bookableLimit: 44, taken: 0, available: 44 });
    expect(mon!.effective.capacity).toEqual({ value: 40, source: "default", ruleId: null });

    // "Wednesdays have 30 places", as a rule.
    const { rule } = await run((tx) => catalog.createRule(tx, ctx, event.id, {
      name: "Onsdag", conditions: { weekdays: [3] }, effects: [{ type: "capacity", value: 30 }],
    }));
    const wedAfter = await run((tx) => catalog.getOccurrence(tx, wed!.id));
    expect(wedAfter.effective.capacity).toEqual({ value: 30, source: "rule", ruleId: rule!.id });
    expect(wedAfter.pool).toMatchObject({ capacity: 30, bookableLimit: 33 });

    // An override on one occurrence wins over the default.
    const monAfter = await run((tx) => catalog.updateOccurrence(tx, ctx, mon!.id, mon!.version, { capacityOverride: 10 }));
    expect(monAfter.pool).toMatchObject({ capacity: 10, bookableLimit: 11 });
    expect(monAfter.overrides.capacity).toBe(10);

    // Changing the event default reaches occurrences without a rule or override.
    const current = await run((tx) => catalog.getEvent(tx, event.id));
    await run((tx) => catalog.updateEvent(tx, ctx, event.id, current.version, { registration: { overbookingPct: 0 } }));
    const pools = await run((tx) => inventory.listPools(tx, [mon!.id, wed!.id]));
    expect(pools.get(mon!.id)).toMatchObject({ bookableLimit: 10 });
    expect(pools.get(wed!.id)).toMatchObject({ bookableLimit: 30 });
  });

  it("takes 44 places, then refuses; a cancellation frees one", async () => {
    const event = await run((tx) => catalog.createEvent(tx, ctx, {
      translations: title("Fullt"), admissionMode: "registration", registration: { capacity: 40, overbookingPct: 10 },
    }));
    const occ = await run((tx) => catalog.createOccurrence(tx, ctx, event.id, { startUtc: new Date("2027-04-01T17:00:00Z") }));
    for (let i = 0; i < 22; i++) expect(await run((tx) => inventory.takePlaces(tx, occ.id, 2))).toBe(true);
    expect(await run((tx) => inventory.takePlaces(tx, occ.id, 1))).toBe(false);
    await run((tx) => inventory.releasePlaces(tx, occ.id, 2));
    // A party of 2 fits again, but then nothing more.
    expect(await run((tx) => inventory.takePlaces(tx, occ.id, 2))).toBe(true);
    expect(await run((tx) => inventory.getPool(tx, occ.id))).toMatchObject({ taken: 44, available: 0, overLimit: false });
  });

  it("gives the last place to exactly one of two concurrent requests", async () => {
    const event = await run((tx) => catalog.createEvent(tx, ctx, {
      translations: title("Siste plass"), admissionMode: "registration", registration: { capacity: 1 },
    }));
    const occ = await run((tx) => catalog.createOccurrence(tx, ctx, event.id, { startUtc: new Date("2027-04-02T17:00:00Z") }));
    const results = await Promise.all(Array.from({ length: 8 }, () => run((tx) => inventory.takePlaces(tx, occ.id, 1))));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await run((tx) => inventory.getPool(tx, occ.id))).toMatchObject({ taken: 1 });
  });

  it("holds places until they are claimed, released or expire", async () => {
    const event = await run((tx) => catalog.createEvent(tx, ctx, {
      translations: title("Venteliste"), admissionMode: "registration", registration: { capacity: 3 },
    }));
    const occ = await run((tx) => catalog.createOccurrence(tx, ctx, event.id, { startUtc: new Date("2027-04-03T17:00:00Z") }));
    const soon = new Date(Date.now() + 60_000);
    const claimed = await run((tx) => inventory.placeHold(tx, ctx.tenantId, occ.id, 1, soon));
    const expired = await run((tx) => inventory.placeHold(tx, ctx.tenantId, occ.id, 2, new Date(Date.now() - 1000)));
    expect(claimed).not.toBeNull();
    // Holds count against the limit.
    expect(await run((tx) => inventory.takePlaces(tx, occ.id, 1))).toBe(false);
    expect(await run((tx) => inventory.placeHold(tx, ctx.tenantId, occ.id, 1, soon))).toBeNull();

    expect(await run((tx) => inventory.endHold(tx, claimed!, true))).toBe(true);
    expect(await run((tx) => inventory.getPool(tx, occ.id))).toMatchObject({ held: 2, taken: 1 });
    expect(await run((tx) => inventory.sweepExpiredHolds(tx))).toEqual([occ.id]);
    expect(await run((tx) => inventory.getPool(tx, occ.id))).toMatchObject({ held: 0, taken: 1, available: 2 });
    expect(await run((tx) => inventory.endHold(tx, expired!, false))).toBe(false);
  });

  it("allows lowering capacity below what is taken, and flags it", async () => {
    const event = await run((tx) => catalog.createEvent(tx, ctx, {
      translations: title("Senket"), admissionMode: "registration", registration: { capacity: 5 },
    }));
    const occ = await run((tx) => catalog.createOccurrence(tx, ctx, event.id, { startUtc: new Date("2027-04-04T17:00:00Z") }));
    await run((tx) => inventory.takePlaces(tx, occ.id, 4));
    const lowered = await run((tx) => catalog.updateOccurrence(tx, ctx, occ.id, occ.version, { capacityOverride: 2 }));
    expect(lowered.pool).toMatchObject({ bookableLimit: 2, taken: 4, available: 0, overLimit: true });
    expect(await run((tx) => inventory.takePlaces(tx, occ.id, 1))).toBe(false);
  });
});

describe("registration settings", () => {
  it("creates pools when an event switches to registration, and only then", async () => {
    const event = await run((tx) => catalog.createEvent(tx, ctx, { translations: title("Bytter"), registration: { capacity: 20 } }));
    const occ = await run((tx) => catalog.createOccurrence(tx, ctx, event.id, { startUtc: new Date("2027-05-01T17:00:00Z") }));
    expect(occ.pool).toBeNull();
    await run((tx) => catalog.updateEvent(tx, ctx, event.id, event.version, { admissionMode: "registration" }));
    expect((await run((tx) => catalog.getOccurrence(tx, occ.id))).pool).toMatchObject({ bookableLimit: 20 });
  });

  it("hides invite-only events from listings unless told otherwise", async () => {
    const closed = await run((tx) => catalog.createEvent(tx, ctx, {
      translations: title("Galla"), admissionMode: "registration", registration: { accessPolicy: "invite_only", guestAllowed: true },
    }));
    expect(closed.registration).toMatchObject({ accessPolicy: "invite_only", listed: false, guestAllowed: true });
    const listed = await run((tx) => catalog.createEvent(tx, ctx, {
      translations: title("Åpen galla"), registration: { accessPolicy: "invite_only", listed: true },
    }));
    expect(listed.registration.listed).toBe(true);
  });

  it("rejects a window that closes before it opens", async () => {
    await expect(run((tx) => catalog.createEvent(tx, ctx, {
      translations: title("Feil"), registration: { opensMinBefore: 60, closesMinBefore: 120 },
    }))).rejects.toMatchObject({ code: "validation_failed", details: { field: "registration.opensMinBefore" } });
  });

  it("rejects capacity effects that are not whole numbers of places", async () => {
    const event = await run((tx) => catalog.createEvent(tx, ctx, { translations: title("Regel") }));
    await expect(run((tx) => catalog.createRule(tx, ctx, event.id, { name: "x", effects: [{ type: "capacity", value: -1 }] })))
      .rejects.toMatchObject({ code: "validation_failed" });
    await expect(run((tx) => catalog.createRule(tx, ctx, event.id, { name: "x", effects: [{ type: "overbooking", value: 12.5 }] })))
      .rejects.toMatchObject({ code: "validation_failed" });
  });
});
