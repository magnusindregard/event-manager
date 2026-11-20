import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, type Tx, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { type ActorContext, catalog, offers, tenancy } from "@event-manager/domain";
import { createChannelCatalogClient, createChannelClient, type Reservation, verifyReservation } from "@event-manager/sdk/connector";
import { createPublicClient } from "@event-manager/sdk";
import { buildApp } from "../../../apps/api/src/app.js";
import { devVerifier } from "../../../apps/api/src/auth.js";
import { buildPublicApp } from "../../../apps/public-api/src/app.js";
import coreSpec from "../../sdk/openapi/core.json" with { type: "json" };
import publicSpec from "../../sdk/openapi/public.json" with { type: "json" };
import { contract, type Spec } from "./openapi.js";

// Ticketing milestone 5: the purchase stages of docs/integration-guide.md, run the way a web
// shop's and a POS's connectors run them, through the SDK's connector client. Every request and
// response is checked against the OpenAPI documents the SDK is generated from, so a route that
// drifts from its spec fails here. This is the dry-run pilot until a client sells through it.

const CORE = "https://api.test";
const PUBLIC = "https://public.test";

let tdb: TestDatabase;
let db: Db;
let core: Awaited<ReturnType<typeof buildApp>>;
let pub: Awaited<ReturnType<typeof buildPublicApp>>;
const coreContract = contract(coreSpec as unknown as Spec);
const publicContract = contract(publicSpec as unknown as Spec);

interface Shop {
  ctx: ActorContext;
  webKey: string;
  posKey: string;
  publishableKey: string;
  eventId: string;
  occurrenceId: string;
  adult: string;
  child: string;
  family: string;
  member: string;
}
let shop: Shop;
let other: Shop;

const START = new Date(Date.now() + 30 * 86_400_000);
START.setUTCHours(18, 0, 0, 0);

async function setupShop(slug: string): Promise<Shop> {
  const account = await tenancy.createAccount(db, { slug, name: slug, ownerEmail: `owner@${slug}.test`, locales: ["nb", "en"] });
  const userId = await tenancy.login(db, { issuer: "https://idp.test", subject: `owner@${slug}.test`, email: `owner@${slug}.test`, name: null });
  const ctx: ActorContext = { tenantId: account.id, userId, clientId: null, roles: ["owner"] };
  return withTenant(db, ctx, async (tx: Tx) => {
    const vat = await offers.createVatClass(tx, ctx, { code: "exempt", label: "Fritatt", ratePct: 0 });
    const web = await offers.createChannel(tx, ctx, { code: "web", name: "Nettbutikk", kind: "ecom" });
    const pos = await offers.createChannel(tx, ctx, { code: "pos", name: "Kasse", kind: "pos" });
    await offers.setSkuMapping(tx, ctx, vat.id, web.id, "TICKET-VAT0");
    await offers.setSkuMapping(tx, ctx, vat.id, pos.id, "POS-TICKET-VAT0");
    const member = await catalog.createUserGroup(tx, ctx, { code: "member", names: { nb: "Medlem", en: "Member" } });
    const venue = await catalog.createLocation(tx, ctx, { kind: "venue", name: "Hovedscenen" });
    const event = await catalog.createEvent(tx, ctx, {
      slug: "hamlet", translations: { nb: { title: "Hamlet" }, en: { title: "Hamlet" } }, admissionMode: "tickets",
      registration: { capacity: 12 }, defaultLocationId: venue.id,
    });
    const occ = await catalog.createOccurrence(tx, ctx, event.id, { startUtc: START });
    const offer = async (code: string, nb: string, defaultPrice: number, extra: Record<string, unknown> = {}) =>
      (await offers.createOffer(tx, ctx, event.id, { code, translations: { nb: { name: nb } }, vatClassId: vat.id, defaultPrice, ...extra })).offer!.id;
    const ids = {
      adult: await offer("adult", "Voksen", 45000, { groupPrices: [{ groupId: member.id, amount: 35000 }] }),
      child: await offer("child", "Barn", 20000),
      family: await offer("family", "Familie", 120000, { placesPerUnit: 4, maxPerReservation: 2 }),
      member: await offer("member", "Medlemsbillett", 30000, { accessGroupIds: [member.id] }),
    };
    await catalog.transitionEvent(tx, ctx, event.id, (await catalog.getEvent(tx, event.id)).version, "publish");
    return {
      ctx, eventId: event.id, occurrenceId: occ.id, ...ids,
      webKey: (await offers.createChannelKey(tx, ctx, web.id, "Web shop")).secret,
      posKey: (await offers.createChannelKey(tx, ctx, pos.id, "POS")).secret,
      publishableKey: (await tenancy.createApiKey(tx, ctx, "publishable", "web")).secret,
    };
  });
}

const channel = (key: string, strict = true) =>
  createChannelClient({ baseUrl: CORE, channelKey: key, fetch: coreContract.contractFetch(core, { strict }) });
const catalogFor = (key: string) => createChannelCatalogClient({ baseUrl: PUBLIC, channelKey: key, fetch: publicContract.contractFetch(pub) });
const idem = () => crypto.randomUUID();

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  core = await buildApp({ db, verifier: devVerifier("contract-secret"), attendeeUrl: "https://tickets.test/" });
  pub = await buildPublicApp({ db, rateLimit: { capacity: 10_000, refillPerSecond: 10_000 } });
  shop = await setupShop("contract-a");
  other = await setupShop("contract-b");
});
afterAll(async () => {
  await core?.close();
  await pub?.close();
  await db?.destroy();
  await tdb?.stop();
});

describe("web shop", () => {
  it("1. browse: the shop's pages read offers and prices with the publishable key", async () => {
    const client = createPublicClient({ baseUrl: PUBLIC, publishableKey: shop.publishableKey });
    const { data, error } = await client.GET("/public/v1/occurrences", {
      params: { query: { event: "hamlet", limit: 50 } }, fetch: publicContract.contractFetch(pub),
    });
    expect(error).toBeUndefined();
    const occ = data!.items[0]!;
    expect(occ.id).toBe(shop.occurrenceId);
    expect(occ.offers.map((o) => [o.code, o.price.amount])).toEqual([["adult", 45000], ["child", 20000], ["family", 120000], ["member", 30000]]);
    expect(occ.availability).toMatchObject({ status: "available" });

    // A signed-in member sees the member prices and the member-only offer.
    const members = await client.GET("/public/v1/occurrences", {
      params: { query: { event: "hamlet", group: "member", limit: 50 } }, fetch: publicContract.contractFetch(pub),
    });
    expect(members.data!.items[0]!.offers.find((o) => o.code === "adult")!.price.amount).toBe(35000);
  });

  it("2. the connector reads its channel's offers with SKUs, limits and exact places left", async () => {
    const { data } = await catalogFor(shop.webKey).GET("/public/v1/occurrences", { params: { query: { event: "hamlet", limit: 50 } } });
    const occ = data!.items[0]!;
    expect(occ.availability).toMatchObject({ status: "available", placesLeft: 12 });
    expect(occ.offers.find((o) => o.code === "family")).toMatchObject({ sku: "TICKET-VAT0", placesPerUnit: 4, maxPerReservation: 2 });
  });

  let held: Reservation;

  it("3. cart: reserve holds the places and freezes prices, SKUs and line names", async () => {
    const { data, response } = await channel(shop.webKey).POST("/v1/reservations", {
      params: { header: { "idempotency-key": "cart-42-reserve" } },
      body: { externalRef: "cart-42", locale: "en", lines: [{ occurrenceId: shop.occurrenceId, offerId: shop.adult, quantity: 2 }, { occurrenceId: shop.occurrenceId, offerId: shop.child, quantity: 1 }] },
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    held = data!;
    expect(held).toMatchObject({ status: "held", externalRef: "cart-42", total: { amount: 110000, currency: "NOK" }, tickets: [] });
    expect(held.lines.map((l) => [l.offerCode, l.quantity, l.unitPrice, l.externalSku])).toEqual([["adult", 2, 45000, "TICKET-VAT0"], ["child", 1, 20000, "TICKET-VAT0"]]);
    expect(held.lines[0]!.name).toMatch(/^Voksen – Hamlet, .+, Hovedscenen$/);
    expect(new Date(held.expiresAt).getTime() - Date.now()).toBeGreaterThan(14 * 60_000);

    // A lost response: the same key returns the same reservation, not a second hold.
    const retry = await channel(shop.webKey).POST("/v1/reservations", {
      params: { header: { "idempotency-key": "cart-42-reserve" } },
      body: { externalRef: "cart-42", locale: "en", lines: [{ occurrenceId: shop.occurrenceId, offerId: shop.adult, quantity: 2 }, { occurrenceId: shop.occurrenceId, offerId: shop.child, quantity: 1 }] },
    });
    expect(retry.data!.id).toBe(held.id);
  });

  it("4. signatures: a snapshot that came back through the browser can be checked with the channel key", async () => {
    expect(await verifyReservation(held, shop.webKey)).toBe(true);
    const tampered = { ...held, lines: held.lines.map((l, i) => (i === 0 ? { ...l, unitPrice: 100 } : l)) };
    expect(await verifyReservation(tampered, shop.webKey)).toBe(false);
    expect(await verifyReservation({ ...held, total: { ...held.total, amount: 1 } }, shop.webKey)).toBe(false);
    expect(await verifyReservation(held, shop.posKey)).toBe(false);
  });

  it("5. checkout: extend before payment starts, then read the reservation server-side before charging", async () => {
    const ext = await channel(shop.webKey).POST("/v1/reservations/{id}/extend", {
      params: { path: { id: held.id }, header: { "idempotency-key": "cart-42-extend" } }, body: { minutes: 30 },
    });
    expect(new Date(ext.data!.expiresAt).getTime()).toBeGreaterThan(new Date(held.expiresAt).getTime());
    expect(new Date(ext.data!.expiresAt).getTime()).toBeLessThanOrEqual(new Date(ext.data!.extendLimitAt).getTime());

    const { data } = await channel(shop.webKey).GET("/v1/reservations/{id}", { params: { path: { id: held.id } } });
    expect(data).toMatchObject({ id: held.id, status: "held", total: { amount: 110000 } });
    expect(await verifyReservation(data!, shop.webKey)).toBe(true);
  });

  let confirmed: Reservation;

  it("6. order: confirm after charging issues one ticket per unit, and a retry returns the same tickets", async () => {
    const confirm = () => channel(shop.webKey).POST("/v1/reservations/{id}/confirm", {
      params: { path: { id: held.id }, header: { "idempotency-key": "order-1042-confirm" } },
      body: { externalOrderRef: "ORDER-1042", buyer: { name: "Kari Nordmann", email: "kari@example.com", locale: "en" } },
    });
    const { data } = await confirm();
    confirmed = data!;
    expect(confirmed).toMatchObject({ status: "confirmed", externalOrderRef: "ORDER-1042", buyer: { name: "Kari Nordmann" } });
    expect(confirmed.tickets).toHaveLength(3);
    for (const t of confirmed.tickets) {
      expect(t).toMatchObject({ status: "valid", partySize: 1 });
      expect(t.url).toMatch(/^https:\/\/tickets\.test\/t\//);
      expect(t.qr).toBeTruthy();
    }
    expect((await confirm()).data!.tickets.map((t) => t.id)).toEqual(confirmed.tickets.map((t) => t.id));

    const { data: page } = await catalogFor(shop.webKey).GET("/public/v1/occurrences", { params: { query: { event: "hamlet", limit: 50 } } });
    expect(page!.items[0]!.availability).toMatchObject({ placesLeft: 9 });
  });

  it("7. refund: cancel one ticket with the refund reference, then the rest; the places go back on sale", async () => {
    const one = await channel(shop.webKey).POST("/v1/reservations/{id}/cancel", {
      params: { path: { id: confirmed.id }, header: { "idempotency-key": "refund-1" } },
      body: { ticketIds: [confirmed.tickets[2]!.id], externalRefundRef: "REFUND-1" },
    });
    expect(one.data).toMatchObject({ status: "confirmed" });
    expect(one.data!.tickets[2]).toMatchObject({ status: "cancelled", cancelledBy: "channel", externalRefundRef: "REFUND-1", url: null, qr: null });

    const again = await channel(shop.webKey).POST("/v1/reservations/{id}/cancel", {
      params: { path: { id: confirmed.id }, header: { "idempotency-key": "refund-1-again" } },
      body: { ticketIds: [confirmed.tickets[2]!.id] },
    });
    expect(again.error).toMatchObject({ status: 409, code: "already_cancelled" });

    const rest = await channel(shop.webKey).POST("/v1/reservations/{id}/cancel", {
      params: { path: { id: confirmed.id }, header: { "idempotency-key": "refund-2" } }, body: { externalRefundRef: "REFUND-2" },
    });
    expect(rest.data).toMatchObject({ status: "cancelled" });
    const { data: page } = await catalogFor(shop.webKey).GET("/public/v1/occurrences", { params: { query: { event: "hamlet", limit: 50 } } });
    expect(page!.items[0]!.availability).toMatchObject({ placesLeft: 12 });
  });

  it("8. abandoned cart: cancelling a held reservation releases its places", async () => {
    const r = await channel(shop.webKey).POST("/v1/reservations", {
      params: { header: { "idempotency-key": idem() } }, body: { lines: [{ occurrenceId: shop.occurrenceId, offerId: shop.family, quantity: 2 }] },
    });
    expect(r.data!.lines[0]).toMatchObject({ quantity: 2, placesPerUnit: 4 });
    const c = await channel(shop.webKey).POST("/v1/reservations/{id}/cancel", { params: { path: { id: r.data!.id }, header: { "idempotency-key": idem() } } });
    expect(c.data).toMatchObject({ status: "cancelled", tickets: [] });
  });

  it("9. user groups: the connector asserts the buyer's group, which sets the price and is signed", async () => {
    const reserve = (group?: string) => channel(shop.webKey).POST("/v1/reservations", {
      params: { header: { "idempotency-key": idem() } },
      body: { ...(group ? { group } : {}), lines: [{ occurrenceId: shop.occurrenceId, offerId: shop.adult, quantity: 1 }, { occurrenceId: shop.occurrenceId, offerId: shop.member, quantity: 1 }] },
    });
    expect((await reserve()).error).toMatchObject({ status: 403, code: "group_required", details: { line: 1, groups: ["member"] } });
    expect((await reserve("sponsor")).error).toMatchObject({ code: "unknown_group" });
    const { data } = await reserve("member");
    expect(data).toMatchObject({ group: "member", total: { amount: 65000 } });
    expect(data!.lines.map((l) => [l.offerCode, l.unitPrice, l.group])).toEqual([["adult", 35000, "member"], ["member", 30000, "member"]]);
    expect(await verifyReservation(data!, shop.webKey)).toBe(true);
    expect(await verifyReservation({ ...data!, group: null }, shop.webKey)).toBe(false);
    await channel(shop.webKey).POST("/v1/reservations/{id}/cancel", { params: { path: { id: data!.id }, header: { "idempotency-key": idem() } } });
  });
});

describe("POS", () => {
  it("sells a walk-up in one call with confirm: true, under its own SKU", async () => {
    const { data, response } = await channel(shop.posKey).POST("/v1/reservations", {
      params: { header: { "idempotency-key": "pos-7-receipt-311" } },
      body: { confirm: true, externalOrderRef: "POS-7-311", lines: [{ occurrenceId: shop.occurrenceId, offerId: shop.family, quantity: 1 }] },
    });
    expect(response.status).toBe(201);
    expect(data).toMatchObject({ status: "confirmed", externalOrderRef: "POS-7-311", buyer: null });
    expect(data!.lines[0]).toMatchObject({ externalSku: "POS-TICKET-VAT0", placesPerUnit: 4 });
    expect(data!.tickets).toEqual([expect.objectContaining({ status: "valid", partySize: 4 })]);
  });

  it("sees only its own channel's reservations", async () => {
    const r = await channel(shop.webKey).POST("/v1/reservations", {
      params: { header: { "idempotency-key": idem() } }, body: { lines: [{ occurrenceId: shop.occurrenceId, offerId: shop.child, quantity: 1 }] },
    });
    expect((await channel(shop.posKey).GET("/v1/reservations/{id}", { params: { path: { id: r.data!.id } } })).error).toMatchObject({ status: 404 });
    await channel(shop.webKey).POST("/v1/reservations/{id}/cancel", { params: { path: { id: r.data!.id }, header: { "idempotency-key": idem() } } });
  });
});

describe("problems", () => {
  it("answer with problem details, stable reasons and the details the guide lists", async () => {
    const reserve = (lines: { offerId: string; quantity: number }[], key = shop.webKey) => channel(key).POST("/v1/reservations", {
      params: { header: { "idempotency-key": idem() } }, body: { lines: lines.map((l) => ({ occurrenceId: shop.occurrenceId, ...l })) },
    });
    const sold = await reserve([{ offerId: shop.adult, quantity: 13 }]);
    expect(sold.response.headers.get("content-type")).toContain("application/problem+json");
    expect(sold.error).toMatchObject({ status: 409, code: "sold_out", details: { lines: [0], occurrenceId: shop.occurrenceId, placesLeft: 8, places: 13 } });
    expect((await reserve([{ offerId: shop.family, quantity: 3 }])).error).toMatchObject({ status: 422, code: "quantity_out_of_range", details: { line: 0, max: 2 } });
    expect((await reserve([{ offerId: other.adult, quantity: 1 }])).error).toMatchObject({ status: 404 });

    const nope = await channel(shop.webKey).GET("/v1/reservations/{id}", { params: { path: { id: crypto.randomUUID() } } });
    expect(nope.error).toMatchObject({ status: 404 });
    const otherTenant = await channel(other.webKey).POST("/v1/reservations", {
      params: { header: { "idempotency-key": idem() } }, body: { lines: [{ occurrenceId: other.occurrenceId, offerId: other.child, quantity: 1 }] },
    });
    expect((await channel(shop.webKey).GET("/v1/reservations/{id}", { params: { path: { id: otherTenant.data!.id } } })).error).toMatchObject({ status: 404 });
  });

  it("refuse a write without an Idempotency-Key (428) and an unknown key (401)", async () => {
    // Sent on purpose against the spec, so only the response is checked.
    const loose = channel(shop.webKey, false);
    const missing = await loose.POST("/v1/reservations", {
      params: { header: {} as { "idempotency-key": string } }, body: { lines: [{ occurrenceId: shop.occurrenceId, offerId: shop.adult, quantity: 1 }] },
    });
    expect(missing.error).toMatchObject({ status: 428, code: "idempotency_key_required" });
    const forged = `${shop.webKey.slice(0, -1)}${shop.webKey.endsWith("x") ? "y" : "x"}`;
    expect((await channel(forged).GET("/v1/reservations/{id}", { params: { path: { id: crypto.randomUUID() } } })).error).toMatchObject({ status: 401, code: "unauthenticated" });
  });
});

describe("coverage", () => {
  it("exercised every connector operation, with each status checked against the spec", () => {
    const seen = new Set(coreContract.exchanges.map((e) => e.operationId));
    for (const op of ["createReservation", "getReservation", "extendReservation", "confirmReservation", "cancelReservation"]) expect(seen).toContain(op);
    expect(new Set(publicContract.exchanges.map((e) => e.operationId))).toContain("listOccurrences");
    expect(new Set(coreContract.exchanges.map((e) => e.status))).toEqual(new Set([200, 201, 401, 403, 404, 409, 422, 428]));
  });
});
