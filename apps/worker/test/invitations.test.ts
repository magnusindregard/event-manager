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

// Invitation and reminder emails (docs/registration.md, milestone 3), through the outbox
// and graphile-worker as in production.

let tdb: TestDatabase;
let db: Db;
let admin: pg.Client;
let ctx: ActorContext;
let mailer: FakeMailer;

async function drain() {
  for (let i = 0; i < 4; i++) {
    await admin.query(`update graphile_worker._private_jobs set run_at = now() where locked_at is null and run_at > now()`);
    await runOnce({
      connectionString: tdb.appUrl,
      taskList: buildTaskList(db, defaultHandlers, { directory: new FakeDirectory(), mailer, adminUrl: "https://admin.test/" }, { mailer, attendeeUrl: "https://attend.test/" }),
    });
  }
}

const run = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db, ctx, fn);
const DAY = 86_400_000;

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  admin = new pg.Client({ connectionString: tdb.superuserUrl });
  await admin.connect();
  const account = await tenancy.createAccount(db, { slug: "inv", name: "MUNCH", ownerEmail: "owner@munch.test", locales: ["nb", "en"] });
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

async function gala(settings: Partial<catalog.RegistrationSettings> = {}, startUtc = new Date(Date.now() + 14 * DAY)) {
  return run(async (tx) => {
    const venue = await catalog.createLocation(tx, ctx, { kind: "venue", name: "MUNCH", address: "Edvard Munchs plass 1" });
    let e = await catalog.createEvent(tx, ctx, {
      translations: { nb: { title: "Sommerfest" }, en: { title: "Summer party" } }, defaultLocationId: venue.id,
      admissionMode: "registration", registration: { accessPolicy: "invite_only", capacity: 100, guestAllowed: true, ...settings },
    });
    e = await catalog.transitionEvent(tx, ctx, e.id, e.version, "publish");
    const occ = await catalog.createOccurrence(tx, ctx, e.id, { startUtc });
    return { event: e, occ };
  });
}

describe("invitation emails", () => {
  it("sends each guest their personal link, logs the send and marks the guest as sent", async () => {
    const { event } = await gala();
    const kari = await run((tx) => registration.createInvitation(tx, ctx, event.id, { email: "kari@example.com", name: "Kari" }));
    await run((tx) => registration.createInvitation(tx, ctx, event.id, { email: "john@example.com", locale: "en", guestAllowed: false }));
    await run((tx) => registration.requestSends(tx, ctx, event.id, { kind: "invitation" }));
    await drain();

    expect(mailer.sent.map((m) => [m.to, m.subject])).toEqual([
      ["kari@example.com", "Invitasjon: Sommerfest"],
      ["john@example.com", "You're invited: Summer party"],
    ]);
    const nb = mailer.sent[0]!;
    expect(nb.text).toContain("Hei Kari,");
    expect(nb.text).toContain("MUNCH inviterer deg til Sommerfest.");
    expect(nb.text).toContain("Du kan ta med en gjest.");
    expect(nb.html).toContain("Svar på invitasjonen");
    expect(mailer.sent[1]!.text).not.toContain("bring a guest");
    const token = /https:\/\/attend\.test\/i\/([A-Za-z0-9_-]{72})/.exec(nb.text)![1]!;
    expect((await run((tx) => registration.invitationByToken(tx, token)))?.id).toBe(kari.id);

    const sends = await run((tx) => tx.selectFrom("registration.invitation_send").select(["id", "message_id", "delivery_status", "sent_at"]).where("invitation_id", "=", kari.id).execute());
    expect(sends).toEqual([expect.objectContaining({ delivery_status: "sent", message_id: "fake-1" })]);
    expect(nb.metadata).toEqual({ tenantId: ctx.tenantId, sendId: sends[0]!.id });
    expect((await run((tx) => registration.getInvitation(tx, kari.id))).status).toBe("sent");
    const events = await run((tx) => tx.selectFrom("outbox.event").select("type").where("subject", "=", `invitation/${kari.id}`).execute());
    expect(events.map((e) => e.type)).toEqual(["invitation.sent.v1"]);

    // Running the jobs again sends nothing more.
    await drain();
    expect(mailer.sent).toHaveLength(2);
  });

  it("reminds guests who have not answered", async () => {
    const { event } = await gala();
    await run((tx) => registration.createInvitation(tx, ctx, event.id, { email: "slow@example.com" }));
    await run((tx) => registration.requestSends(tx, ctx, event.id, { kind: "invitation" }));
    await drain();
    await run((tx) => registration.requestSends(tx, ctx, event.id, { kind: "reminder" }));
    await drain();
    expect(mailer.sent.map((m) => m.subject)).toEqual(["Invitasjon: Sommerfest", "Påminnelse: Invitasjon til Sommerfest"]);
    expect(mailer.sent[1]!.text).toContain("Hei,");
    expect(mailer.sent[1]!.text).toContain("Vi har ikke fått svar fra deg ennå.");
  });

  it("does not send to a guest who answered before the job ran", async () => {
    const { event, occ } = await gala();
    const inv = await run((tx) => registration.createInvitation(tx, ctx, event.id, { email: "quick@example.com", name: "Quick" }));
    await run(async (tx) => {
      await registration.requestSends(tx, ctx, event.id, { kind: "invitation" });
      await registration.acceptInvitation(tx, ctx.tenantId, inv.id, { occurrenceId: occ.id });
    });
    await drain();
    // Only the registration confirmation goes out.
    expect(mailer.sent.map((m) => m.subject)).toEqual(["Påmeldt: Sommerfest"]);
    const send = await run((tx) => tx.selectFrom("registration.invitation_send").select(["delivery_status", "delivery_detail"]).where("invitation_id", "=", inv.id).executeTakeFirstOrThrow());
    expect(send).toEqual({ delivery_status: "failed", delivery_detail: "guest_accepted" });
  });
});

describe("reminder before the event", () => {
  it("is scheduled for the reminder time and sent once, with the QR code", async () => {
    const { occ } = await gala({ accessPolicy: "open", reminderMinBefore: 24 * 60 });
    const reg = await run((tx) => registration.register(tx, ctx.tenantId, occ.id, { name: "Rita", email: "rita@example.com" }, { kind: "attendee" }));
    await drain();
    // The job ran early (drain moves it), rescheduled itself and sent nothing.
    expect(mailer.sent.map((m) => m.subject)).toEqual(["Påmeldt: Sommerfest"]);
    const job = await admin.query<{ run_at: Date }>(`select run_at from graphile_worker._private_jobs j join graphile_worker._private_tasks t on t.id = j.task_id where t.identifier = 'registration.reminder' and j.key = $1`, [`reminder:${reg.id}`]);
    expect(job.rows[0]!.run_at.getTime()).toBe(occ.startUtc.getTime() - DAY);

    // The occurrence moves to 12 hours from now: the reminder is due at once.
    await admin.query(`update registration.registration set created_at = now() - interval '2 days' where id = $1`, [reg.id]);
    const o = await run((tx) => catalog.getOccurrence(tx, occ.id));
    await run((tx) => catalog.updateOccurrence(tx, ctx, occ.id, o.version, { startUtc: new Date(Date.now() + DAY / 2), endUtc: new Date(Date.now() + DAY / 2 + 3_600_000) }));
    mailer.sent.length = 0;
    await drain();
    const reminder = mailer.sent.find((m) => m.subject === "Påminnelse: Sommerfest")!;
    expect(reminder).toBeDefined();
    expect(reminder.to).toBe("rita@example.com");
    expect(reminder.attachments?.[0]).toMatchObject({ contentId: "qr" });
    expect(reminder.text).toContain("https://attend.test/m/");
    expect((await run((tx) => registration.getRegistration(tx, reg.id))).remindedAt).not.toBeNull();

    // Moving it again does not send a second reminder.
    const o2 = await run((tx) => catalog.getOccurrence(tx, occ.id));
    await run((tx) => catalog.updateOccurrence(tx, ctx, occ.id, o2.version, { startUtc: new Date(Date.now() + DAY / 3), endUtc: new Date(Date.now() + DAY / 3 + 3_600_000) }));
    mailer.sent.length = 0;
    await drain();
    expect(mailer.sent.filter((m) => m.subject.startsWith("Påminnelse"))).toHaveLength(0);
  });

  it("sends nothing for events without a reminder", async () => {
    const { occ } = await gala({ accessPolicy: "open" });
    const reg = await run((tx) => registration.register(tx, ctx.tenantId, occ.id, { name: "N", email: "n@example.com" }, { kind: "attendee" }));
    await drain();
    const jobs = await admin.query(`select 1 from graphile_worker._private_jobs where key = $1`, [`reminder:${reg.id}`]);
    expect(mailer.sent.map((m) => m.subject)).toEqual(["Påmeldt: Sommerfest"]);
    expect(jobs.rowCount).toBe(0);
  });
});
