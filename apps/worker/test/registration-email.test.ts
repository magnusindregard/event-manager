import pg from "pg";
import { runOnce } from "graphile-worker";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { type ActorContext, catalog, registration, tenancy } from "@event-manager/domain";
import { defaultHandlers } from "../src/handlers.js";
import { FakeDirectory } from "../src/identity/directory.js";
import { FakeMailer } from "../src/identity/mailer.js";
import { buildTaskList } from "../src/tasks.js";

let tdb: TestDatabase;
let db: Db;
let admin: pg.Client;
let ctx: ActorContext;
let mailer: FakeMailer;
const attendee = { kind: "attendee" } as const;

async function drain() {
  for (let i = 0; i < 4; i++) {
    await admin.query(`update graphile_worker._private_jobs set run_at = now() where locked_at is null`);
    await runOnce({
      connectionString: tdb.appUrl,
      taskList: buildTaskList(db, defaultHandlers, { directory: new FakeDirectory(), mailer, adminUrl: "https://admin.test/" }, { mailer, attendeeUrl: "https://attend.test/" }),
    });
  }
}

const run = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db, ctx, fn);

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  admin = new pg.Client({ connectionString: tdb.superuserUrl });
  await admin.connect();
  const account = await tenancy.createAccount(db, { slug: "mail", name: "MUNCH", ownerEmail: "owner@munch.test", locales: ["nb", "en"] });
  const userId = await tenancy.login(db, { issuer: "t", subject: "o", email: "owner@munch.test", name: null });
  ctx = { tenantId: account.id, userId, clientId: null, roles: ["owner"] };
  await drain();
});
beforeEach(() => {
  mailer = new FakeMailer();
});
afterAll(async () => {
  await db?.destroy();
  await admin?.end();
  await tdb?.stop();
});

async function occurrence() {
  return run(async (tx) => {
    const venue = await catalog.createLocation(tx, ctx, { kind: "venue", name: "MUNCH", address: "Edvard Munchs plass 1" });
    let e = await catalog.createEvent(tx, ctx, {
      translations: { nb: { title: "Kveldsomvisning" }, en: { title: "Evening tour" } }, defaultLocationId: venue.id,
      admissionMode: "registration", registration: { capacity: 10, guestAllowed: true },
    });
    e = await catalog.transitionEvent(tx, ctx, e.id, e.version, "publish");
    return catalog.createOccurrence(tx, ctx, e.id, { startUtc: new Date(Date.now() + 7 * 86_400_000) });
  });
}

describe("registration emails", () => {
  it("confirms with a QR code and a manage link, in the attendee's locale", async () => {
    const occ = await occurrence();
    const reg = await run((tx) => registration.register(tx, ctx.tenantId, occ.id, { name: "Kari", email: "kari@example.com", partySize: 2 }, attendee));
    await drain();
    expect(mailer.sent).toHaveLength(1);
    const m = mailer.sent[0]!;
    expect(m.to).toBe("kari@example.com");
    expect(m.subject).toBe("Påmeldt: Kveldsomvisning");
    expect(m.text).toContain("2 personer");
    expect(m.text).toContain("MUNCH");
    expect(m.html).toContain('src="cid:qr"');
    expect(m.attachments?.[0]).toMatchObject({ name: "qr.png", contentType: "image/png", contentId: "qr" });
    expect(Buffer.from(m.attachments![0]!.content, "base64").subarray(1, 4).toString()).toBe("PNG");

    // The link in the email opens this registration.
    const token = /https:\/\/attend\.test\/m\/([A-Za-z0-9_-]{72})/.exec(m.text)![1]!;
    expect((await run((tx) => registration.registrationByToken(tx, token)))?.id).toBe(reg.id);
  });

  it("sends change and cancellation emails, in English for an English registration", async () => {
    const occ = await occurrence();
    const reg = await run((tx) => registration.register(tx, ctx.tenantId, occ.id, { name: "Ola", email: "ola@example.com", locale: "en" }, attendee));
    await drain();
    await run((tx) => registration.updateRegistration(tx, ctx.tenantId, reg.id, { partySize: 2 }, attendee));
    await drain();
    await run((tx) => registration.cancelRegistration(tx, ctx.tenantId, reg.id, attendee));
    await drain();
    expect(mailer.sent.map((m) => m.subject)).toEqual(["Registered: Evening tour", "Registration changed: Evening tour", "Cancelled: Evening tour"]);
    expect(mailer.sent[1]!.text).toContain("2 people");
    expect(mailer.sent[2]!.attachments).toBeUndefined();
  });

  it("does not confirm a registration that was cancelled before the email went out", async () => {
    const occ = await occurrence();
    const reg = await run((tx) => registration.register(tx, ctx.tenantId, occ.id, { name: "Siv", email: "siv@example.com" }, attendee));
    await run((tx) => registration.cancelRegistration(tx, ctx.tenantId, reg.id, attendee));
    await drain();
    expect(mailer.sent.map((m) => m.subject)).toEqual(["Avbestilt: Kveldsomvisning"]);
  });
});
