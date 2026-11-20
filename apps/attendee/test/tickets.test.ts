import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { type ActorContext, catalog, offers, sales, tenancy } from "@event-manager/domain";
import { buildAttendeeApp, redactUrl } from "../src/app.js";

// The ticket page (/t/{token}, docs/ticketing.md milestone 3): the QR code for a ticket sold
// through a sales channel.

let tdb: TestDatabase;
let db: Db;
let app: Awaited<ReturnType<typeof buildAttendeeApp>>;
let ctx: ActorContext;

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  app = await buildAttendeeApp({ db });
  const account = await tenancy.createAccount(db, { slug: "tickets", name: "Teatret", ownerEmail: "owner@tickets.test", locales: ["nb", "en"] });
  const userId = await tenancy.login(db, { issuer: "https://idp.test", subject: "owner@tickets.test", email: "owner@tickets.test", name: null });
  ctx = { tenantId: account.id, userId, clientId: null, roles: ["owner"] };
});
afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await tdb?.stop();
});

describe("ticket page", () => {
  it("shows the ticket with its QR code, in the account's languages, and rejects forged links", async () => {
    const tickets = await withTenant(db, ctx, async (tx) => {
      const vat = await offers.createVatClass(tx, ctx, { code: "exempt", label: "Fritatt", ratePct: 0 });
      const web = await offers.createChannel(tx, ctx, { code: "web", name: "Nettbutikk", kind: "ecom" });
      await offers.setSkuMapping(tx, ctx, vat.id, web.id, "TICKET-VAT0");
      const event = await catalog.createEvent(tx, ctx, { translations: { nb: { title: "Hamlet" }, en: { title: "Hamlet (en)" } }, admissionMode: "tickets", registration: { capacity: 10 } });
      const occ = await catalog.createOccurrence(tx, ctx, event.id, { startUtc: new Date(Date.now() + 10 * 86_400_000) });
      const family = (await offers.createOffer(tx, ctx, event.id, { translations: { nb: { name: "Familie" }, en: { name: "Family" } }, vatClassId: vat.id, defaultPrice: 120000, placesPerUnit: 4 })).offer!;
      await catalog.transitionEvent(tx, ctx, event.id, (await catalog.getEvent(tx, event.id)).version, "publish");
      const caller = { tenantId: ctx.tenantId, channelId: web.id, signingKey: null };
      return (await sales.reserve(tx, caller, { confirm: true, externalOrderRef: "O-1", lines: [{ occurrenceId: occ.id, offerId: family.id, quantity: 1 }] })).tickets;
    });
    const token = tickets[0]!.ticketToken!;
    const page = await app.inject({ url: `/t/${token}` });
    expect(page.statusCode).toBe(200);
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.body).toContain("Hamlet");
    expect(page.body).toContain("Familie");
    expect(page.body).toContain("4 personer");
    expect(page.body).toContain("<svg");
    expect((await app.inject({ url: `/t/${token}?lang=en` })).body).toContain("Family");

    // The QR payload is not a ticket link, and a tampered link finds nothing.
    expect((await app.inject({ url: `/t/${tickets[0]!.admissionToken}` })).statusCode).toBe(404);
    expect((await app.inject({ url: `/t/${token.slice(0, -2)}AA` })).statusCode).toBe(404);
    expect(redactUrl(`/t/${token}?lang=en`)).toBe("/t/[token]?lang=en");
  });
});
