import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, type Tx, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { type ActorContext, catalog, offers, tenancy } from "@event-manager/domain";
import { buildApp } from "../src/app.js";
import { DEV_ISSUER, devVerifier } from "../src/auth.js";

// Ticketing milestone 4 over HTTP: the channel cancels confirmed tickets (a refund), staff
// read Occurrence → Sales and cancel tickets, and box office and finance are enabled roles.

const SECRET = "test-secret";
let tdb: TestDatabase;
let db: Db;
let app: Awaited<ReturnType<typeof buildApp>>;
let ctx: ActorContext;
let key: string;
let occurrenceId: string;
let adult: string;
let B: string;

const token = (email: string) =>
  new SignJWT({ email }).setProtectedHeader({ alg: "HS256" }).setIssuer(DEV_ISSUER).setSubject(email).setExpirationTime("5m").sign(new TextEncoder().encode(SECRET));

async function call(method: string, url: string, opts: { key?: string; as?: string; account?: string; idem?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  else {
    headers.authorization = `Bearer ${await token(opts.as ?? "owner@sale.test")}`;
    headers["account-id"] = opts.account ?? ctx.tenantId;
  }
  if (opts.idem) headers["idempotency-key"] = opts.idem;
  const res = await app.inject({ method: method as "GET", url, headers, ...(opts.body !== undefined ? { payload: opts.body as object } : {}) });
  return { status: res.statusCode, headers: res.headers, body: res.body ? res.json() : undefined };
}

const sell = (order: string, quantity: number, idem = order) =>
  call("POST", "/v1/reservations", { key, idem, body: { confirm: true, externalOrderRef: order, buyer: { name: "Kari", email: "kari@example.com" }, lines: [{ occurrenceId, offerId: adult, quantity }] } });

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  app = await buildApp({ db, verifier: devVerifier(SECRET), attendeeUrl: "https://tickets.test" });
  const account = await tenancy.createAccount(db, { slug: "sale", name: "Sale", ownerEmail: "owner@sale.test" });
  B = (await tenancy.createAccount(db, { slug: "sale-b", name: "B", ownerEmail: "owner@b.test" })).id;
  ctx = { tenantId: account.id, userId: "", clientId: null, roles: ["owner"] };
  await call("GET", "/v1/me");
  await call("GET", "/v1/me", { as: "owner@b.test", account: B });
  ctx.userId = (await withTenant(db, { tenantId: account.id }, (tx) => tx.selectFrom("tenancy.user").select("id").where("email", "=", "owner@sale.test").executeTakeFirstOrThrow())).id;
  for (const [email, role] of [["desk@sale.test", "box_office"], ["money@sale.test", "finance"], ["words@sale.test", "editor"]] as const) {
    expect((await call("POST", "/v1/account/invitations", { body: { email, role } })).status).toBe(201);
    await call("GET", "/v1/me", { as: email });
  }
  await withTenant(db, ctx, async (tx: Tx) => {
    const vat = await offers.createVatClass(tx, ctx, { code: "exempt", label: "Fritatt", ratePct: 0 });
    const web = await offers.createChannel(tx, ctx, { code: "web", name: "Nettbutikk", kind: "ecom" });
    await offers.setSkuMapping(tx, ctx, vat.id, web.id, "TICKET-VAT0");
    key = (await offers.createChannelKey(tx, ctx, web.id, "Shopify")).secret;
    const event = await catalog.createEvent(tx, ctx, { slug: "hamlet", translations: { nb: { title: "Hamlet" } }, admissionMode: "tickets", registration: { capacity: 10 } });
    occurrenceId = (await catalog.createOccurrence(tx, ctx, event.id, { startUtc: new Date(Date.now() + 30 * 86_400_000) })).id;
    adult = (await offers.createOffer(tx, ctx, event.id, { translations: { nb: { name: "Voksen" } }, vatClassId: vat.id, defaultPrice: 45000 })).offer!.id;
    await catalog.transitionEvent(tx, ctx, event.id, (await catalog.getEvent(tx, event.id)).version, "publish");
  });
});
afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await tdb?.stop();
});

describe("cancelling confirmed tickets", () => {
  it("lets the channel refund some tickets, then the rest, with safe retries", async () => {
    const sold = await sell("ORDER-1", 3);
    expect(sold.status).toBe(201);
    const [t1] = sold.body.tickets;
    const one = await call("POST", `/v1/reservations/${sold.body.id}/cancel`, { key, idem: "refund-1", body: { ticketIds: [t1.id], externalRefundRef: "REFUND-1" } });
    expect(one).toMatchObject({ status: 200, body: { status: "confirmed" } });
    expect(one.body.tickets[0]).toMatchObject({ id: t1.id, status: "cancelled", cancelledBy: "channel", externalRefundRef: "REFUND-1", url: null, qr: null, cancelledAt: expect.any(String) });
    expect(one.body.tickets[1]).toMatchObject({ status: "valid", cancelledAt: null, cancelledBy: null });
    // A lost response: the retry returns the reservation and cancels nothing more.
    const retry = await call("POST", `/v1/reservations/${sold.body.id}/cancel`, { key, idem: "refund-1", body: { ticketIds: [t1.id], externalRefundRef: "REFUND-1" } });
    expect(retry).toMatchObject({ status: 200, body: { status: "confirmed" } });
    expect((await call("POST", `/v1/reservations/${sold.body.id}/cancel`, { key, idem: "refund-1b", body: { ticketIds: [t1.id] } })).body)
      .toMatchObject({ status: 409, code: "already_cancelled", details: { ticketIds: [t1.id] } });
    const rest = await call("POST", `/v1/reservations/${sold.body.id}/cancel`, { key, idem: "refund-2", body: { externalRefundRef: "REFUND-2" } });
    expect(rest).toMatchObject({ status: 200, body: { status: "cancelled", externalOrderRef: "ORDER-1" } });
    expect((await call("POST", `/v1/reservations/${sold.body.id}/cancel`, { key, idem: "refund-3", body: { ticketIds: ["not-a-uuid"] } })).status).toBe(400);
  });
});

describe("Occurrence → Sales", () => {
  it("shows sales to box office and finance, not editors; box office cancels, finance cannot", async () => {
    const sold = await sell("ORDER-2", 2);
    const view = await call("GET", `/v1/occurrences/${occurrenceId}/sales`, { as: "money@sale.test" });
    expect(view).toMatchObject({ status: 200, body: { occurrenceId, currency: "NOK", offers: [{ offerId: adult, code: "voksen", sold: 2, cancelled: 3, revenue: 90000 }] } });
    expect(view.headers["cache-control"]).toBe("no-store");
    expect(view.body.reservations[0]).toMatchObject({ id: sold.body.id, status: "confirmed", externalOrderRef: "ORDER-2", buyer: { name: "Kari", email: "kari@example.com" }, channel: { code: "web" } });
    expect((await call("GET", `/v1/occurrences/${occurrenceId}/sales`, { as: "words@sale.test" })).status).toBe(403);

    expect((await call("POST", `/v1/sales/reservations/${sold.body.id}/cancel`, { as: "money@sale.test", body: {} })).status).toBe(403);
    const c = await call("POST", `/v1/sales/reservations/${sold.body.id}/cancel`, { as: "desk@sale.test", idem: "desk-1", body: { ticketIds: [sold.body.tickets[0].id], externalRefundRef: "KASSE-1" } });
    expect(c).toMatchObject({ status: 200, body: { status: "confirmed" } });
    expect(c.body.tickets[0]).toMatchObject({ status: "cancelled", cancelledBy: "staff", externalRefundRef: "KASSE-1" });
    // The channel sees the staff cancellation on its next read.
    expect((await call("GET", `/v1/reservations/${sold.body.id}`, { key })).body.tickets[0]).toMatchObject({ status: "cancelled", cancelledBy: "staff" });
    expect((await call("GET", `/v1/sales/reservations/${sold.body.id}`, { as: "money@sale.test" })).body).toMatchObject({ id: sold.body.id, signature: null });

    // Channel keys cannot use the staff routes, and staff tokens cannot use the channel's.
    expect((await call("GET", `/v1/occurrences/${occurrenceId}/sales`, { key })).status).toBe(401);
    expect((await call("GET", `/v1/reservations/${sold.body.id}`, { as: "desk@sale.test" })).status).toBe(401);
    // Another account sees nothing.
    expect((await call("GET", `/v1/sales/reservations/${sold.body.id}`, { as: "owner@b.test", account: B })).status).toBe(404);
    expect((await call("GET", `/v1/occurrences/${occurrenceId}/sales`, { as: "owner@b.test", account: B })).status).toBe(404);
  });

  it("refuses to delete an occurrence with tickets", async () => {
    const o = await call("GET", `/v1/occurrences/${occurrenceId}`);
    const del = await app.inject({
      method: "DELETE", url: `/v1/occurrences/${occurrenceId}`,
      headers: { authorization: `Bearer ${await token("owner@sale.test")}`, "account-id": ctx.tenantId, "if-match": o.headers.etag as string },
    });
    expect(del.statusCode).toBe(409);
  });
});
