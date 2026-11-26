import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { type ActorContext, catalog, offers, payments, tenancy } from "@event-manager/domain";
import { FakeVipps } from "@event-manager/vipps";
import { buildAttendeeApp, redactUrl } from "../src/app.js";

// The hosted checkout's buyer pages (docs/checkout.md): the buy form, the redirect to Vipps,
// and the return page while waiting, after payment and after a rejection.

let tdb: TestDatabase;
let db: Db;
let app: Awaited<ReturnType<typeof buildAttendeeApp>>;
let ctx: ActorContext;
let now = new Date("2027-02-01T12:00:00Z");
const ATTENDEE = "http://attendee.test";
const vipps = new FakeVipps({ landingUrl: `${ATTENDEE}/b/fake-vipps` });
let occId: string;
let adultId: string;

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  app = await buildAttendeeApp({ db, clock: () => now, rateLimit: { capacity: 4, refillPerSecond: 0.0001 }, checkout: { provider: vipps, attendeeUrl: ATTENDEE, fake: vipps } });
  const account = await tenancy.createAccount(db, { slug: "buy", name: "Teatret", ownerEmail: "owner@buy.test", locales: ["nb", "en"] });
  const userId = await tenancy.login(db, { issuer: "https://idp.test", subject: "owner@buy.test", email: "owner@buy.test", name: null });
  ctx = { tenantId: account.id, userId, clientId: null, roles: ["owner"] };
  await payments.connectVipps(db, ctx, { environment: "test", merchantSerialNumber: "123456", clientId: "c", clientSecret: "s", subscriptionKey: "k" }, { provider: vipps, webhookUrl: null });
  await withTenant(db, ctx, async (tx) => {
    const vat = await offers.createVatClass(tx, ctx, { code: "culture", label: "Kultur", ratePct: 12 });
    await offers.enableHostedChannel(tx, ctx);
    const event = await catalog.createEvent(tx, ctx, { translations: { nb: { title: "Hamlet" }, en: { title: "Hamlet (en)" } }, admissionMode: "tickets", registration: { capacity: 10 } });
    const occ = await catalog.createOccurrence(tx, ctx, event.id, { startUtc: new Date("2027-02-13T18:30:00Z") });
    adultId = (await offers.createOffer(tx, ctx, event.id, { translations: { nb: { name: "Voksen" }, en: { name: "Adult" } }, vatClassId: vat.id, defaultPrice: 45000 })).offer!.id;
    await catalog.transitionEvent(tx, ctx, event.id, (await catalog.getEvent(tx, event.id)).version, "publish");
    occId = occ.id;
  });
});
afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await tdb?.stop();
});

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const buy = (fields: Record<string, string>, ip = "10.0.0.1") =>
  app.inject({ method: "POST", url: `/b/${occId}`, remoteAddress: ip, headers: { "content-type": "application/x-www-form-urlencoded" }, payload: form(fields) });
const valid = () => ({ locale: "nb", t: String(now.getTime() - 5000), name: "Kari Nordmann", email: "kari@example.com", phone: "91234567", [`q_${adultId}`]: "2" });

describe("buy page", () => {
  it("shows the offers with prices and lets the form go on to Vipps", async () => {
    const res = await app.inject({ method: "GET", url: `/b/${occId}?lang=nb` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Hamlet");
    expect(res.body).toContain("Voksen");
    expect(res.body).toMatch(/450\s?kr/);
    expect(res.body).toContain("Betal med Vipps");
    expect(res.headers["content-security-policy"]).toContain("form-action 'self' https://*.vipps.no");
    expect((await app.inject({ method: "GET", url: "/b/not-a-uuid" })).statusCode).toBe(404);
  });

  it("sends the buyer to Vipps, then shows the waiting page, then the receipt and tickets", async () => {
    const res = await buy(valid());
    expect(res.statusCode).toBe(303);
    const landing = res.headers.location as string;
    expect(landing).toMatch(new RegExp(`^${ATTENDEE}/b/fake-vipps/em-`));
    const reference = landing.split("/").pop()!;
    const back = vipps.payments.get(reference)!.returnUrl.replace(ATTENDEE, "");
    expect(redactUrl(back)).toBe("/b/return/[token]");

    const waiting = await app.inject({ method: "GET", url: back });
    expect(waiting.body).toContain("Venter på Vipps");
    expect(waiting.body).toContain('http-equiv="refresh"');

    // The fake landing page approves and sends the buyer back.
    const approved = await app.inject({ method: "POST", url: `/b/fake-vipps/${reference}`, headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "answer=approve" });
    expect(approved.headers.location).toBe(`${ATTENDEE}${back}`);
    const done = await app.inject({ method: "GET", url: back });
    expect(done.body).toContain("Bestillingen er bekreftet");
    expect(done.body).toContain(reference);
    expect(done.body).toMatch(/900\s?kr/);
    expect(done.body).toContain("Herav mva. 12 %");
    expect(done.body.match(/\/t\/[A-Za-z0-9_-]{72}/g)).toHaveLength(2);
    expect(vipps.callsFor(reference, "capture")).toHaveLength(1);
  });

  it("says no money was taken when the buyer rejects", async () => {
    const res = await buy(valid(), "10.0.0.2");
    const reference = (res.headers.location as string).split("/").pop()!;
    vipps.reject(reference);
    const back = vipps.payments.get(reference)!.returnUrl.replace(ATTENDEE, "");
    const page = await app.inject({ method: "GET", url: back });
    expect(page.body).toContain("Betalingen ble ikke fullført");
    expect(page.body).toContain(`/b/${occId}`);
  });

  it("shows errors in the form: missing fields, too many tickets, bots and floods", async () => {
    const noName = await buy({ ...valid(), name: "" }, "10.0.0.3");
    expect(noName.statusCode).toBe(422);
    expect(noName.body).toContain("Sjekk feltene");
    const tooMany = await buy({ ...valid(), [`q_${adultId}`]: "11" }, "10.0.0.3");
    expect(tooMany.statusCode).toBe(409);
    expect(tooMany.body).toContain("ikke nok billetter");
    expect((await buy({ ...valid(), website: "spam" }, "10.0.0.4")).statusCode).toBe(400);
    expect((await buy({ ...valid(), t: String(now.getTime()) }, "10.0.0.4")).statusCode).toBe(400);
    for (let i = 0; i < 4; i++) await buy({ ...valid(), name: "" }, "10.0.0.5");
    expect((await buy(valid(), "10.0.0.5")).statusCode).toBe(429);
  });

  it("rejects a forged return link", async () => {
    expect((await app.inject({ method: "GET", url: `/b/return/${"A".repeat(72)}` })).statusCode).toBe(404);
  });
});

describe("without the checkout configured", () => {
  it("serves no /b pages", async () => {
    const plain = await buildAttendeeApp({ db });
    expect((await plain.inject({ method: "GET", url: `/b/${occId}` })).statusCode).toBe(404);
    await plain.close();
    now = new Date(now);
  });
});
