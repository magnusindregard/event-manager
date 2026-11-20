import pg from "pg";
import { runOnce } from "graphile-worker";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { type ActorContext, catalog, offers, sales, tenancy } from "@event-manager/domain";
import { defaultHandlers } from "../src/handlers.js";
import { FakeDirectory } from "../src/identity/directory.js";
import { FakeMailer } from "../src/identity/mailer.js";
import { runRetention } from "../src/retention.js";
import { buildTaskList } from "../src/tasks.js";

// Ticketing milestone 4: the tickets email for channels that have the platform send tickets,
// and buyers anonymised by the nightly retention job.

let tdb: TestDatabase;
let db: Db;
let admin: pg.Client;
let ctx: ActorContext;
let mailer: FakeMailer;
let occurrenceId: string;
let adultId: string;
let shop: sales.ChannelCaller;
let pos: sales.ChannelCaller;

async function drain() {
  for (let i = 0; i < 4; i++) {
    await admin.query(`update graphile_worker._private_jobs set run_at = now() where locked_at is null`);
    await runOnce({
      connectionString: tdb.appUrl,
      taskList: buildTaskList(db, defaultHandlers, { directory: new FakeDirectory(), mailer, adminUrl: "https://admin.test/" }, { mailer, attendeeUrl: "https://attend.test/" }),
    });
  }
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  admin = new pg.Client({ connectionString: tdb.superuserUrl });
  await admin.connect();
  mailer = new FakeMailer();
  const account = await tenancy.createAccount(db, { slug: "tix", name: "Teatret", ownerEmail: "owner@tix.test", locales: ["nb", "en"] });
  const userId = await tenancy.login(db, { issuer: "t", subject: "o", email: "owner@tix.test", name: null });
  ctx = { tenantId: account.id, userId, clientId: null, roles: ["owner"] };
  await withTenant(db, ctx, async (tx) => {
    const vat = await offers.createVatClass(tx, ctx, { code: "exempt", label: "Fritatt", ratePct: 0 });
    const web = await offers.createChannel(tx, ctx, { code: "web", name: "Nettbutikk", kind: "ecom", sendTickets: true });
    const desk = await offers.createChannel(tx, ctx, { code: "pos", name: "Luke", kind: "pos" });
    await offers.setSkuMapping(tx, ctx, vat.id, web.id, "T");
    await offers.setSkuMapping(tx, ctx, vat.id, desk.id, "L");
    const venue = await catalog.createLocation(tx, ctx, { kind: "venue", name: "Hovedscenen", address: "Karl Johans gate 1" });
    const event = await catalog.createEvent(tx, ctx, { translations: { nb: { title: "Hamlet" }, en: { title: "Hamlet (EN)" } }, admissionMode: "tickets", registration: { capacity: 50 }, defaultLocationId: venue.id });
    occurrenceId = (await catalog.createOccurrence(tx, ctx, event.id, { startUtc: new Date(Date.now() + 7 * 86_400_000) })).id;
    adultId = (await offers.createOffer(tx, ctx, event.id, { translations: { nb: { name: "Voksen" }, en: { name: "Adult" } }, vatClassId: vat.id, defaultPrice: 45000 })).offer!.id;
    await catalog.transitionEvent(tx, ctx, event.id, (await catalog.getEvent(tx, event.id)).version, "publish");
    shop = { tenantId: ctx.tenantId, channelId: web.id, signingKey: null };
    pos = { tenantId: ctx.tenantId, channelId: desk.id, signingKey: null };
  });
  await drain();
});
beforeEach(() => {
  mailer.sent.length = 0;
});
afterAll(async () => {
  await db?.destroy();
  await admin?.end();
  await tdb?.stop();
});

const sell = (caller: sales.ChannelCaller, quantity: number, order: string, buyer: sales.BuyerInput | null) =>
  withTenant(db, ctx, (tx) => sales.reserve(tx, caller, { lines: [{ occurrenceId, offerId: adultId, quantity }], confirm: true, externalOrderRef: order, buyer }));

describe("tickets email", () => {
  it("emails each ticket with its QR code and link, in the buyer's locale, once", async () => {
    const r = await sell(shop, 2, "ORDER-1", { name: "Kari", email: "kari@example.com", locale: "en" });
    await drain();
    await drain();
    expect(mailer.sent).toHaveLength(1);
    const m = mailer.sent[0]!;
    expect(m).toMatchObject({ to: "kari@example.com", subject: "Your tickets: Hamlet (EN)" });
    expect(m.text).toContain("Here are your 2 tickets for order ORDER-1");
    expect(m.text).toContain("Hovedscenen, Karl Johans gate 1");
    expect(m.attachments?.map((a) => a.contentId)).toEqual(["qr0", "qr1"]);
    for (const t of r.tickets) expect(m.text).toContain(`https://attend.test/t/${t.ticketToken}`);
    expect(m.html).not.toContain("<script");
  });

  it("sends nothing for channels that deliver tickets themselves, or without an email", async () => {
    await sell(pos, 1, "POS-1", { email: "walkup@example.com" });
    await sell(shop, 1, "ORDER-2", null);
    await drain();
    expect(mailer.sent).toEqual([]);
  });

  it("anonymises buyers in the nightly retention run", async () => {
    const r = await sell(shop, 1, "ORDER-3", { name: "Per", email: "per@example.com" });
    const later = new Date(Date.now() + 400 * 86_400_000);
    const run = await runRetention(db, later, () => {});
    expect(run.reservationsAnonymised).toBeGreaterThanOrEqual(1);
    const after = await withTenant(db, ctx, (tx) => sales.getReservationAsStaff(tx, ctx, r.id, later));
    expect(after).toMatchObject({ buyer: null, externalOrderRef: "ORDER-3" });
  });
});
