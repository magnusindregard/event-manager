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
import { OFFER_EXPIRY_TASK, offerExpiryTask } from "../src/waitlist.js";

// Waitlist emails and jobs (docs/registration.md, milestone 5).

let tdb: TestDatabase;
let db: Db;
let admin: pg.Client;
let ctx: ActorContext;
let mailer: FakeMailer;
const attendee = { kind: "attendee" } as const;

async function drain(clock?: () => Date) {
  for (let i = 0; i < 4; i++) {
    await admin.query(`update graphile_worker._private_jobs set run_at = now() where locked_at is null`);
    const tasks = buildTaskList(db, defaultHandlers, { directory: new FakeDirectory(), mailer, adminUrl: "https://admin.test/" }, { mailer, attendeeUrl: "https://attend.test/" });
    if (clock) tasks[OFFER_EXPIRY_TASK] = offerExpiryTask(db, clock);
    await runOnce({ connectionString: tdb.appUrl, taskList: tasks });
  }
}

const run = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db, ctx, fn);
const get = (id: string) => run((tx) => registration.getRegistration(tx, id));

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  admin = new pg.Client({ connectionString: tdb.superuserUrl });
  await admin.connect();
  const account = await tenancy.createAccount(db, { slug: "wait", name: "MUNCH", ownerEmail: "owner@munch.test", locales: ["nb", "en"] });
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

async function fullOccurrence(capacity = 1) {
  const occ = await run(async (tx) => {
    let e = await catalog.createEvent(tx, ctx, {
      translations: { nb: { title: "Kveldsomvisning" }, en: { title: "Evening tour" } },
      admissionMode: "registration", registration: { capacity, waitlistEnabled: true, claimWindowMin: 60 },
    });
    e = await catalog.transitionEvent(tx, ctx, e.id, e.version, "publish");
    return catalog.createOccurrence(tx, ctx, e.id, { startUtc: new Date(Date.now() + 7 * 86_400_000) });
  });
  const regs: registration.Registration[] = [];
  for (let i = 0; i < capacity; i++) regs.push(await run((tx) => registration.register(tx, ctx.tenantId, occ.id, { name: `Kari ${i}`, email: `kari${i}-${occ.id}@example.com` }, attendee)));
  return { occ, regs };
}

describe("waitlist emails", () => {
  it("tells the attendee their place in line, then offers the place with a deadline, then confirms the claim with a QR code", async () => {
    const { occ, regs } = await fullOccurrence();
    const a = await run((tx) => registration.register(tx, ctx.tenantId, occ.id, { name: "Ola", email: "ola@example.com" }, attendee));
    await run((tx) => registration.register(tx, ctx.tenantId, occ.id, { name: "Per", email: "per@example.com", locale: "en" }, attendee));
    await drain();
    const waiting = mailer.sent.filter((m) => m.to !== regs[0]!.email);
    expect(waiting.map((m) => [m.to, m.subject])).toEqual(expect.arrayContaining([
      ["ola@example.com", "På venteliste: Kveldsomvisning"],
      ["per@example.com", "On the waitlist: Evening tour"],
    ]));
    expect(waiting.find((m) => m.to === "ola@example.com")!.text).toContain("som nummer 1");
    expect(waiting.find((m) => m.to === "per@example.com")!.text).toContain("as number 2");
    expect(waiting.every((m) => !m.attachments)).toBe(true);

    mailer = new FakeMailer();
    await run((tx) => registration.cancelRegistration(tx, ctx.tenantId, regs[0]!.id, attendee));
    await drain();
    const offer = mailer.sent.find((m) => m.to === "ola@example.com")!;
    expect(offer.subject).toBe("Ledig plass: Kveldsomvisning");
    expect(offer.attachments).toBeUndefined();
    const token = /https:\/\/attend\.test\/m\/([A-Za-z0-9_-]{72})/.exec(offer.text)![1]!;
    expect((await run((tx) => registration.registrationByToken(tx, token)))?.id).toBe(a.id);
    // The expiry job is scheduled for the deadline; run early, it leaves the offer alone.
    const reg = await get(a.id);
    const job = await admin.query(`select run_at from graphile_worker._private_jobs where key = $1`, [`offer:${a.id}`]);
    expect(job.rows).toHaveLength(1);
    expect(reg.status).toBe("offered");

    mailer = new FakeMailer();
    await run((tx) => registration.claimOffer(tx, ctx.tenantId, a.id));
    await drain();
    const confirmed = mailer.sent.find((m) => m.to === "ola@example.com")!;
    expect(confirmed.subject).toBe("Påmeldt: Kveldsomvisning");
    expect(confirmed.attachments?.[0]).toMatchObject({ contentId: "qr" });
  });

  it("ends an unclaimed offer at its deadline, tells the attendee and offers the place to the next", async () => {
    const { occ, regs } = await fullOccurrence();
    const a = await run((tx) => registration.register(tx, ctx.tenantId, occ.id, { name: "Ola", email: "ola2@example.com" }, attendee));
    const b = await run((tx) => registration.register(tx, ctx.tenantId, occ.id, { name: "Per", email: "per2@example.com" }, attendee));
    await run((tx) => registration.cancelRegistration(tx, ctx.tenantId, regs[0]!.id, attendee));
    await drain();
    expect((await get(a.id)).status).toBe("offered");

    mailer = new FakeMailer();
    await drain(() => new Date(Date.now() + 2 * 3_600_000));
    expect(await get(a.id)).toMatchObject({ status: "cancelled", cancelledBy: "expired" });
    expect((await get(b.id)).status).toBe("offered");
    expect(mailer.sent.find((m) => m.to === "ola2@example.com")?.subject).toBe("Fristen gikk ut: Kveldsomvisning");
    expect(mailer.sent.find((m) => m.to === "per2@example.com")?.subject).toBe("Ledig plass: Kveldsomvisning");
  });

  it("promotes the line when capacity grows, and says goodbye to someone who leaves it", async () => {
    const { occ } = await fullOccurrence();
    const a = await run((tx) => registration.register(tx, ctx.tenantId, occ.id, { name: "Ola", email: "ola3@example.com" }, attendee));
    const b = await run((tx) => registration.register(tx, ctx.tenantId, occ.id, { name: "Per", email: "per3@example.com" }, attendee));
    const o = await run((tx) => catalog.getOccurrence(tx, occ.id));
    await run((tx) => catalog.updateOccurrence(tx, ctx, o.id, o.version, { capacityOverride: 2 }));
    await drain();
    expect((await get(a.id)).status).toBe("offered");

    mailer = new FakeMailer();
    await run((tx) => registration.cancelRegistration(tx, ctx.tenantId, b.id, attendee));
    await drain();
    expect(mailer.sent.map((m) => [m.to, m.subject])).toEqual([["per3@example.com", "Avmeldt venteliste: Kveldsomvisning"]]);
  });
});
