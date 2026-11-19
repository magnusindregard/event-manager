import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { tenancy } from "@event-manager/domain";
import { buildApp } from "../src/app.js";
import { DEV_ISSUER, devVerifier } from "../src/auth.js";

// Ticketing milestone 2 over HTTP: sales channels, channel keys, the SKU mapping, and offers'
// channels and sales windows.

const SECRET = "test-secret";
let tdb: TestDatabase;
let db: Db;
let app: Awaited<ReturnType<typeof buildApp>>;
let A: string;
let B: string;

const token = (email: string) =>
  new SignJWT({ email }).setProtectedHeader({ alg: "HS256" }).setIssuer(DEV_ISSUER).setSubject(email).setExpirationTime("5m").sign(new TextEncoder().encode(SECRET));

async function call(method: string, url: string, opts: { as?: string; account?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...opts.headers };
  headers.authorization = `Bearer ${await token(opts.as ?? "owner@a.test")}`;
  headers["account-id"] = opts.account ?? A;
  const res = await app.inject({ method: method as "GET", url, headers, ...(opts.body !== undefined ? { payload: opts.body as object } : {}) });
  return { status: res.statusCode, headers: res.headers, body: res.body ? res.json() : undefined };
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  app = await buildApp({ db, verifier: devVerifier(SECRET) });
  A = (await tenancy.createAccount(db, { slug: "ch-a", name: "A", ownerEmail: "owner@a.test" })).id;
  B = (await tenancy.createAccount(db, { slug: "ch-b", name: "B", ownerEmail: "owner@b.test" })).id;
  await call("GET", "/v1/me");
  await call("GET", "/v1/me", { as: "owner@b.test" });
  await call("POST", "/v1/account/invitations", { body: { email: "manager@a.test", role: "event_manager" } });
  await call("GET", "/v1/me", { as: "manager@a.test" });
});
afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await tdb?.stop();
});

describe("/v1 sales channels and SKUs", () => {
  it("sets up channels, keys and SKUs, and offers report their channels and sales window", async () => {
    const web = await call("POST", "/v1/sales-channels", { body: { code: "web", name: "Nettbutikk", kind: "ecom" }, headers: { "idempotency-key": "ch-1" } });
    expect(web).toMatchObject({ status: 201, body: { code: "web", kind: "ecom", holdMinutes: 15, sendTickets: false, active: true } });
    expect((await call("POST", "/v1/sales-channels", { body: { code: "web", name: "Igjen", kind: "ecom" } })).status).toBe(409);
    expect((await call("POST", "/v1/sales-channels", { as: "manager@a.test", body: { code: "pos", name: "Luke", kind: "pos" } })).status).toBe(403);
    expect((await call("POST", "/v1/sales-channels", { body: { code: "pos", name: "Luke", kind: "pos", holdMinutes: 90 } })).status).toBe(400);
    expect((await call("GET", "/v1/sales-channels", { as: "manager@a.test" })).body.items.map((c: { code: string }) => c.code)).toEqual(["web"]);

    const patched = await call("PATCH", `/v1/sales-channels/${web.body.id}`, { body: { sendTickets: true }, headers: { "if-match": web.headers.etag as string } });
    expect(patched).toMatchObject({ status: 200, body: { sendTickets: true, version: 2 } });

    const key = await call("POST", `/v1/sales-channels/${web.body.id}/keys`, { body: { label: "Shopify" } });
    expect(key).toMatchObject({ status: 201, body: { channelId: web.body.id, label: "Shopify" } });
    expect(key.headers["cache-control"]).toBe("no-store");
    expect(key.body.secret).toMatch(/^sk_/);
    const { secret: _secret, ...listed } = key.body;
    expect((await call("GET", `/v1/sales-channels/${web.body.id}/keys`)).body.items).toEqual([listed]);
    expect((await call("GET", `/v1/sales-channels/${web.body.id}/keys`, { as: "manager@a.test" })).status).toBe(403);
    // Channel keys are not public API keys, and cannot be made as one.
    expect((await call("GET", "/v1/api-keys")).body.items).toEqual([]);
    expect((await call("POST", "/v1/api-keys", { body: { kind: "channel", label: "x" } })).status).toBe(400);

    const vat = (await call("POST", "/v1/vat-classes", { body: { code: "exempt", label: "Fritatt", ratePct: 0 } })).body;
    const eventId = (await call("POST", "/v1/events", { body: { translations: { nb: { title: "Konsert" } }, admissionMode: "tickets" } })).body.id;
    const created = await call("POST", `/v1/events/${eventId}/offers`, {
      body: { translations: { nb: { name: "Voksen" } }, vatClassId: vat.id, defaultPrice: 45000, onSaleAt: "2027-01-15T09:00:00Z", offSaleMinBefore: 30 },
    });
    expect(created).toMatchObject({
      status: 201,
      body: { offer: { channelIds: [web.body.id], channelsWithoutSku: [web.body.id], onSaleAt: "2027-01-15T09:00:00.000Z", onSaleMinBefore: null, offSaleMinBefore: 30, offSaleAt: null } },
    });
    expect((await call("POST", `/v1/events/${eventId}/offers`, { body: { translations: { nb: { name: "X" } }, vatClassId: vat.id, defaultPrice: 1, onSaleAt: "2027-01-15T09:00:00Z", onSaleMinBefore: 60 } })).status).toBe(422);

    expect((await call("PUT", `/v1/sku-mappings/${vat.id}/${web.body.id}`, { as: "manager@a.test", body: { externalSku: "TICKET-VAT0" } })).status).toBe(403);
    const sku = await call("PUT", `/v1/sku-mappings/${vat.id}/${web.body.id}`, { body: { externalSku: "TICKET-VAT0" } });
    expect(sku).toMatchObject({ status: 200, body: { vatClassId: vat.id, channelId: web.body.id, externalSku: "TICKET-VAT0" } });
    expect((await call("GET", "/v1/sku-mappings")).body.items).toHaveLength(1);
    expect((await call("GET", `/v1/offers/${created.body.offer.id}`)).body.channelsWithoutSku).toEqual([]);
    expect((await call("DELETE", `/v1/sku-mappings/${vat.id}/${web.body.id}`)).status).toBe(204);
    expect((await call("GET", "/v1/sku-mappings")).body.items).toEqual([]);

    // Revoking the key; another channel's path does not reach it.
    expect((await call("DELETE", `/v1/sales-channels/${crypto.randomUUID()}/keys/${key.body.id}`)).status).toBe(404);
    expect((await call("DELETE", `/v1/sales-channels/${web.body.id}/keys/${key.body.id}`)).status).toBe(204);
    expect((await call("GET", `/v1/sales-channels/${web.body.id}/keys`)).body.items[0].revokedAt).not.toBeNull();

    // Another tenant sees none of it.
    expect((await call("GET", "/v1/sales-channels", { as: "owner@b.test", account: B })).body.items).toEqual([]);
    expect((await call("GET", `/v1/sales-channels/${web.body.id}`, { as: "owner@b.test", account: B })).status).toBe(404);
    expect((await call("PUT", `/v1/sku-mappings/${vat.id}/${web.body.id}`, { as: "owner@b.test", account: B, body: { externalSku: "X" } })).status).toBe(404);
    expect((await call("POST", `/v1/sales-channels/${web.body.id}/keys`, { as: "owner@b.test", account: B, body: { label: "x" } })).status).toBe(404);
  });
});
