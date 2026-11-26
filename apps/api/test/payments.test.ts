import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, sql, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { catalog, offers, payments, tenancy } from "@event-manager/domain";
import { FakeVipps, signHeaders } from "@event-manager/vipps";
import { buildApp } from "../src/app.js";
import { DEV_ISSUER, devVerifier } from "../src/auth.js";

// Hosted checkout milestone 1 over HTTP: connecting, verifying and disconnecting the account's
// own Vipps MobilePay merchant, and the merchant details on the account.

const SECRET = "test-secret";
let tdb: TestDatabase;
let db: Db;
let su: Db;
let app: Awaited<ReturnType<typeof buildApp>>;
const vipps = new FakeVipps();
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

const keys = { environment: "test", merchantSerialNumber: "123456", clientId: "client-a", clientSecret: "secret-a", subscriptionKey: "sub-a" };

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  su = createDb(tdb.superuserUrl, { max: 1 });
  app = await buildApp({ db, verifier: devVerifier(SECRET), payments: { provider: vipps, webhookBaseUrl: "https://api.example.test" } });
  A = (await tenancy.createAccount(db, { slug: "pay-a", name: "A", ownerEmail: "owner@a.test" })).id;
  B = (await tenancy.createAccount(db, { slug: "pay-b", name: "B", ownerEmail: "owner@b.test" })).id;
  await call("GET", "/v1/me");
  await call("GET", "/v1/me", { as: "owner@b.test" });
  await call("POST", "/v1/account/invitations", { body: { email: "manager@a.test", role: "event_manager" } });
  await call("GET", "/v1/me", { as: "manager@a.test" });
});
afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await su?.destroy();
  await tdb?.stop();
});

describe("/v1 payments", () => {
  it("connects Vipps with keys Vipps accepts, stores them encrypted and registers the webhook", async () => {
    expect((await call("GET", "/v1/payments")).body).toEqual({ vipps: null, checkout: null });
    expect((await call("PUT", "/v1/payments/vipps", { as: "manager@a.test", body: keys })).status).toBe(403);
    expect((await call("PUT", "/v1/payments/vipps", { body: { ...keys, merchantSerialNumber: "12" } })).status).toBe(400);

    vipps.refusedSecrets.add("wrong");
    const refused = await call("PUT", "/v1/payments/vipps", { body: { ...keys, clientSecret: "wrong" } });
    expect(refused).toMatchObject({ status: 422, body: { code: "validation_failed" } });
    expect((await call("GET", "/v1/payments")).body).toEqual({ vipps: null, checkout: null });

    const connected = await call("PUT", "/v1/payments/vipps", { body: keys });
    expect(connected).toMatchObject({ status: 200, body: { provider: "vipps", environment: "test", merchantSerialNumber: "123456", clientId: "client-a", status: "active", webhookRegistered: true } });
    expect(connected.body).not.toHaveProperty("clientSecret");
    const hook = [...vipps.webhooks.values()].at(-1)!;
    expect(hook.url).toBe(`https://api.example.test/webhooks/vipps/${A}/${connected.body.id}`);

    // Encrypted at rest: neither key appears in the row.
    const row = await sql<{ credentials: Buffer; webhook_secret: Buffer }>`select credentials, webhook_secret from payments.provider_account where id = ${connected.body.id}`.execute(su);
    expect(row.rows[0]!.credentials.toString("latin1")).not.toMatch(/secret-a|sub-a/);
    expect(row.rows[0]!.webhook_secret.toString("latin1")).not.toContain(hook.secret);

    // Everyone in the account sees it; other accounts do not.
    expect((await call("GET", "/v1/payments", { as: "manager@a.test" })).body.vipps.id).toBe(connected.body.id);
    expect((await call("GET", "/v1/payments", { as: "owner@b.test", account: B })).body).toEqual({ vipps: null, checkout: null });
  });

  it("marks the connection invalid when Vipps later refuses the keys, and active again once accepted", async () => {
    vipps.refusedSecrets.add("secret-a");
    const bad = await call("POST", "/v1/payments/vipps/verify");
    expect(bad).toMatchObject({ status: 200, body: { status: "invalid" } });
    expect(bad.body.statusReason).toMatch(/refused/);
    vipps.refusedSecrets.delete("secret-a");
    expect((await call("POST", "/v1/payments/vipps/verify")).body).toMatchObject({ status: "active", statusReason: null });
  });

  it("replaces a connected merchant, removing the old webhook", async () => {
    const before = (await call("GET", "/v1/payments")).body.vipps;
    const hooks = vipps.webhooks.size;
    const next = await call("PUT", "/v1/payments/vipps", { body: { ...keys, merchantSerialNumber: "654321", clientSecret: "secret-b" } });
    expect(next.body).toMatchObject({ merchantSerialNumber: "654321", status: "active" });
    expect(next.body.id).not.toBe(before.id);
    expect(vipps.webhooks.size).toBe(hooks);
    const old = await sql`select status, credentials from payments.provider_account where id = ${before.id}`.execute(su);
    expect(old.rows[0]).toEqual({ status: "disconnected", credentials: null });
  });

  it("disconnects with If-Match, deleting the keys and the webhook", async () => {
    const current = (await call("GET", "/v1/payments")).body.vipps;
    expect((await call("DELETE", "/v1/payments/vipps", { as: "manager@a.test", headers: { "if-match": `"${current.version}"` } })).status).toBe(403);
    expect((await call("DELETE", "/v1/payments/vipps", { headers: { "if-match": `"${current.version + 5}"` } })).status).toBe(412);
    expect((await call("DELETE", "/v1/payments/vipps", { headers: { "if-match": `"${current.version}"` } })).status).toBe(204);
    expect((await call("GET", "/v1/payments")).body).toEqual({ vipps: null, checkout: null });
    expect(vipps.webhooks.size).toBe(0);
    expect((await call("POST", "/v1/payments/vipps/verify")).status).toBe(404);
  });

  it("keeps the merchant details on the account, checking the organisation number", async () => {
    const acc = await call("GET", "/v1/account");
    expect(acc.body.merchant).toEqual({ legalName: null, orgNumber: null, address: null, vatRegistered: false });
    const ifMatch = { "if-match": acc.headers.etag as string };
    expect((await call("PATCH", "/v1/account", { body: { merchant: { orgNumber: "123456789" } }, headers: ifMatch })).status).toBe(422);
    const saved = await call("PATCH", "/v1/account", { body: { merchant: { legalName: "Teater AS", orgNumber: "974 760 673", address: "Storgata 1, 0155 Oslo", vatRegistered: true } }, headers: ifMatch });
    expect(saved).toMatchObject({ status: 200, body: { merchant: { legalName: "Teater AS", orgNumber: "974760673", address: "Storgata 1, 0155 Oslo", vatRegistered: true } } });
  });
});

describe("/v1 payments without a provider", () => {
  it("says payments are not set up", async () => {
    const off = await buildApp({ db, verifier: devVerifier(SECRET) });
    const res = await off.inject({ method: "PUT", url: "/v1/payments/vipps", payload: keys, headers: { authorization: `Bearer ${await token("owner@a.test")}`, "account-id": A } });
    expect(res.statusCode).toBe(409);
    await off.close();
  });
});

describe("the hosted checkout and Vipps webhooks", () => {
  it("enables the checkout's channel (owner), and queues a payment when a signed webhook names it", async () => {
    expect((await call("POST", "/v1/payments/checkout", { as: "manager@a.test" })).status).toBe(403);
    const enabled = await call("POST", "/v1/payments/checkout");
    expect(enabled).toMatchObject({ status: 200, body: { active: true } });
    expect((await call("GET", "/v1/payments")).body.checkout).toEqual({ channelId: enabled.body.channelId, active: true });
    const channels = (await call("GET", "/v1/sales-channels")).body.items;
    expect(channels.find((c: { id: string }) => c.id === enabled.body.channelId)).toMatchObject({ kind: "hosted", sendTickets: true });

    const connected = (await call("PUT", "/v1/payments/vipps", { body: keys })).body;
    const hook = [...vipps.webhooks.values()].at(-1)!;
    const ctx = { tenantId: A, userId: null, clientId: null, roles: ["owner"] };
    const occId = await withTenant(db, ctx, async (tx) => {
      const vat = await offers.createVatClass(tx, ctx, { code: "culture", label: "Kultur", ratePct: 12 });
      const event = await catalog.createEvent(tx, ctx, { translations: { nb: { title: "Hamlet" } }, admissionMode: "tickets", registration: { capacity: 10 } });
      const occ = await catalog.createOccurrence(tx, ctx, event.id, { startUtc: new Date(Date.now() + 10 * 86_400_000) });
      await offers.enableHostedChannel(tx, ctx);
      await offers.createOffer(tx, ctx, event.id, { translations: { nb: { name: "Voksen" } }, vatClassId: vat.id, defaultPrice: 45000 });
      await catalog.transitionEvent(tx, ctx, event.id, (await catalog.getEvent(tx, event.id)).version, "publish");
      return occ.id;
    });
    const offerId = (await withTenant(db, ctx, (tx) => payments.checkoutPage(tx, occId, "nb")))!.occurrence.offers[0]!.id;
    const started = await payments.startCheckout(db, A, { occurrenceId: occId, lines: [{ offerId, quantity: 1 }], buyer: { name: "Kari", email: "kari@example.com" } }, { provider: vipps, attendeeUrl: "http://attendee.test" });
    if (started.kind !== "pay") throw new Error("expected a payment");
    const reference = (await withTenant(db, ctx, (tx) => tx.selectFrom("payments.payment").select("reference").where("id", "=", started.paymentId).executeTakeFirstOrThrow())).reference;

    const url = `/webhooks/vipps/${A}/${connected.id}`;
    const post = (body: string, secret = hook.secret, path = url) =>
      app.inject({ method: "POST", url: path, headers: { host: "origin.internal", "content-type": "application/json", ...signHeaders(secret, { method: "POST", pathAndQuery: path, host: "api.example.test", body }) }, payload: body });
    const jobs = async () => (await sql<{ n: number }>`select count(*)::int as n from graphile_worker._private_jobs where key = ${`payment:${started.paymentId}`}`.execute(su)).rows[0]!.n;

    const body = JSON.stringify({ msn: "123456", reference, name: "AUTHORIZED", pspReference: "1", timestamp: new Date().toISOString() });
    expect((await post(body, "wrong-secret")).statusCode).toBe(401);
    expect(await jobs()).toBe(0);
    expect((await post(body)).statusCode).toBe(200);
    expect((await post(body)).statusCode).toBe(200);
    // A burst for one payment is one job.
    expect(await jobs()).toBe(1);
    // Payments made outside the platform are acknowledged and ignored.
    expect((await post(JSON.stringify({ reference: "someone-elses-ref", name: "AUTHORIZED" }))).json()).toEqual({ ok: true, ignored: true });
    // Unknown accounts, and another tenant's account under this tenant's id, are not found.
    expect((await post(body, hook.secret, `/webhooks/vipps/${A}/${B}`)).statusCode).toBe(404);
    expect((await post(body, hook.secret, `/webhooks/vipps/${B}/${connected.id}`)).statusCode).toBe(404);
    expect((await post(body, hook.secret, "/webhooks/vipps/x/y")).statusCode).toBe(404);
  });
});
