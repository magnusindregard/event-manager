import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, type Tx, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { type ActorContext, catalog, DomainError, registration, tenancy } from "../../src/index.js";

// Registration milestone 3 (docs/registration.md): guest invitations, guest list import,
// sending, personal links, accepting and declining, and unlisted events.

let tdb: TestDatabase;
let db: Db;
let ctx: ActorContext;

const run = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(db, ctx, fn);
const title = (t: string) => ({ nb: { title: t }, en: { title: `${t} (en)` } });
const NOW = new Date("2027-02-01T12:00:00Z");
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof DomainError ? e.code : String(e)));

async function gala(settings: Partial<catalog.RegistrationSettings> = {}, starts = [new Date("2027-03-01T17:00:00Z")], publish = true) {
  const event = await run(async (tx) => {
    const e = await catalog.createEvent(tx, ctx, { translations: title("Galla"), admissionMode: "registration", registration: { accessPolicy: "invite_only", capacity: 120, ...settings } });
    return publish ? catalog.transitionEvent(tx, ctx, e.id, e.version, "publish") : e;
  });
  const occs = [];
  for (const startUtc of starts) occs.push(await run((tx) => catalog.createOccurrence(tx, ctx, event.id, { startUtc })));
  return { event, occs };
}

async function xlsx(rows: (string | number)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Kontakter");
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const guestRows = (from: number, to: number, guestEvery = 5) =>
  Array.from({ length: to - from }, (_, k) => {
    const i = from + k;
    return [`Gjest ${i}`, `Etter${i}`, `gjest${i}@example.com`, i % guestEvery === 0 ? "Ja" : "Nei", `crm-${i}`];
  });
const HEADER = ["Fornavn", "Etternavn", "E-post", "Ledsager", "Kontakt-ID"];

async function importFile(eventId: string, fileName: string, content: Buffer) {
  const draft = await run((tx) => registration.stageImport(tx, ctx, eventId, { fileName, content }));
  const preview = await run((tx) => registration.previewImport(tx, ctx, draft.id, draft.mapping));
  const result = await run((tx) => registration.commitImport(tx, ctx, draft.id, draft.mapping));
  return { draft, preview, result };
}

async function invite(eventId: string, email: string, extra: Partial<registration.InvitationInput> = {}) {
  return run((tx) => registration.createInvitation(tx, ctx, eventId, { email, ...extra }));
}
const tokenOf = (inv: registration.GuestInvitation) => run((tx) => registration.invitationToken(tx, ctx.tenantId, inv));
const byToken = (token: string) => run((tx) => registration.invitationByToken(tx, token));

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl, { max: 10 });
  const account = await tenancy.createAccount(db, { slug: "invitations", name: "Invitations", ownerEmail: "owner@invitations.test" });
  const userId = await tenancy.login(db, { issuer: "https://idp.test", subject: "owner@invitations.test", email: "owner@invitations.test", name: null });
  ctx = { tenantId: account.id, userId, clientId: null, roles: ["owner"] };
});
afterAll(async () => {
  await db?.destroy();
  await tdb?.stop();
});

describe("acceptance: a gala with 120 places and 150 guests imported from XLSX", () => {
  it("imports 150 guests, 30 of them allowed a guest, and a re-import with 10 new rows adds exactly 10", async () => {
    const { event } = await gala();
    const first = await importFile(event.id, "gjester.xlsx", await xlsx([HEADER, ...guestRows(0, 150)]));
    expect(first.draft.mapping).toEqual({ firstName: 0, lastName: 1, email: 2, guestAllowed: 3, externalContactId: 4 });
    expect(first.preview).toMatchObject({ rowCount: 150, added: 150, updated: 0, errors: [], missing: [] });
    expect(first.result).toMatchObject({ added: 150, updated: 0, skipped: 0 });

    const list = await run((tx) => registration.listInvitations(tx, ctx, event.id));
    expect(list.counts).toMatchObject({ total: 150, pending: 150 });
    expect(list.items.filter((i) => i.guestAllowed === true)).toHaveLength(30);
    expect(list.items[0]).toMatchObject({ name: "Gjest 0 Etter0", email: "gjest0@example.com", externalContactId: "crm-0", status: "pending" });

    const second = await importFile(event.id, "gjester-v2.xlsx", await xlsx([HEADER, ...guestRows(0, 160)]));
    expect(second.result).toMatchObject({ added: 10, updated: 0, unchanged: 150, skipped: 0, missing: [] });
    expect((await run((tx) => registration.listInvitations(tx, ctx, event.id))).counts.total).toBe(160);
  });

  it("updates changed rows, lists guests missing from the file without removing them, and keeps accepted guests", async () => {
    const { event, occs } = await gala();
    await importFile(event.id, "a.xlsx", await xlsx([HEADER, ...guestRows(0, 5)]));
    const accepted = (await run((tx) => registration.listInvitations(tx, ctx, event.id))).items.find((i) => i.email === "gjest4@example.com")!;
    await run((tx) => registration.acceptInvitation(tx, ctx.tenantId, accepted.id, { occurrenceId: occs[0]!.id }, NOW));

    const rows = guestRows(0, 2);
    rows[0]![0] = "Endret";
    const { preview, result } = await importFile(event.id, "b.xlsx", await xlsx([HEADER, ...rows]));
    expect(preview).toMatchObject({ added: 0, updated: 1, unchanged: 1 });
    expect(result.missing.map((m) => [m.email, m.removable])).toEqual([
      ["gjest2@example.com", true], ["gjest3@example.com", true], ["gjest4@example.com", false],
    ]);
    const after = await run((tx) => registration.listInvitations(tx, ctx, event.id));
    expect(after.counts.total).toBe(5);
    expect(after.items.find((i) => i.email === "gjest0@example.com")!.name).toBe("Endret Etter0");

    const ids = result.missing.map((m) => m.id);
    const removed = await run((tx) => registration.removeInvitations(tx, ctx, event.id, ids));
    expect(removed.removed).toHaveLength(2);
    expect(removed.blocked).toEqual([accepted.id]);
    expect((await run((tx) => registration.listInvitations(tx, ctx, event.id))).counts).toMatchObject({ total: 3, accepted: 1 });
  });
});

describe("guest list files", () => {
  it("reads semicolon CSV from Excel in Windows-1252, with quotes and a BOM", () => {
    const text = '﻿Navn;E-post;Merknad\r\n"Ås, Kari";kari@example.com;"sier ""hei"""\r\nOla;ola@example.com;\r\n';
    expect(registration.parseCsv(text)).toEqual([["Navn", "E-post", "Merknad"], ["Ås, Kari", "kari@example.com", 'sier "hei"'], ["Ola", "ola@example.com", ""]]);
    const latin = Buffer.from([0x4e, 0xe6, 0x72, 0x3b, 0x78]); // "Nær;x" in Windows-1252
    expect(registration.decodeText(latin)).toBe("Nær;x");
  });

  it("reports row errors and skips those rows", async () => {
    const { event } = await gala();
    const csv = Buffer.from(["E-post,Navn,Gjest,Språk", "ok@example.com,A,ja,en", "ikke-epost,B,,", ",C,,", "OK@example.com,D,,", "x@example.com,E,kanskje,", "y@example.com,F,,klingon"].join("\n"));
    const draft = await run((tx) => registration.stageImport(tx, ctx, event.id, { fileName: "liste.csv", content: csv }));
    expect(draft.mapping).toEqual({ email: 0, name: 1, guestAllowed: 2, locale: 3 });
    const preview = await run((tx) => registration.previewImport(tx, ctx, draft.id, draft.mapping));
    expect(preview.errors.map((e) => [e.line, e.code])).toEqual([
      [3, "invalid_email"], [4, "missing_email"], [5, "duplicate_email"], [6, "invalid_guest_allowed"], [7, "invalid_locale"],
    ]);
    const result = await run((tx) => registration.commitImport(tx, ctx, draft.id, draft.mapping));
    expect(result).toMatchObject({ added: 1, skipped: 5 });
    const [g] = (await run((tx) => registration.listInvitations(tx, ctx, event.id))).items;
    expect(g).toMatchObject({ email: "ok@example.com", name: "A", guestAllowed: true, locale: "en" });
    // The staged file is gone after the import.
    expect(await code(run((tx) => registration.previewImport(tx, ctx, draft.id, draft.mapping)))).toBe("not_found");
  });

  it("remembers the account's column mapping by header", async () => {
    const { event } = await gala();
    const csv = (rows: string[]) => Buffer.from(rows.join("\n"));
    const d1 = await run((tx) => registration.stageImport(tx, ctx, event.id, { fileName: "a.csv", content: csv(["Adresse;Hvem;Annet", "a@example.com;A;x"]) }));
    expect(d1.mapping.email).toBeUndefined();
    await run((tx) => registration.commitImport(tx, ctx, d1.id, { email: 0, name: 1 }));
    const d2 = await run((tx) => registration.stageImport(tx, ctx, event.id, { fileName: "b.csv", content: csv(["Annet;Hvem;Adresse", "x;B;b@example.com"]) }));
    expect(d2.mapping).toEqual({ email: 2, name: 1 });
  });

  it("rejects mappings without an email column and old .xls files", async () => {
    const { event } = await gala();
    const d = await run((tx) => registration.stageImport(tx, ctx, event.id, { fileName: "a.csv", content: Buffer.from("E-post\na@example.com") }));
    expect(await code(run((tx) => registration.previewImport(tx, ctx, d.id, {})))).toBe("validation_failed");
    expect(await code(run((tx) => registration.stageImport(tx, ctx, event.id, { fileName: "gammel.xls", content: Buffer.from("not really") })))).toBe("validation_failed");
  });
});

describe("accepting and declining", () => {
  it("accepts with a guest and a chosen occurrence; the registration comes from the invitation", async () => {
    const { event, occs } = await gala({}, [new Date("2027-03-01T17:00:00Z"), new Date("2027-03-02T17:00:00Z")]);
    const inv = await invite(event.id, "Kari@Example.com", { name: "Kari", guestAllowed: true });
    const reg = await run((tx) => registration.acceptInvitation(tx, ctx.tenantId, inv.id, { occurrenceId: occs[1]!.id, partySize: 2 }, NOW));
    expect(reg).toMatchObject({ email: "kari@example.com", name: "Kari", partySize: 2, source: "invitation", invitationId: inv.id, occurrenceId: occs[1]!.id });
    expect((await run((tx) => catalog.getOccurrence(tx, occs[1]!.id))).pool).toMatchObject({ taken: 2 });
    const after = (await run((tx) => registration.listInvitations(tx, ctx, event.id))).items[0]!;
    expect(after).toMatchObject({ status: "accepted", registration: { id: reg.id, partySize: 2 } });
    expect(await code(run((tx) => registration.acceptInvitation(tx, ctx.tenantId, inv.id, { occurrenceId: occs[0]!.id }, NOW)))).toBe("already_registered");
  });

  it("follows the guest allowance of the invitation over the event's", async () => {
    const { event, occs } = await gala({ guestAllowed: true });
    const no = await invite(event.id, "no@example.com", { name: "No", guestAllowed: false });
    expect(await code(run((tx) => registration.acceptInvitation(tx, ctx.tenantId, no.id, { occurrenceId: occs[0]!.id, partySize: 2 }, NOW)))).toBe("validation_failed");
    const { event: e2, occs: o2 } = await gala({ guestAllowed: false });
    const yes = await invite(e2.id, "yes@example.com", { name: "Yes", guestAllowed: true });
    const reg = await run((tx) => registration.acceptInvitation(tx, ctx.tenantId, yes.id, { occurrenceId: o2[0]!.id }, NOW));
    // The guest can be added later too, since the invitation allows it.
    const changed = await run((tx) => registration.updateRegistration(tx, ctx.tenantId, reg.id, { partySize: 2 }, { kind: "attendee" }, { now: NOW }));
    expect(changed.partySize).toBe(2);
  });

  it("needs a name when the list has none, an occurrence of the same event, and a place", async () => {
    const { event, occs } = await gala({ capacity: 1 });
    const other = await gala();
    const inv = await invite(event.id, "anon@example.com");
    expect(await code(run((tx) => registration.acceptInvitation(tx, ctx.tenantId, inv.id, { occurrenceId: occs[0]!.id }, NOW)))).toBe("validation_failed");
    expect(await code(run((tx) => registration.acceptInvitation(tx, ctx.tenantId, inv.id, { occurrenceId: other.occs[0]!.id, name: "Anon" }, NOW)))).toBe("not_found");
    await run((tx) => registration.register(tx, ctx.tenantId, occs[0]!.id, { name: "Staff add", email: "s@example.com" }, { kind: "staff", ctx }, NOW));
    expect(await code(run((tx) => registration.acceptInvitation(tx, ctx.tenantId, inv.id, { occurrenceId: occs[0]!.id, name: "Anon" }, NOW)))).toBe("full");
    expect(await code(run((tx) => registration.acceptInvitation(tx, ctx.tenantId, inv.id, { occurrenceId: occs[0]!.id, name: "Anon" }, new Date("2027-03-02T00:00:00Z"))))).toBe("registration_closed");
  });

  it("declines, and lets the guest change their mind; cancelling an accepted registration counts as declining", async () => {
    const { event, occs } = await gala();
    const inv = await invite(event.id, "maybe@example.com", { name: "Maybe" });
    const declined = await run((tx) => registration.declineInvitation(tx, ctx.tenantId, inv.id, NOW));
    expect(declined).toMatchObject({ status: "declined" });
    const ev = await run((tx) => tx.selectFrom("outbox.event").select(["type"]).where("subject", "=", `invitation/${inv.id}`).execute());
    expect(ev.map((e) => e.type)).toEqual(["invitation.declined.v1"]);

    const reg = await run((tx) => registration.acceptInvitation(tx, ctx.tenantId, inv.id, { occurrenceId: occs[0]!.id }, NOW));
    expect(await code(run((tx) => registration.declineInvitation(tx, ctx.tenantId, inv.id, NOW)))).toBe("already_registered");
    await run((tx) => registration.cancelRegistration(tx, ctx.tenantId, reg.id, { kind: "attendee" }, NOW));
    expect((await run((tx) => registration.getInvitation(tx, inv.id))).status).toBe("declined");
    expect(await code(run((tx) => registration.acceptInvitation(tx, ctx.tenantId, inv.id, { occurrenceId: occs[0]!.id }, NOW)))).toBe("ok");
  });

  it("still needs an invitation for open registration on invite-only events", async () => {
    const { occs } = await gala();
    expect(await code(run((tx) => registration.register(tx, ctx.tenantId, occs[0]!.id, { name: "X", email: "x@example.com" }, { kind: "attendee" }, NOW)))).toBe("invitation_required");
  });
});

describe("personal links", () => {
  it("finds the invitation by its link until the link is rotated", async () => {
    const { event } = await gala();
    const inv = await invite(event.id, "link@example.com");
    const token = await tokenOf(inv);
    expect(token).toMatch(/^[A-Za-z0-9_-]{72}$/);
    expect((await byToken(token))?.id).toBe(inv.id);
    // An invitation token is not a manage token, and vice versa.
    expect(await run((tx) => registration.registrationByToken(tx, token))).toBeNull();
    const rotated = await run((tx) => registration.rotateInvitationLink(tx, ctx, inv.id));
    expect(await byToken(token)).toBeNull();
    expect((await byToken(await tokenOf(rotated)))?.id).toBe(inv.id);
  });

  it("exports every guest's link and marks guests sent from the client's own tool", async () => {
    const { event } = await gala();
    const a = await invite(event.id, "a@example.com", { externalContactId: "c-1" });
    await invite(event.id, "b@example.com");
    const links = await run((tx) => registration.invitationLinks(tx, ctx, event.id));
    expect(links.map((l) => [l.email, l.externalContactId])).toEqual([["a@example.com", "c-1"], ["b@example.com", null]]);
    expect((await byToken(links[0]!.token))?.id).toBe(a.id);
    expect(await run((tx) => registration.markSentExternally(tx, ctx, event.id, [a.id], NOW))).toEqual({ marked: 1 });
    const g = (await run((tx) => registration.listInvitations(tx, ctx, event.id))).items.find((i) => i.id === a.id)!;
    expect(g).toMatchObject({ status: "sent", lastSend: { deliveryStatus: "sent", deliveryDetail: "external" } });
  });
});

describe("sending", () => {
  it("needs a published event", async () => {
    const { event } = await gala({}, undefined, false);
    await invite(event.id, "draft@example.com");
    expect(await code(run((tx) => registration.requestSends(tx, ctx, event.id, { kind: "invitation" })))).toBe("conflict");
  });

  it("sends invitations to unsent guests, reminders to those without an answer, and logs every send", async () => {
    const { event, occs } = await gala();
    const a = await invite(event.id, "a@example.com", { name: "A" });
    const b = await invite(event.id, "b@example.com", { name: "B" });
    expect(await run((tx) => registration.requestSends(tx, ctx, event.id, { kind: "reminder" }))).toEqual({ queued: 0, skipped: 2 });
    expect(await run((tx) => registration.requestSends(tx, ctx, event.id, { kind: "invitation" }))).toEqual({ queued: 2, skipped: 0 });
    // Asking again while those are still queued sends no second copy, also when naming the guests.
    expect(await run((tx) => registration.requestSends(tx, ctx, event.id, { kind: "invitation", ids: [a.id, b.id] }))).toEqual({ queued: 0, skipped: 2 });
    const sends = await run((tx) => tx.selectFrom("registration.invitation_send").select(["id", "invitation_id", "kind", "delivery_status"]).where("invitation_id", "in", [a.id, b.id]).execute());
    expect(sends.map((s) => s.delivery_status)).toEqual(["queued", "queued"]);
    const evt = await run((tx) => tx.selectFrom("outbox.event").select(["type", "data"]).where("subject", "=", `event/${event.id}`).where("type", "=", "invitation.sends_requested.v1").executeTakeFirstOrThrow());
    expect((evt.data as { sendIds: string[] }).sendIds.sort()).toEqual(sends.map((s) => s.id).sort());

    // The worker's side: load, check, record.
    const sendA = sends.find((s) => s.invitation_id === a.id)!;
    const m = (await run((tx) => registration.loadInvitationMessage(tx, ctx.tenantId, sendA.id)))!;
    expect(m).toMatchObject({ locale: "nb", invitation: { email: "a@example.com" }, send: { kind: "invitation", sentAt: null } });
    expect(m.occurrences.map((o) => o.occurrence.id)).toEqual([occs[0]!.id]);
    expect(registration.shouldSend(m)).toBe(true);
    await run((tx) => registration.recordSent(tx, ctx.tenantId, sendA.id, "pm-1", NOW));
    await run((tx) => registration.recordSent(tx, ctx.tenantId, sendA.id, "pm-2", NOW)); // a retry does nothing
    expect(await run((tx) => registration.getInvitation(tx, a.id))).toMatchObject({ status: "sent", firstSentAt: NOW });
    expect(registration.shouldSend((await run((tx) => registration.loadInvitationMessage(tx, ctx.tenantId, sendA.id)))!)).toBe(false);

    // A guest who accepts before their email goes out does not get it.
    const sendB = sends.find((s) => s.invitation_id === b.id)!;
    await run((tx) => registration.acceptInvitation(tx, ctx.tenantId, b.id, { occurrenceId: occs[0]!.id }, NOW));
    expect(registration.shouldSend((await run((tx) => registration.loadInvitationMessage(tx, ctx.tenantId, sendB.id)))!)).toBe(false);

    // Reminders now go to A only; asking for everyone sends no new invitations.
    expect(await run((tx) => registration.requestSends(tx, ctx, event.id, { kind: "reminder" }))).toEqual({ queued: 1, skipped: 1 });
    expect(await run((tx) => registration.requestSends(tx, ctx, event.id, { kind: "invitation" }))).toEqual({ queued: 0, skipped: 2 });
    // Named guests get a resend, except those who answered.
    expect(await run((tx) => registration.requestSends(tx, ctx, event.id, { kind: "invitation", ids: [a.id, b.id] }))).toEqual({ queued: 1, skipped: 1 });
  });

  it("records delivery reports for the matching send only, and never downgrades a bounce", async () => {
    const { event } = await gala();
    const a = await invite(event.id, "bounce@example.com");
    await run((tx) => registration.requestSends(tx, ctx, event.id, { kind: "invitation" }));
    const send = await run((tx) => tx.selectFrom("registration.invitation_send").select("id").where("invitation_id", "=", a.id).executeTakeFirstOrThrow());
    await run((tx) => registration.recordSent(tx, ctx.tenantId, send.id, "pm-x", NOW));
    expect(await run((tx) => registration.recordDelivery(tx, send.id, "pm-other", "delivered", null, NOW))).toBe(false);
    expect(await run((tx) => registration.recordDelivery(tx, send.id, "pm-x", "bounced", "HardBounce: no such user", NOW))).toBe(true);
    await run((tx) => registration.recordDelivery(tx, send.id, "pm-x", "delivered", null, NOW));
    const list = await run((tx) => registration.listInvitations(tx, ctx, event.id));
    expect(list.items[0]!.lastSend).toMatchObject({ deliveryStatus: "bounced", deliveryDetail: "HardBounce: no such user" });
    expect(list.counts.undeliverable).toBe(1);
  });
});

describe("acceptance: an invite-only event is not listed", () => {
  it("is left out of public listings but found by slug or id", async () => {
    const { event } = await gala();
    expect(event.registration.listed).toBe(false);
    const opts = { preview: false, now: NOW };
    const occs = await run((tx) => catalog.listPublicOccurrences(tx, opts, { from: NOW, limit: 200 }));
    expect(occs.items.some((o) => o.event.id === event.id)).toBe(false);
    const events = await run((tx) => catalog.listPublicEvents(tx, opts, { limit: 200 }));
    expect(events.items.some((e) => e.id === event.id)).toBe(false);
    const bySlug = await run((tx) => catalog.listPublicOccurrences(tx, opts, { from: NOW, event: event.slug, limit: 10 }));
    expect(bySlug.items).toHaveLength(1);
    expect(bySlug.items[0]!.admission).toEqual({ mode: "registration", url: null });
  });
});

describe("reminder before the event", () => {
  it("is due the set time before start, once, and not for late registrations", async () => {
    const start = new Date("2027-03-01T17:00:00Z");
    const { occs } = await gala({ reminderMinBefore: 24 * 60, accessPolicy: "open" }, [start]);
    const early = await run((tx) => registration.register(tx, ctx.tenantId, occs[0]!.id, { name: "E", email: "e@example.com" }, { kind: "attendee" }, NOW));
    const plans = await run((tx) => registration.reminderTimes(tx, [early.id], NOW));
    expect(plans).toEqual([{ id: early.id, runAt: new Date("2027-02-28T17:00:00Z") }]);
    expect(await run((tx) => registration.markReminded(tx, early.id, NOW))).toBe(true);
    expect(await run((tx) => registration.markReminded(tx, early.id, NOW))).toBe(false);
    expect(await run((tx) => registration.reminderTimes(tx, [early.id], NOW))).toEqual([]);

    const target = await run((tx) => catalog.getRegistrationTarget(tx, occs[0]!.id));
    const late = { status: "confirmed" as const, remindedAt: null, createdAt: new Date("2027-03-01T10:00:00Z") };
    expect(registration.reminderTime(late, target, new Date("2027-03-01T10:00:00Z"))).toBeNull();
  });
});
