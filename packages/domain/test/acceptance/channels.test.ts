import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, sql, type Tx, withTenant } from "@event-manager/db";
import { migrations, startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { type ActorContext, catalog, inventory, offers, tenancy } from "../../src/index.js";

// Ticketing milestone 2 (docs/ticketing.md): sales channels, channel keys, the SKU mapping,
// channels per offer, sales windows, and what channel callers see in the public read model.

let tdb: TestDatabase;
let db: Db;
let ctx: ActorContext;
let manager: ActorContext;
let exempt: offers.VatClass;
let standard: offers.VatClass;

const run = <T>(fn: (tx: Tx) => Promise<T>, as: ActorContext = ctx) => withTenant(db, as, fn);
const title = (t: string) => ({ nb: { title: t } });
const name = (n: string) => ({ nb: { name: n } });
const MIN = 60_000;

// Sat 13 February 2027, 19:30 in Oslo.
const START = new Date("2027-02-13T18:30:00Z");
const BEFORE = (min: number) => new Date(START.getTime() - min * MIN);

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  const account = await tenancy.createAccount(db, { slug: "channels", name: "Channels", ownerEmail: "owner@channels.test" });
  const userId = await tenancy.login(db, { issuer: "https://idp.test", subject: "owner@channels.test", email: "owner@channels.test", name: null });
  ctx = { tenantId: account.id, userId, clientId: null, roles: ["owner"] };
  manager = { ...ctx, roles: ["event_manager"] };
  exempt = await run((tx) => offers.createVatClass(tx, ctx, { code: "exempt", label: "Fritatt", ratePct: 0 }));
  standard = await run((tx) => offers.createVatClass(tx, ctx, { code: "standard", label: "Standard", ratePct: 25 }));
});
afterAll(async () => {
  await db?.destroy();
  await tdb?.stop();
});

async function ticketedEvent(slug: string, capacity = 100) {
  const event = await run((tx) => catalog.createEvent(tx, ctx, { slug, translations: title("Hamlet"), admissionMode: "tickets", registration: { capacity } }));
  const occ = await run((tx) => catalog.createOccurrence(tx, ctx, event.id, { startUtc: START }));
  return { event, occ };
}

const publish = (eventId: string) => run(async (tx) => catalog.transitionEvent(tx, ctx, eventId, (await catalog.getEvent(tx, eventId)).version, "publish"));

const publicOcc = (eventId: string, now: Date, channelId?: string) =>
  run(async (tx) => (await catalog.listPublicOccurrences(tx, { preview: false, now, channelId }, { event: eventId, from: new Date("2027-01-01T00:00:00Z"), limit: 10 })).items[0]!);

describe("sales channels", () => {
  it("are set up by the owner only, with unique codes and a hold time of at most 60 minutes", async () => {
    await expect(run((tx) => offers.createChannel(tx, manager, { code: "x", name: "X", kind: "ecom" }), manager)).rejects.toMatchObject({ code: "forbidden" });
    const web = await run((tx) => offers.createChannel(tx, ctx, { code: "web-a", name: "Nettbutikk", kind: "ecom" }));
    expect(web).toMatchObject({ code: "web-a", kind: "ecom", holdMinutes: 15, sendTickets: false, active: true, version: 1 });
    await expect(run((tx) => offers.createChannel(tx, ctx, { code: "web-a", name: "Igjen", kind: "ecom" }))).rejects.toMatchObject({ code: "conflict" });
    await expect(run((tx) => offers.updateChannel(tx, ctx, web.id, 1, { holdMinutes: 61 }))).rejects.toMatchObject({ code: "validation_failed" });
    const updated = await run((tx) => offers.updateChannel(tx, ctx, web.id, 1, { holdMinutes: 20, sendTickets: true }));
    expect(updated).toMatchObject({ holdMinutes: 20, sendTickets: true, version: 2 });
    await expect(run((tx) => offers.updateChannel(tx, ctx, web.id, 1, { name: "Gammel" }))).rejects.toMatchObject({ code: "version_conflict" });
    // Members read channels, like VAT classes.
    expect((await run((tx) => offers.listChannels(tx), manager)).map((c) => c.code)).toContain("web-a");
  });

  it("have keys that resolve to their channel, stop at revocation and are listed apart from public keys", async () => {
    const pos = await run((tx) => offers.createChannel(tx, ctx, { code: "pos-a", name: "Billettluke", kind: "pos" }));
    const key = await run((tx) => offers.createChannelKey(tx, ctx, pos.id, "Kasse 1"));
    expect(key.secret).toMatch(/^sk_[A-Za-z0-9]{12}_[A-Za-z0-9_-]{43}$/);
    expect(await tenancy.verifyApiKey(db, key.secret, "channel")).toEqual({ tenantId: ctx.tenantId, kind: "channel", channelId: pos.id });
    // A channel key is not a preview token, and the other way round.
    expect(await tenancy.verifyApiKey(db, key.secret, "preview")).toBeNull();
    const preview = await run((tx) => tenancy.createApiKey(tx, ctx, "preview", "cms"));
    expect(await tenancy.verifyApiKey(db, preview.secret, "channel")).toBeNull();
    await expect(run((tx) => tenancy.createApiKey(tx, ctx, "channel", "uten kanal"))).rejects.toMatchObject({ code: "validation_failed" });

    expect((await run((tx) => offers.listChannelKeys(tx, ctx, pos.id))).map((k) => k.id)).toEqual([key.id]);
    expect((await run((tx) => tenancy.listApiKeys(tx, ctx))).map((k) => k.kind)).not.toContain("channel");
    await expect(run((tx) => offers.listChannelKeys(tx, manager, pos.id), manager)).rejects.toMatchObject({ code: "forbidden" });

    // Revoking through another channel does not touch it.
    const web = (await run((tx) => offers.listChannels(tx))).find((c) => c.code === "web-a")!;
    await expect(run((tx) => offers.revokeChannelKey(tx, ctx, web.id, key.id))).rejects.toMatchObject({ code: "not_found" });
    await run((tx) => offers.revokeChannelKey(tx, ctx, pos.id, key.id));
    expect(await tenancy.verifyApiKey(db, key.secret, "channel")).toBeNull();

    // Inactive channels get no new keys, and their channel no longer acts.
    await run((tx) => offers.updateChannel(tx, ctx, pos.id, pos.version, { active: false }));
    await expect(run((tx) => offers.createChannelKey(tx, ctx, pos.id, "Kasse 2"))).rejects.toMatchObject({ code: "conflict" });
    expect(await run((tx) => offers.activeChannel(tx, pos.id))).toBeNull();
  });
});

describe("SKU mapping and channels per offer", () => {
  it("defaults new offers to every active channel, and reports channels where the VAT class has no SKU", async () => {
    const shop = await run((tx) => offers.createChannel(tx, ctx, { code: "shop-b", name: "Butikk", kind: "ecom" }));
    const box = await run((tx) => offers.createChannel(tx, ctx, { code: "box-b", name: "Luke", kind: "pos" }));
    const inactive = (await run((tx) => offers.listChannels(tx))).find((c) => !c.active)!;
    await run((tx) => offers.setSkuMapping(tx, ctx, exempt.id, shop.id, "TICKET-VAT0"));
    await expect(run((tx) => offers.setSkuMapping(tx, manager, exempt.id, box.id, "X"), manager)).rejects.toMatchObject({ code: "forbidden" });

    const { event } = await ticketedEvent("sku-defaults");
    const adult = (await run((tx) => offers.createOffer(tx, ctx, event.id, { translations: name("Voksen"), vatClassId: exempt.id, defaultPrice: 45000 }))).offer!;
    expect(adult.channelIds).toEqual(expect.arrayContaining([shop.id, box.id]));
    expect(adult.channelIds).not.toContain(inactive.id);
    expect(adult.channelsWithoutSku).toContain(box.id);
    expect(adult.channelsWithoutSku).not.toContain(shop.id);

    const sku = await run((tx) => offers.setSkuMapping(tx, ctx, exempt.id, box.id, " LUKE-VAT0 "));
    expect(sku).toMatchObject({ vatClassId: exempt.id, channelId: box.id, externalSku: "LUKE-VAT0" });
    expect((await run((tx) => offers.getOffer(tx, adult.id))).channelsWithoutSku).not.toContain(box.id);
    expect(await run((tx) => offers.setSkuMapping(tx, ctx, exempt.id, box.id, null))).toBeNull();
    expect((await run((tx) => offers.getOffer(tx, adult.id))).channelsWithoutSku).toContain(box.id);

    // Explicit channels replace the default; unknown and inactive ones are refused.
    const student = (await run((tx) => offers.createOffer(tx, ctx, event.id, { translations: name("Student"), vatClassId: standard.id, defaultPrice: 25000, channelIds: [shop.id] }))).offer!;
    expect(student).toMatchObject({ channelIds: [shop.id], channelsWithoutSku: [shop.id] });
    await expect(run((tx) => offers.updateOffer(tx, ctx, student.id, student.version, { channelIds: [inactive.id] }))).rejects.toMatchObject({ code: "validation_failed" });
    await expect(run((tx) => offers.updateOffer(tx, ctx, student.id, student.version, { channelIds: [crypto.randomUUID()] }))).rejects.toMatchObject({ code: "validation_failed" });
    const none = await run((tx) => offers.updateOffer(tx, ctx, student.id, student.version, { channelIds: [] }));
    expect(none.offer).toMatchObject({ channelIds: [], channelsWithoutSku: [] });
    expect(none.resolution).toBe("none");
  });

  it("copies channels and sales windows with the offers", async () => {
    const { event: from } = await ticketedEvent("copy-from");
    const shop = (await run((tx) => offers.listChannels(tx))).find((c) => c.code === "shop-b")!;
    await run((tx) => offers.createOffer(tx, ctx, from.id, { translations: name("Voksen"), vatClassId: exempt.id, defaultPrice: 45000, channelIds: [shop.id], onSaleMinBefore: 10080, offSaleMinBefore: 30 }));
    const { event: to } = await ticketedEvent("copy-to");
    const copied = await run((tx) => offers.copyOffers(tx, ctx, to.id, from.id));
    expect(copied.created[0]).toMatchObject({ channelIds: [shop.id], onSaleMinBefore: 10080, offSaleMinBefore: 30, onSaleAt: null, offSaleAt: null });
  });
});

describe("sales windows", () => {
  it("are validated, and setting one form of a bound replaces the other", async () => {
    const { event } = await ticketedEvent("window-validate");
    const create = (w: offers.SalesWindowPatch) => run((tx) => offers.createOffer(tx, ctx, event.id, { translations: name("Voksen"), vatClassId: exempt.id, defaultPrice: 1, ...w }));
    await expect(create({ onSaleMinBefore: 60, onSaleAt: new Date("2027-01-01T00:00:00Z") })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(create({ onSaleMinBefore: 30, offSaleMinBefore: 60 })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(create({ onSaleAt: "2027-02-01T00:00:00Z", offSaleAt: "2027-01-01T00:00:00Z" })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(create({ offSaleMinBefore: -1 })).rejects.toMatchObject({ code: "validation_failed" });

    const o = (await create({ onSaleMinBefore: 10080 })).offer!;
    const absolute = (await run((tx) => offers.updateOffer(tx, ctx, o.id, o.version, { onSaleAt: "2027-01-15T09:00:00Z" }))).offer!;
    expect(absolute).toMatchObject({ onSaleMinBefore: null, onSaleAt: new Date("2027-01-15T09:00:00Z") });
    const cleared = (await run((tx) => offers.updateOffer(tx, ctx, o.id, absolute.version, { onSaleAt: null, offSaleMinBefore: 15 }))).offer!;
    expect(cleared).toMatchObject({ onSaleMinBefore: null, onSaleAt: null, offSaleMinBefore: 15, offSaleAt: null });
  });

  it("put offers on sale in the public API only inside the window, never past the start", () => {
    const w = offers.salesWindow(START, { onSaleMinBefore: 10080, onSaleAt: null, offSaleMinBefore: 30, offSaleAt: null });
    expect(w).toEqual({ opensAt: BEFORE(10080), closesAt: BEFORE(30) });
    expect(offers.windowOpen(w, BEFORE(10081))).toBe(false);
    expect(offers.windowOpen(w, BEFORE(10080))).toBe(true);
    expect(offers.windowOpen(w, BEFORE(30))).toBe(false);
    const late = offers.salesWindow(START, { onSaleMinBefore: null, onSaleAt: null, offSaleMinBefore: null, offSaleAt: new Date(START.getTime() + 60 * MIN) });
    expect(late).toEqual({ opensAt: null, closesAt: START });
  });

  it("show in the public offers with opensAt and closesAt", async () => {
    const { event } = await ticketedEvent("window-public");
    await run((tx) => offers.createOffer(tx, ctx, event.id, { translations: name("Voksen"), vatClassId: exempt.id, defaultPrice: 45000, onSaleMinBefore: 10080, offSaleMinBefore: 30 }));
    await run((tx) => offers.createOffer(tx, ctx, event.id, { translations: name("Honnør"), vatClassId: exempt.id, defaultPrice: 30000 }));
    await publish(event.id);

    const early = await publicOcc(event.id, BEFORE(20000));
    expect(early.offers.map((o) => [o.code, o.onSale])).toEqual([["voksen", false], ["honnor", true]]);
    expect(early.offers[0]).toMatchObject({ opensAt: BEFORE(10080).toISOString(), closesAt: BEFORE(30).toISOString() });
    expect(early.offers[1]).toMatchObject({ opensAt: null, closesAt: START.toISOString() });
    // Anonymous callers get no SKUs or limits, and availability without exact places (milestone 3).
    expect(early.offers[0]).not.toHaveProperty("sku");
    expect(early.availability).toEqual({ status: "available", opensAt: null, closesAt: START.toISOString() });

    expect((await publicOcc(event.id, BEFORE(60))).offers.map((o) => o.onSale)).toEqual([true, true]);
    expect((await publicOcc(event.id, BEFORE(10))).offers.map((o) => o.onSale)).toEqual([false, true]);
  });
});

describe("channel callers", () => {
  it("see only their channel's offers, with SKU and limits, and exact places left", async () => {
    const web = await run((tx) => offers.createChannel(tx, ctx, { code: "web-c", name: "Nett", kind: "ecom" }));
    const pos = await run((tx) => offers.createChannel(tx, ctx, { code: "pos-c", name: "Luke", kind: "pos" }));
    await run((tx) => offers.setSkuMapping(tx, ctx, exempt.id, web.id, "TICKET-VAT0"));
    const { event, occ } = await ticketedEvent("channel-view", 10);
    await run((tx) => offers.createOffer(tx, ctx, event.id, { translations: name("Voksen"), vatClassId: exempt.id, defaultPrice: 45000, channelIds: [web.id, pos.id], maxPerReservation: 8 }));
    await run((tx) => offers.createOffer(tx, ctx, event.id, { translations: name("Familie"), vatClassId: exempt.id, defaultPrice: 120000, channelIds: [web.id], placesPerUnit: 4 }));
    await run((tx) => offers.createOffer(tx, ctx, event.id, { translations: name("Gruppe"), vatClassId: standard.id, defaultPrice: 40000, channelIds: [pos.id] }));
    await publish(event.id);
    const now = BEFORE(60 * 24);

    const viaWeb = await publicOcc(event.id, now, web.id);
    expect(viaWeb.offers.map((o) => o.code)).toEqual(["voksen", "familie"]);
    expect(viaWeb.offers[0]).toMatchObject({ sku: "TICKET-VAT0", onSale: true, placesPerUnit: 1, minPerReservation: 1, maxPerReservation: 8 });
    expect(viaWeb.availability).toEqual({ status: "available", opensAt: null, closesAt: START.toISOString(), placesLeft: 10 });

    // No SKU in the POS for either VAT class: listed, but not on sale.
    const viaPos = await publicOcc(event.id, now, pos.id);
    expect(viaPos.offers.map((o) => [o.code, o.sku, o.onSale])).toEqual([["voksen", null, false], ["gruppe", null, false]]);
    expect(viaPos.availability).toMatchObject({ status: "not_on_sale", placesLeft: 10 });

    // Few left once a tenth of the places remain; sold out once no on-sale offer fits.
    const pool = (await run((tx) => inventory.getPool(tx, occ.id)))!;
    await run((tx) => tx.updateTable("inventory.capacity_pool").set({ taken: 7 }).where("id", "=", pool.id).execute());
    expect((await publicOcc(event.id, now, web.id)).availability).toMatchObject({ status: "available", placesLeft: 3 });
    await run((tx) => tx.updateTable("inventory.capacity_pool").set({ taken: 9 }).where("id", "=", pool.id).execute());
    expect((await publicOcc(event.id, now, web.id)).availability).toMatchObject({ status: "few_left", placesLeft: 1 });
    await run((tx) => tx.updateTable("inventory.capacity_pool").set({ taken: 10 }).where("id", "=", pool.id).execute());
    expect((await publicOcc(event.id, now, web.id)).availability).toMatchObject({ status: "sold_out", placesLeft: 0 });

    // After the start nothing is on sale.
    expect((await publicOcc(event.id, START, web.id)).availability).toMatchObject({ status: "not_on_sale" });
  });

  it("an offer whose smallest purchase no longer fits does not keep the occurrence on sale", () => {
    const base = { id: "x", code: "x", name: "x", description: null, price: { amount: 1, currency: "NOK", vatIncluded: true as const }, opensAt: null, closesAt: START.toISOString() };
    const family = { ...base, onSale: true, placesPerUnit: 4 };
    expect(catalog.ticketAvailability([family], { bookableLimit: 100, available: 3 }).status).toBe("sold_out");
    expect(catalog.ticketAvailability([family, { ...base, onSale: true, placesPerUnit: 1 }], { bookableLimit: 100, available: 3 }).status).toBe("few_left");
    expect(catalog.ticketAvailability([family], { bookableLimit: null, available: null })).toMatchObject({ status: "available", placesLeft: null });
    // Review on #80: four places a unit and at least two units need 8 places, so 7 is sold out.
    const pairs = { ...family, minPerReservation: 2 };
    expect(catalog.ticketAvailability([pairs], { bookableLimit: 100, available: 7 }).status).toBe("sold_out");
    expect(catalog.ticketAvailability([pairs], { bookableLimit: 100, available: 8 }).status).toBe("few_left");
  });
});

// Last: it rolls the schema back and forward again.
describe("migration 0017", () => {
  it("rolls back with channels, keys and windows in place, and forward again", async () => {
    const su = createDb(tdb.superuserUrl) as unknown as Parameters<(typeof migrations)[string]["up"]>[0];
    try {
      // Reservations (0018) build on channels: down in reverse order, up again in order.
      await migrations["0018_reservations"]!.down!(su);
      await migrations["0017_channels"]!.down!(su);
      const left = await sql<{ n: number }>`select count(*)::int as n from tenancy.api_key where kind::text = 'channel'`.execute(su);
      expect(left.rows).toEqual([{ n: 0 }]);
      await migrations["0017_channels"]!.up(su);
      await migrations["0018_reservations"]!.up(su);
    } finally {
      await su.destroy();
    }
    expect(await run((tx) => offers.listChannels(tx))).toEqual([]);
  });
});
