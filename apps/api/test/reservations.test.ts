import { createHash, createHmac } from "node:crypto";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, type Tx, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { type ActorContext, catalog, offers, sales, tenancy } from "@event-manager/domain";
import { buildApp } from "../src/app.js";
import { DEV_ISSUER, devVerifier } from "../src/auth.js";

// Ticketing milestone 3 over HTTP: the reservations API with channel keys, required
// Idempotency-Keys, problem details with stable reasons, signatures, and tenant isolation.

const SECRET = "test-secret";
let tdb: TestDatabase;
let db: Db;
let app: Awaited<ReturnType<typeof buildApp>>;

interface Shop { ctx: ActorContext; key: string; occurrenceId: string; adult: string; child: string }
let a: Shop;
let b: Shop;

const START = new Date(Date.now() + 30 * 86_400_000);

async function setupShop(slug: string, capacity: number): Promise<Shop> {
  const account = await tenancy.createAccount(db, { slug, name: slug, ownerEmail: `owner@${slug}.test` });
  const userId = await tenancy.login(db, { issuer: "https://idp.test", subject: `owner@${slug}.test`, email: `owner@${slug}.test`, name: null });
  const ctx: ActorContext = { tenantId: account.id, userId, clientId: null, roles: ["owner"] };
  return withTenant(db, ctx, async (tx: Tx) => {
    const vat = await offers.createVatClass(tx, ctx, { code: "exempt", label: "Fritatt", ratePct: 0 });
    const web = await offers.createChannel(tx, ctx, { code: "web", name: "Nettbutikk", kind: "ecom" });
    await offers.setSkuMapping(tx, ctx, vat.id, web.id, "TICKET-VAT0");
    const key = (await offers.createChannelKey(tx, ctx, web.id, "Shopify")).secret;
    const event = await catalog.createEvent(tx, ctx, { slug: "hamlet", translations: { nb: { title: "Hamlet" } }, admissionMode: "tickets", registration: { capacity } });
    const occ = await catalog.createOccurrence(tx, ctx, event.id, { startUtc: START });
    const adult = (await offers.createOffer(tx, ctx, event.id, { translations: { nb: { name: "Voksen" } }, vatClassId: vat.id, defaultPrice: 45000 })).offer!;
    const child = (await offers.createOffer(tx, ctx, event.id, { translations: { nb: { name: "Barn" } }, vatClassId: vat.id, defaultPrice: 20000 })).offer!;
    await catalog.transitionEvent(tx, ctx, event.id, (await catalog.getEvent(tx, event.id)).version, "publish");
    return { ctx, key, occurrenceId: occ.id, adult: adult.id, child: child.id };
  });
}

async function call(method: string, url: string, opts: { key?: string; idem?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  if (opts.idem) headers["idempotency-key"] = opts.idem;
  const res = await app.inject({ method: method as "GET", url, headers, ...(opts.body !== undefined ? { payload: opts.body as object } : {}) });
  return { status: res.statusCode, headers: res.headers, body: res.body ? res.json() : undefined };
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  app = await buildApp({ db, verifier: devVerifier(SECRET), attendeeUrl: "https://tickets.test/" });
  a = await setupShop("res-a", 3);
  b = await setupShop("res-b", 10);
});
afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await tdb?.stop();
});

describe("/v1/reservations", () => {
  it("needs a channel key, and an Idempotency-Key on every write", async () => {
    expect((await call("GET", `/v1/reservations/${crypto.randomUUID()}`)).status).toBe(401);
    const jwt = await new SignJWT({ email: "owner@res-a.test" }).setProtectedHeader({ alg: "HS256" }).setIssuer(DEV_ISSUER).setSubject("owner@res-a.test").setExpirationTime("5m").sign(new TextEncoder().encode(SECRET));
    expect((await call("GET", `/v1/reservations/${crypto.randomUUID()}`, { key: jwt })).body).toMatchObject({ status: 401, code: "unauthenticated" });
    expect((await call("GET", `/v1/reservations/${crypto.randomUUID()}`, { key: `${a.key.slice(0, -1)}x` })).status).toBe(401);
    const body = { lines: [{ occurrenceId: a.occurrenceId, offerId: a.adult, quantity: 1 }] };
    expect((await call("POST", "/v1/reservations", { key: a.key, body })).body).toMatchObject({ status: 428, code: "idempotency_key_required" });
  });

  it("reserves, confirms and returns the same tickets on retry, with signatures the connector can check", async () => {
    const body = { externalRef: "cart-1", lines: [{ occurrenceId: a.occurrenceId, offerId: a.adult, quantity: 2 }, { occurrenceId: a.occurrenceId, offerId: a.child, quantity: 1 }] };
    const r = await call("POST", "/v1/reservations", { key: a.key, idem: "cart-1-reserve", body });
    expect(r).toMatchObject({ status: 201, body: { status: "held", externalRef: "cart-1", total: { amount: 110000, currency: "NOK" }, tickets: [] } });
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body.lines.map((l: { externalSku: string; quantity: number }) => [l.externalSku, l.quantity])).toEqual([["TICKET-VAT0", 2], ["TICKET-VAT0", 1]]);

    // The connector checks a line's signature with SHA-256 of its own key's secret.
    const signingKey = createHash("sha256").update(a.key.split("_")[2]!).digest();
    const line = r.body.lines[0];
    const text = JSON.stringify([
      "reservation_line.v1", r.body.id, line.id, line.lineNo, line.occurrenceId, line.offerId, line.offerCode, line.quantity, line.placesPerUnit,
      line.unitPrice, line.currency, line.vatClassCode, line.vatRatePct, line.externalSku, line.name, line.occurrenceStartUtc, line.timezone, line.locationName,
    ]);
    expect(line.signature).toBe(`v1.${createHmac("sha256", signingKey).update(text).digest("base64url")}`);

    // A lost response: the retry with the same key gets the same reservation, not a second hold.
    const retry = await call("POST", "/v1/reservations", { key: a.key, idem: "cart-1-reserve", body });
    expect(retry.body.id).toBe(r.body.id);
    expect((await call("POST", "/v1/reservations", { key: a.key, idem: "cart-1-reserve", body: { ...body, externalRef: "other" } })).status).toBe(422);
    expect((await call("GET", `/v1/reservations/${r.body.id}`, { key: a.key })).body).toMatchObject({ id: r.body.id, status: "held" });

    const confirm = { externalOrderRef: "ORDER-1001", buyer: { name: "Kari", email: "kari@example.com" } };
    const c = await call("POST", `/v1/reservations/${r.body.id}/confirm`, { key: a.key, idem: "order-1001", body: confirm });
    expect(c).toMatchObject({ status: 200, body: { status: "confirmed", externalOrderRef: "ORDER-1001", buyer: { name: "Kari", email: "kari@example.com" } } });
    expect(c.body.tickets).toHaveLength(3);
    for (const t of c.body.tickets) {
      expect(t.url).toMatch(/^https:\/\/tickets\.test\/t\/[A-Za-z0-9_-]{72}$/);
      expect(t.qr).toMatch(/^[A-Za-z0-9_-]{72}$/);
    }
    const again = await call("POST", `/v1/reservations/${r.body.id}/confirm`, { key: a.key, idem: "order-1001", body: confirm });
    expect(again.body.tickets.map((t: { id: string }) => t.id)).toEqual(c.body.tickets.map((t: { id: string }) => t.id));

    // The idempotency store keeps no buyer details.
    const stored = await withTenant(db, { tenantId: a.ctx.tenantId }, (tx) => tx.selectFrom("tenancy.idempotency_key").select("response").execute());
    expect(JSON.stringify(stored)).not.toContain("kari@example.com");
  });

  it("answers with problem details and stable reasons", async () => {
    const sold = await call("POST", "/v1/reservations", { key: a.key, idem: "too-many", body: { lines: [{ occurrenceId: a.occurrenceId, offerId: a.adult, quantity: 5 }] } });
    expect(sold).toMatchObject({ status: 409, body: { code: "sold_out", details: { occurrenceId: a.occurrenceId, placesLeft: 0 } } });
    expect(sold.headers["content-type"]).toContain("application/problem+json");
    const range = await call("POST", "/v1/reservations", { key: b.key, idem: "range", body: { lines: [{ occurrenceId: b.occurrenceId, offerId: b.adult, quantity: 21 }] } });
    expect(range).toMatchObject({ status: 422, body: { code: "quantity_out_of_range", details: { line: 0, max: 20 } } });
  });

  it("extends and cancels held reservations", async () => {
    const r = await call("POST", "/v1/reservations", { key: b.key, idem: "ext-1", body: { lines: [{ occurrenceId: b.occurrenceId, offerId: b.adult, quantity: 2 }] } });
    const e = await call("POST", `/v1/reservations/${r.body.id}/extend`, { key: b.key, idem: "ext-1-extend", body: { minutes: 30 } });
    expect(e.status).toBe(200);
    expect(new Date(e.body.expiresAt).getTime()).toBeGreaterThan(new Date(r.body.expiresAt).getTime());
    const c = await call("POST", `/v1/reservations/${r.body.id}/cancel`, { key: b.key, idem: "ext-1-cancel" });
    expect(c).toMatchObject({ status: 200, body: { status: "cancelled" } });
    expect((await call("POST", `/v1/reservations/${r.body.id}/cancel`, { key: b.key, idem: "ext-1-cancel-2" })).body).toMatchObject({ status: 409, code: "already_cancelled" });
  });

  it("keeps one tenant's reservations from another tenant's channel key", async () => {
    const r = await call("POST", "/v1/reservations", { key: b.key, idem: "b-1", body: { lines: [{ occurrenceId: b.occurrenceId, offerId: b.adult, quantity: 1 }] } });
    expect((await call("GET", `/v1/reservations/${r.body.id}`, { key: a.key })).status).toBe(404);
    expect((await call("POST", `/v1/reservations/${r.body.id}/confirm`, { key: a.key, idem: "steal", body: { externalOrderRef: "X" } })).status).toBe(404);
    expect((await call("POST", `/v1/reservations/${r.body.id}/cancel`, { key: a.key, idem: "steal-2" })).status).toBe(404);
    // Nor can it reserve the other tenant's offers.
    expect((await call("POST", "/v1/reservations", { key: a.key, idem: "a-b", body: { lines: [{ occurrenceId: b.occurrenceId, offerId: b.adult, quantity: 1 }] } })).status).toBe(404);
    expect((await withTenant(db, { tenantId: b.ctx.tenantId }, (tx) => sales.getReservation(tx, { tenantId: b.ctx.tenantId, channelId: r.body.channelId, signingKey: null }, r.body.id))).status).toBe("held");
  });
});
