import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, type Tx, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { type ActorContext, catalog, inventory, offers, tenancy } from "../../src/index.js";

// Ticketing milestone 1 (docs/ticketing.md): offers, default prices, price and offerAvailable
// rule effects, overrides per (offer, occurrence), effective prices with their source, and the
// public API's offers.

let tdb: TestDatabase;
let db: Db;
let ctx: ActorContext;
let editor: ActorContext;
let exempt: offers.VatClass;

const run = <T>(fn: (tx: Tx) => Promise<T>, as: ActorContext = ctx) => withTenant(db, as, fn);
const title = (t: string) => ({ nb: { title: t } });
const name = (n: string) => ({ nb: { name: n } });

// February 2027 in Oslo is UTC+1. Fri 12, Sat 13, Sun 14.
const FRI_EVENING = new Date("2027-02-12T18:30:00Z");
const SAT_MATINEE = new Date("2027-02-13T13:00:00Z");
const SAT_EVENING = new Date("2027-02-13T18:30:00Z");
const SUN_MATINEE = new Date("2027-02-14T13:00:00Z");

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  const account = await tenancy.createAccount(db, { slug: "tickets", name: "Tickets", ownerEmail: "owner@tickets.test" });
  const userId = await tenancy.login(db, { issuer: "https://idp.test", subject: "owner@tickets.test", email: "owner@tickets.test", name: null });
  ctx = { tenantId: account.id, userId, clientId: null, roles: ["owner"] };
  editor = { ...ctx, roles: ["editor"] };
  exempt = await run((tx) => offers.createVatClass(tx, ctx, { code: "exempt", label: "Fritatt", ratePct: 0 }));
});
afterAll(async () => {
  await db?.destroy();
  await tdb?.stop();
});

async function concert(slug: string, starts: Date[]) {
  const event = await run((tx) => catalog.createEvent(tx, ctx, { slug, translations: title("Konsert"), admissionMode: "tickets", registration: { capacity: 100 } }));
  const occs = [];
  for (const startUtc of starts) occs.push(await run((tx) => catalog.createOccurrence(tx, ctx, event.id, { startUtc })));
  const adult = (await run((tx) => offers.createOffer(tx, ctx, event.id, { translations: name("Voksen"), vatClassId: exempt.id, defaultPrice: 45000 }))).offer!;
  const student = (await run((tx) => offers.createOffer(tx, ctx, event.id, { translations: name("Student"), vatClassId: exempt.id, defaultPrice: 25000 }))).offer!;
  return { event, occs, adult, student };
}

const cell = (grid: Awaited<ReturnType<typeof offers.priceGrid>>, occurrenceId: string, offerId: string) =>
  grid.rows.find((r) => r.occurrenceId === occurrenceId)!.cells.find((c) => c.offerId === offerId)!;

describe("acceptance: Adult 450 and Student 250, Student off sale on Saturday evenings", () => {
  it("shows each cell's source in the grid, and only Adult on Saturdays in the public API", async () => {
    const { event, occs, adult, student } = await concert("konsert-a", [FRI_EVENING, SAT_EVENING, SAT_MATINEE]);
    expect(adult.code).toBe("voksen");
    expect(student.sortOrder).toBeGreaterThan(adult.sortOrder);
    const [fri, satEve, satMat] = occs;

    const { rule } = await run((tx) => catalog.createRule(tx, ctx, event.id, {
      name: "Ingen student lørdag kveld", conditions: { weekdays: [6], startTimeFrom: "17:00" },
      effects: [{ type: "offerAvailable", targetRef: student.id, value: false }],
    }));
    expect(rule!.effects).toEqual([{ type: "offerAvailable", targetRef: student.id, value: false }]);

    const grid = await run((tx) => offers.priceGrid(tx, event.id, { limit: 100 }));
    expect(grid.offers.map((o) => o.code)).toEqual(["voksen", "student"]);
    expect(cell(grid, fri!.id, adult.id)).toMatchObject({ price: { value: 45000, source: "default", ruleId: null }, available: { value: true, source: "default" } });
    expect(cell(grid, satEve!.id, student.id)).toMatchObject({ price: { value: 25000, source: "default" }, available: { value: false, source: "rule", ruleId: rule!.id } });
    expect(cell(grid, satMat!.id, student.id).available).toMatchObject({ value: true, source: "default" });

    await run(async (tx) => catalog.transitionEvent(tx, ctx, event.id, (await catalog.getEvent(tx, event.id)).version, "publish"));
    const pub = await run((tx) => catalog.listPublicOccurrences(tx, { preview: false, now: new Date("2027-01-01T00:00:00Z") }, { event: event.id, from: new Date("2027-01-01T00:00:00Z"), limit: 10 }));
    const byId = new Map(pub.items.map((o) => [o.id, o]));
    expect(byId.get(fri!.id)!.admission).toEqual({ mode: "tickets" });
    expect(byId.get(fri!.id)!.offers.map((o) => [o.code, o.price.amount])).toEqual([["voksen", 45000], ["student", 25000]]);
    expect(byId.get(satEve!.id)!.offers.map((o) => o.code)).toEqual(["voksen"]);
    expect(byId.get(satEve!.id)!.offers[0]).toMatchObject({ name: "Voksen", price: { amount: 45000, currency: "NOK", vatIncluded: true }, onSale: true });
    expect(byId.get(satMat!.id)!.offers.map((o) => o.code)).toEqual(["voksen", "student"]);

    // Ticketed occurrences get a capacity pool, as registration occurrences do.
    expect((await run((tx) => inventory.getPool(tx, fri!.id)))).toMatchObject({ capacity: 100 });
  });
});

describe("acceptance: weekend Adult 500, one occurrence overridden to 400", () => {
  it("moves every weekend price with the rule except the override", async () => {
    const { event, occs, adult, student } = await concert("konsert-b", [FRI_EVENING, SAT_MATINEE, SUN_MATINEE]);
    const [fri, sat, sun] = occs;

    const created = await run((tx) => catalog.createRule(tx, ctx, event.id, {
      name: "Helg", conditions: { weekdays: [6, 7] }, effects: [{ type: "price", targetRef: adult.id, value: { amount: 50000 } }],
    }));
    // The preview reports price changes per offer, so the save resolves them.
    expect(created.preview.counts).toMatchObject({ matched: 2, changed: 2 });
    expect(created.preview.changes[0]!.fields).toEqual([
      { field: "price", targetRef: adult.id, from: { value: 45000, source: "default", ruleId: null }, to: { value: 50000, source: "rule", ruleId: created.rule!.id } },
    ]);
    expect(created.resolution).toBe("done");

    const overridden = await run((tx) => offers.setOverride(tx, ctx, adult.id, sun!.id, { amount: 40000 }));
    expect(overridden).toMatchObject({ price: { value: 40000, source: "override" }, override: { amount: 40000, available: null } });

    // Changing the rule moves Saturday, not the overridden Sunday; the preview counts the override.
    const changed = await run((tx) => catalog.updateRule(tx, ctx, created.rule!.id, created.rule!.version, {
      effects: [{ type: "price", targetRef: adult.id, value: { amount: 52000 } }],
    }));
    expect(changed.preview.counts).toMatchObject({ matched: 2, changed: 1, overridden: 1 });
    let grid = await run((tx) => offers.priceGrid(tx, event.id, { limit: 100 }));
    expect(cell(grid, fri!.id, adult.id).price.value).toBe(45000);
    expect(cell(grid, sat!.id, adult.id).price).toEqual({ value: 52000, source: "rule", ruleId: created.rule!.id });
    expect(cell(grid, sun!.id, adult.id).price).toEqual({ value: 40000, source: "override", ruleId: null });
    expect(cell(grid, sat!.id, student.id).price.source).toBe("default");

    // A new default reaches occurrences without a rule or override.
    await run((tx) => offers.updateOffer(tx, ctx, adult.id, adult.version, { defaultPrice: 47000 }));
    // Clearing the override puts Sunday back on the rule.
    await run((tx) => offers.setOverride(tx, ctx, adult.id, sun!.id, { amount: null }));
    grid = await run((tx) => offers.priceGrid(tx, event.id, { limit: 100 }));
    expect(cell(grid, fri!.id, adult.id).price).toEqual({ value: 47000, source: "default", ruleId: null });
    expect(cell(grid, sun!.id, adult.id)).toMatchObject({ price: { value: 52000, source: "rule" }, override: null });

    // An availability override wins over the default too, and keeps the price as it is.
    const off = await run((tx) => offers.setOverride(tx, ctx, student.id, fri!.id, { available: false }));
    expect(off).toMatchObject({ price: { value: 25000, source: "default" }, available: { value: false, source: "override" } });
  });

  it("emits price.changed for the occurrences whose prices moved", async () => {
    const { event, occs, adult } = await concert("konsert-c", [FRI_EVENING, SAT_MATINEE]);
    await run((tx) => catalog.createRule(tx, ctx, event.id, { name: "Lørdag", conditions: { weekdays: [6] }, effects: [{ type: "price", targetRef: adult.id, value: { amount: 1 } }] }));
    const events = await run((tx) => tx.selectFrom("outbox.event").select(["type", "data"]).where("type", "=", "price.changed.v1").orderBy("created_at", "desc").execute());
    const last = events.find((e) => (e.data as { eventId: string }).eventId === event.id)!;
    expect((last.data as { occurrenceIds: string[] }).occurrenceIds).toEqual([occs[1]!.id]);
  });
});

describe("offers", () => {
  it("are for ticketed events only, and take offers.write", async () => {
    const reg = await run((tx) => catalog.createEvent(tx, ctx, { translations: title("Påmelding"), admissionMode: "registration" }));
    await expect(run((tx) => offers.createOffer(tx, ctx, reg.id, { translations: name("Voksen"), vatClassId: exempt.id, defaultPrice: 100 })))
      .rejects.toMatchObject({ code: "conflict" });
    const { event, adult } = await concert("konsert-d", [FRI_EVENING]);
    await expect(run((tx) => offers.createOffer(tx, editor, event.id, { translations: name("Barn"), vatClassId: exempt.id, defaultPrice: 100 }), editor))
      .rejects.toMatchObject({ code: "forbidden" });
    // Editors keep plain rules, but not price rules.
    await expect(run((tx) => catalog.createRule(tx, editor, event.id, { name: "Pris", effects: [{ type: "price", targetRef: adult.id, value: { amount: 1 } }] }), editor))
      .rejects.toMatchObject({ code: "forbidden" });
    await expect(run((tx) => offers.createOffer(tx, ctx, event.id, { code: "voksen", translations: name("Voksen 2"), vatClassId: exempt.id, defaultPrice: 100 })))
      .rejects.toMatchObject({ code: "conflict", details: { field: "code" } });
  });

  it("are the only targets a price rule may name: the event's own, active offers", async () => {
    const a = await concert("konsert-e", [FRI_EVENING]);
    const b = await concert("konsert-f", [FRI_EVENING]);
    await expect(run((tx) => catalog.createRule(tx, ctx, a.event.id, { name: "Feil", effects: [{ type: "price", targetRef: b.adult.id, value: { amount: 1 } }] })))
      .rejects.toMatchObject({ code: "validation_failed", details: { field: "effects" } });
    await expect(run((tx) => catalog.createRule(tx, ctx, a.event.id, { name: "Uten mål", effects: [{ type: "price", value: { amount: 1 } }] })))
      .rejects.toMatchObject({ code: "validation_failed", details: { field: "effects.0.targetRef" } });
    // One price per offer per rule, but a rule may price several offers.
    const { rule } = await run((tx) => catalog.createRule(tx, ctx, a.event.id, {
      name: "Helgematiné", effects: [{ type: "price", targetRef: a.adult.id, value: { amount: 25000 } }, { type: "price", targetRef: a.student.id, value: { amount: 12000 } }],
    }));
    expect(rule!.effects).toHaveLength(2);
    // An offer a rule refers to cannot be deleted; one without rules can.
    await expect(run((tx) => offers.deleteOffer(tx, ctx, a.adult.id, a.adult.version))).rejects.toMatchObject({ code: "conflict", details: { ruleIds: [rule!.id] } });
    await run((tx) => offers.deleteOffer(tx, ctx, b.student.id, b.student.version));
    expect((await run((tx) => offers.listOffers(tx, b.event.id))).map((o) => o.code)).toEqual(["voksen"]);
  });

  it("are copied from another event, skipping codes the event has", async () => {
    const a = await concert("konsert-g", [FRI_EVENING]);
    const target = await run((tx) => catalog.createEvent(tx, ctx, { translations: title("Ny konsert"), admissionMode: "tickets" }));
    const occ = await run((tx) => catalog.createOccurrence(tx, ctx, target.id, { startUtc: SAT_EVENING }));
    await run((tx) => offers.createOffer(tx, ctx, target.id, { code: "student", translations: name("Student"), vatClassId: exempt.id, defaultPrice: 20000 }));
    const copied = await run((tx) => offers.copyOffers(tx, ctx, target.id, a.event.id));
    expect(copied.created.map((o) => [o.code, o.defaultPrice, o.translations.nb!.name])).toEqual([["voksen", 45000, "Voksen"]]);
    expect(copied.skipped).toEqual(["student"]);
    const grid = await run((tx) => offers.priceGrid(tx, target.id, { limit: 10 }));
    expect(grid.rows[0]!.occurrenceId).toBe(occ.id);
    expect(grid.rows[0]!.cells.map((c) => c.price.value).sort()).toEqual([20000, 45000]);
  });

  it("resolve for new occurrences, and archived offers leave the public API", async () => {
    const { event, adult } = await concert("konsert-h", [FRI_EVENING]);
    const later = await run((tx) => catalog.createOccurrence(tx, ctx, event.id, { startUtc: SAT_MATINEE }));
    expect(cell(await run((tx) => offers.priceGrid(tx, event.id, { limit: 10 })), later.id, adult.id).price.value).toBe(45000);
    await run((tx) => offers.updateOffer(tx, ctx, adult.id, adult.version, { status: "archived" }));
    await run(async (tx) => catalog.transitionEvent(tx, ctx, event.id, (await catalog.getEvent(tx, event.id)).version, "publish"));
    const pub = await run((tx) => catalog.listPublicOccurrences(tx, { preview: false, now: new Date("2027-01-01T00:00:00Z") }, { event: event.id, from: new Date("2027-01-01T00:00:00Z"), limit: 10 }));
    expect(pub.items.map((o) => o.offers.map((x) => x.code))).toEqual([["student"], ["student"]]);
    // Past occurrences list their offers, but not on sale.
    const after = await run((tx) => catalog.listPublicOccurrences(tx, { preview: false, now: new Date("2027-02-13T00:00:00Z") }, { event: event.id, from: new Date("2027-01-01T00:00:00Z"), limit: 10 }));
    expect(after.items.map((o) => o.offers[0]!.onSale)).toEqual([false, true]);
  });
});

describe("overrides on series occurrences", () => {
  it("detach the occurrence, so regeneration keeps it and its price, and reattaching clears them", async () => {
    const now = new Date("2027-01-01T00:00:00Z");
    const event = await run((tx) => catalog.createEvent(tx, ctx, { translations: title("Serie"), admissionMode: "tickets" }));
    const created = await run((tx) => catalog.createSeries(tx, ctx, event.id, { rrule: "FREQ=DAILY;COUNT=3", dtstartLocal: "2027-03-01T19:00" }, { now }));
    const adult = (await run((tx) => offers.createOffer(tx, ctx, event.id, { translations: name("Voksen"), vatClassId: exempt.id, defaultPrice: 45000 }))).offer!;
    const occs = await run((tx) => catalog.listOccurrences(tx, { eventId: event.id, limit: 10 }));
    const third = occs[2]!;
    expect(third.detached).toBe(false);

    await run((tx) => offers.setOverride(tx, ctx, adult.id, third.id, { amount: 40000 }));
    const priced = await run((tx) => catalog.getOccurrence(tx, third.id));
    expect(priced).toMatchObject({ detached: true, version: third.version + 1 });

    // Shortening the series to two occurrences reports a conflict instead of deleting the third.
    const shortened = await run((tx) => catalog.updateSeries(tx, ctx, created.series!.id, created.series!.version, { rrule: "FREQ=DAILY;COUNT=2" }, { now }));
    expect(shortened.changes.counts).toMatchObject({ deleted: 0, conflicts: 1 });
    expect(cell(await run((tx) => offers.priceGrid(tx, event.id, { limit: 10 })), third.id, adult.id).price).toMatchObject({ value: 40000, source: "override" });

    // Another occurrence: reattaching removes its offer overrides with the rest.
    const second = occs[1]!;
    await run((tx) => offers.setOverride(tx, ctx, adult.id, second.id, { available: false }));
    const detached = await run((tx) => catalog.getOccurrence(tx, second.id));
    // Clearing them takes offers.write, as setOverride does: an editor cannot reattach it.
    await expect(run((tx) => catalog.reattachOccurrence(tx, editor, second.id, detached.version), editor)).rejects.toMatchObject({ code: "forbidden" });
    const reattached = await run((tx) => catalog.reattachOccurrence(tx, ctx, second.id, detached.version));
    expect(reattached.detached).toBe(false);
    expect(cell(await run((tx) => offers.priceGrid(tx, event.id, { limit: 10 })), second.id, adult.id)).toMatchObject({
      available: { value: true, source: "default" }, override: null,
    });

    // Without offer overrides, editors reattach as before.
    const first = occs[0]!;
    const moved = await run((tx) => catalog.updateOccurrence(tx, editor, first.id, first.version, { startUtc: new Date("2027-03-01T19:00:00Z") }), editor);
    expect(moved.detached).toBe(true);
    expect((await run((tx) => catalog.reattachOccurrence(tx, editor, first.id, moved.version), editor)).detached).toBe(false);
  });
});

describe("VAT classes", () => {
  it("keep their rate once an offer uses them", async () => {
    const reduced = await run((tx) => offers.createVatClass(tx, ctx, { code: "reduced", label: "Redusert", ratePct: 12 }));
    const changed = await run((tx) => offers.updateVatClass(tx, ctx, reduced.id, reduced.version, { ratePct: 12.5 }));
    expect(changed).toMatchObject({ ratePct: 12.5, inUse: false });
    await expect(run((tx) => offers.createVatClass(tx, ctx, { code: "reduced", label: "Igjen", ratePct: 15 }))).rejects.toMatchObject({ code: "conflict" });
    await expect(run((tx) => offers.createVatClass(tx, editor, { code: "x", label: "X", ratePct: 1 }), editor)).rejects.toMatchObject({ code: "forbidden" });

    await concert("konsert-i", []);
    const used = (await run((tx) => offers.listVatClasses(tx))).find((v) => v.id === exempt.id)!;
    expect(used.inUse).toBe(true);
    await expect(run((tx) => offers.updateVatClass(tx, ctx, exempt.id, used.version, { ratePct: 25 }))).rejects.toMatchObject({ code: "conflict" });
    const renamed = await run((tx) => offers.updateVatClass(tx, ctx, exempt.id, used.version, { label: "Unntatt", ratePct: 0 }));
    expect(renamed).toMatchObject({ label: "Unntatt", ratePct: 0 });

    // An archived class cannot be given to an offer.
    const archived = await run((tx) => offers.updateVatClass(tx, ctx, changed.id, changed.version, { archived: true }));
    expect(archived.archived).toBe(true);
    const e = await run((tx) => catalog.createEvent(tx, ctx, { translations: title("Arkiv"), admissionMode: "tickets" }));
    await expect(run((tx) => offers.createOffer(tx, ctx, e.id, { translations: name("Voksen"), vatClassId: changed.id, defaultPrice: 1 })))
      .rejects.toMatchObject({ code: "validation_failed", details: { field: "vatClassId" } });
  });
});
