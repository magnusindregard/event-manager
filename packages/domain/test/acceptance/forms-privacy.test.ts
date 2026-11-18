import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, type Tx, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { type ActorContext, catalog, DomainError, registration, tenancy } from "../../src/index.js";

// Registration milestone 4 (docs/registration.md): form fields, sensitive answers encrypted
// per tenant, the guest-data permissions, the door list and retention.

let tdb: TestDatabase;
let db: Db;
let su: pg.Client;
let ctx: ActorContext;
let other: ActorContext;

const as = (roles: string[]): ActorContext => ({ ...ctx, roles });
const run = <T>(fn: (tx: Tx) => Promise<T>, c: ActorContext = ctx) => withTenant(db, c, fn);
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof DomainError ? `${e.code}${e.details?.field ? `:${String(e.details.field)}` : ""}` : String(e)));
const START = new Date("2027-03-01T17:00:00Z");
const NOW = new Date("2027-02-01T12:00:00Z");
const days = (n: number) => new Date(START.getTime() + 3 * 3_600_000 + n * 86_400_000);

const FORM: registration.FormFieldInput[] = [
  { id: "diet", type: "dietary", label: { nb: "Allergier og matbehov", en: "Dietary needs" }, help: { nb: "Vi sender dette til kjøkkenet" } },
  { id: "org", type: "text", label: { nb: "Organisasjon" }, required: true },
  { id: "photo", type: "checkbox", label: { nb: "Jeg kan bli fotografert" } },
  { id: "menu", type: "choice", label: { nb: "Hovedrett" }, options: [{ id: "fish", label: { nb: "Fisk" } }, { id: "veg", label: { nb: "Vegetar" } }] },
];

async function gala(c: ActorContext = ctx, form = FORM) {
  return run(async (tx) => {
    const e = await catalog.createEvent(tx, c, { translations: { nb: { title: "Galla" } }, admissionMode: "registration", registration: { accessPolicy: "invite_only", capacity: 120, guestAllowed: true } });
    const event = await catalog.transitionEvent(tx, c, e.id, e.version, "publish");
    const occ = await catalog.createOccurrence(tx, c, event.id, { startUtc: START });
    const saved = await registration.saveForm(tx, c, event.id, 0, form);
    return { event, occ, form: saved };
  }, c);
}

async function acceptWith(eventId: string, occurrenceId: string, email: string, input: Partial<registration.AcceptInput>) {
  const inv = await run((tx) => registration.createInvitation(tx, ctx, eventId, { email, name: "Kari Nordmann" }));
  const reg = await run((tx) => registration.acceptInvitation(tx, ctx.tenantId, inv.id, { occurrenceId, ...input }, NOW));
  return { inv, reg };
}

const answersOf = (id: string, reader: registration.AnswerReader) => run(async (tx) => (await registration.readAnswers(tx, ctx.tenantId, [id], reader)).get(id)!);
const retention = (now: Date, c: ActorContext = ctx) => run((tx) => registration.applyRetention(tx, now), c);

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl, { max: 10 });
  su = new pg.Client({ connectionString: tdb.superuserUrl });
  await su.connect();
  registration.configureMasterKeys(`k1:${Buffer.alloc(32, 7).toString("base64")}`);
  const a = await tenancy.createAccount(db, { slug: "forms", name: "Forms", ownerEmail: "owner@forms.test" });
  const userId = await tenancy.login(db, { issuer: "https://idp.test", subject: "owner@forms.test", email: "owner@forms.test", name: null });
  ctx = { tenantId: a.id, userId, clientId: null, roles: ["owner"] };
  const b = await tenancy.createAccount(db, { slug: "other", name: "Other", ownerEmail: "owner@other.test" });
  other = { tenantId: b.id, userId: null, clientId: null, roles: ["owner"] };
});
afterAll(async () => {
  await su?.end();
  await db?.destroy();
  await tdb?.stop();
});

describe("form builder", () => {
  it("saves versions, gives new fields ids, makes dietary sensitive and adds no version for an unchanged form", async () => {
    const { event, form } = await gala();
    expect(form.version).toBe(1);
    expect(form.fields.map((f) => [f.id, f.type, f.sensitive, f.multiline])).toEqual([
      ["diet", "dietary", true, true], ["org", "text", false, false], ["photo", "checkbox", false, false], ["menu", "choice", false, false],
    ]);
    const again = await run((tx) => registration.saveForm(tx, ctx, event.id, 1, form.fields));
    expect(again.version).toBe(1);
    const added = await run((tx) => registration.saveForm(tx, ctx, event.id, 1, [...form.fields, { type: "text", label: { nb: "Stilling" }, sensitive: true }]));
    expect(added.version).toBe(2);
    expect(added.fields[4]).toMatchObject({ type: "text", sensitive: true, id: expect.stringMatching(/^[a-z0-9]{12}$/) });
    expect(await code(run((tx) => registration.saveForm(tx, ctx, event.id, 1, [])))).toBe("version_conflict");
  });

  it("rejects bad forms", async () => {
    const { event } = await gala();
    const save = (fields: registration.FormFieldInput[]) => code(run((tx) => registration.saveForm(tx, ctx, event.id, 1, fields)));
    expect(await save([{ type: "dietary", label: { nb: "A" } }, { type: "dietary", label: { nb: "B" } }])).toBe("validation_failed:fields.1.type");
    expect(await save([{ type: "text", label: { en: "Only English" } }])).toBe("validation_failed:fields.0.label");
    expect(await save([{ type: "choice", label: { nb: "Valg" }, options: [] }])).toBe("validation_failed:fields.0.options");
    expect(await save([{ type: "text", label: { nb: "A", de: "B" } }])).toBe("validation_failed:fields.0.label.de");
  });

  it("is content: editors build the form, door staff cannot", async () => {
    const { event } = await gala();
    expect(await code(run((tx) => registration.saveForm(tx, as(["editor"]), event.id, 1, [])))).toBe("ok");
    expect(await code(run((tx) => registration.saveForm(tx, as(["door_staff"]), event.id, 2, FORM)))).toBe("forbidden");
  });
});

describe("acceptance: a guest accepts with a guest and a dietary need", () => {
  it("takes 2 places, shows the party on the door list, keeps the dietary need encrypted, deletes it after 30 days and anonymises after 12 months", async () => {
    const { event, occ } = await gala();
    const { inv, reg } = await acceptWith(event.id, occ.id, "kari@example.com", {
      partySize: 2, consent: true, answers: { diet: "Nøtteallergi, vegetar", org: "Nasjonalmuseet", photo: "on", menu: "veg" },
    });
    expect(reg).toMatchObject({ partySize: 2, formVersion: 1, sensitiveConsentAt: expect.any(Date) });
    expect((await run((tx) => catalog.getRegistrationTarget(tx, occ.id))).pool).toMatchObject({ taken: 2 });

    // Stored encrypted: the plaintext is nowhere in the row.
    const raw = await su.query<{ ciphertext: Buffer }>("select ciphertext from registration.sensitive_answer where registration_id = $1", [reg.id]);
    expect(raw.rows).toHaveLength(1);
    expect(raw.rows[0]!.ciphertext.toString("utf8")).not.toContain("Nøtte");
    expect((await su.query("select count(*)::int as n from registration.answer where registration_id = $1", [reg.id])).rows[0].n).toBe(3);

    const door = await run((tx) => registration.doorList(tx, ctx, occ.id, { answers: true }));
    expect(door.totals).toEqual({ registrations: 1, people: 2 });
    expect(door.entries[0]).toMatchObject({ name: "Kari Nordmann", partySize: 2, source: "invitation" });
    expect(door.entries[0]!.answers).toEqual({ diet: "Nøtteallergi, vegetar", org: "Nasjonalmuseet", photo: "✓", menu: "Vegetar" });
    expect(door.columns.find((c) => c.fieldId === "diet")).toMatchObject({ label: "Allergier og matbehov", sensitive: true });

    // Box office sees the list and plain answers, not the dietary need.
    const boxOffice = await run((tx) => registration.doorList(tx, as(["box_office"]), occ.id, { answers: true }));
    expect(boxOffice.columns.map((c) => c.fieldId)).toEqual(["org", "photo", "menu"]);
    expect(boxOffice.entries[0]!.answers).not.toHaveProperty("diet");
    expect(await answersOf(reg.id, { kind: "staff", ctx: as(["box_office"]) })).not.toHaveProperty("diet");
    // Editors work on content only.
    expect(await code(run((tx) => registration.doorList(tx, as(["editor"]), occ.id)))).toBe("forbidden");
    expect(await code(run((tx) => registration.listRegistrations(tx, as(["editor"]), occ.id)))).toBe("forbidden");
    const audit = await su.query("select action from tenancy.audit_log where entity_id = $1 and action = 'registration.sensitive_listed'", [occ.id]);
    expect(audit.rowCount).toBe(1);

    // 29 days after: kept. 31 days after: the dietary need is gone, the rest stays.
    expect(await retention(days(29))).toMatchObject({ sensitiveDeleted: 0, anonymised: 0 });
    expect(await answersOf(reg.id, { kind: "attendee" })).toHaveProperty("diet");
    expect((await retention(days(31))).sensitiveDeleted).toBe(1);
    expect(await answersOf(reg.id, { kind: "attendee" })).toEqual({ org: "Nasjonalmuseet", photo: true, menu: ["veg"] });

    // 12 months after: anonymised; the count remains and the links stop working.
    const token = await run((tx) => registration.manageToken(tx, ctx.tenantId, reg));
    const year = new Date(START);
    year.setUTCMonth(year.getUTCMonth() + 12);
    year.setUTCDate(year.getUTCDate() + 1);
    const r = await retention(year);
    expect(r).toMatchObject({ anonymised: 1, invitationsDeleted: 1 });
    const after = await run((tx) => registration.getRegistration(tx, reg.id));
    expect(after).toMatchObject({ name: "", email: "", anonymisedAt: year, partySize: 2, status: "confirmed" });
    expect(await answersOf(reg.id, { kind: "attendee" })).toEqual({});
    expect(await run((tx) => registration.registrationByToken(tx, token))).toBeNull();
    expect(await code(run((tx) => registration.getInvitation(tx, inv.id)))).toBe("not_found");
    expect((await run((tx) => registration.listRegistrations(tx, ctx, occ.id))).map((x) => x.partySize)).toEqual([2]);
    expect((await run((tx) => registration.doorList(tx, ctx, occ.id))).entries).toEqual([]);
    expect((await su.query("select status from admission.admission where registration_id = $1", [reg.id])).rows[0].status).toBe("void");
    // Idempotent.
    expect(await retention(year)).toMatchObject({ sensitiveDeleted: 0, anonymised: 0, invitationsDeleted: 0 });
  });
});

describe("answers", () => {
  it("needs consent for sensitive answers and the required fields from attendees, but not from staff", async () => {
    const { event, occ } = await gala();
    const accept = (email: string, input: Partial<registration.AcceptInput>) => code(acceptWith(event.id, occ.id, email, input));
    expect(await accept("a@example.com", { answers: { org: "X", diet: "Laktose" } })).toBe("validation_failed:consent");
    expect(await accept("b@example.com", { answers: { diet: "" } })).toBe("validation_failed:answers.org");
    expect(await accept("c@example.com", { answers: { org: "X", nope: "?" } })).toBe("validation_failed:answers.nope");
    expect(await accept("d@example.com", { answers: { org: "X", menu: ["fish", "veg"] } })).toBe("validation_failed:answers.menu");
    expect(await accept("e@example.com", { answers: { org: "X" } })).toBe("ok");

    const open = await gala();
    await run(async (tx) => catalog.updateEvent(tx, ctx, open.event.id, (await catalog.getEvent(tx, open.event.id)).version, { registration: { accessPolicy: "open" } }));
    expect(await code(run((tx) => registration.register(tx, ctx.tenantId, open.occ.id, { name: "Staff add", email: "s@example.com" }, { kind: "staff", ctx: as(["box_office"]) }, NOW)))).toBe("ok");
    expect(await code(run((tx) => registration.register(tx, ctx.tenantId, open.occ.id, { name: "S2", email: "s2@example.com", answers: { diet: "Gluten" }, consent: true }, { kind: "staff", ctx: as(["box_office"]) }, NOW))))
      .toBe("forbidden");
  });

  it("lets the attendee change answers, and keeps sensitive ones when staff without the permission edit", async () => {
    const { event, occ } = await gala();
    const { reg } = await acceptWith(event.id, occ.id, "f@example.com", { consent: true, answers: { org: "A", diet: "Skalldyr" } });
    const changed = await run((tx) => registration.updateRegistration(tx, ctx.tenantId, reg.id, { answers: { org: "B", diet: "Skalldyr" }, consent: true }, { kind: "attendee" }, { now: NOW }));
    expect(changed.version).toBe(reg.version + 1);
    expect(await answersOf(reg.id, { kind: "attendee" })).toEqual({ org: "B", diet: "Skalldyr" });
    // Unchanged answers change nothing.
    const same = await run((tx) => registration.updateRegistration(tx, ctx.tenantId, reg.id, { answers: { org: "B", diet: "Skalldyr" }, consent: true }, { kind: "attendee" }, { now: NOW }));
    expect(same.version).toBe(changed.version);

    await run((tx) => registration.updateRegistration(tx, ctx.tenantId, reg.id, { answers: { org: "C" } }, { kind: "staff", ctx: as(["box_office"]) }));
    expect(await answersOf(reg.id, { kind: "attendee" })).toEqual({ org: "C", diet: "Skalldyr" });
    // The attendee empties the dietary field: gone, and consent with it.
    const cleared = await run((tx) => registration.updateRegistration(tx, ctx.tenantId, reg.id, { answers: { org: "C" } }, { kind: "attendee" }, { now: NOW }));
    expect(cleared.sensitiveConsentAt).toBeNull();
    expect(await answersOf(reg.id, { kind: "attendee" })).toEqual({ org: "C" });
  });

  it("keeps answers to a removed field readable", async () => {
    const { event, occ, form } = await gala();
    const { reg } = await acceptWith(event.id, occ.id, "g@example.com", { answers: { org: "Gammel", menu: "fish" } });
    await run((tx) => registration.saveForm(tx, ctx, event.id, form.version, form.fields.filter((f) => f.id !== "menu")));
    const fields = await run((tx) => registration.answerFields(tx, event.id));
    expect(fields.map((f) => [f.id, f.retired])).toEqual([["diet", false], ["org", false], ["photo", false], ["menu", true]]);
    expect((await run((tx) => registration.doorList(tx, ctx, occ.id, { answers: true }))).entries.find((e) => e.registrationId === reg.id)!.answers.menu).toBe("Fisk");
  });

  it("keeps answers to a removed choice option readable", async () => {
    const { event, occ, form } = await gala();
    const { reg } = await acceptWith(event.id, occ.id, "opt@example.com", { answers: { org: "X", menu: "fish" } });
    const fields = form.fields.map((f) => (f.id === "menu" ? { ...f, options: f.options.filter((o) => o.id !== "fish") } : f));
    await run((tx) => registration.saveForm(tx, ctx, event.id, form.version, fields));
    const menu = (await run((tx) => registration.answerFields(tx, event.id))).find((f) => f.id === "menu")!;
    expect(menu).toMatchObject({ retired: false, options: [{ id: "veg" }, { id: "fish" }] });
    expect((await run((tx) => registration.doorList(tx, ctx, occ.id, { answers: true }))).entries.find((e) => e.registrationId === reg.id)!.answers.menu).toBe("Fisk");
  });

  it("refuses to change whether a field is sensitive once it has answers", async () => {
    const { event, occ, form } = await gala();
    const flip = (id: string, sensitive: boolean) => form.fields.map((f) => (f.id === id ? { ...f, sensitive } : f));
    // Unanswered: a plain text field may become sensitive, and back.
    const v2 = await run((tx) => registration.saveForm(tx, ctx, event.id, form.version, flip("org", true)));
    expect(v2.fields.find((f) => f.id === "org")!.sensitive).toBe(true);
    const v3 = await run((tx) => registration.saveForm(tx, ctx, event.id, v2.version, flip("org", false)));

    await acceptWith(event.id, occ.id, "cls@example.com", { answers: { org: "NTNU" } });
    expect(await code(run((tx) => registration.saveForm(tx, ctx, event.id, v3.version, flip("org", true))))).toBe("validation_failed:fields.1.sensitive");
    // Other edits to the field are still fine.
    const relabel = form.fields.map((f) => (f.id === "org" ? { ...f, label: { nb: "Arbeidsgiver" } } : f));
    expect((await run((tx) => registration.saveForm(tx, ctx, event.id, v3.version, relabel))).version).toBe(v3.version + 1);
  });

  it("waits for a registration in progress before changing a field's classification", async () => {
    const { event, occ, form } = await gala();
    const toSensitive = form.fields.map((f) => (f.id === "org" ? { ...f, sensitive: true } : f));
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let registered!: () => void;
    const inFlight = new Promise<void>((r) => { registered = r; });
    // register's steps, paused after the form is read and before the answer is written.
    const a = run(async (tx) => {
      const target = await catalog.getRegistrationTarget(tx, occ.id);
      const answers = await registration.formAnswers(tx, event.id, { answers: { org: "NTNU" } }, { kind: "staff", ctx });
      registered();
      await held;
      await registration.insertConfirmed(tx, ctx.tenantId, target, { name: "Rask", email: "rask@example.com", locale: "nb", partySize: 1, source: "staff", invitationId: null }, answers);
    });
    await inFlight;
    let settled = false;
    const b = code(run((tx) => registration.saveForm(tx, ctx, event.id, form.version, toSensitive))).finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 300));
    expect(settled).toBe(false);
    release();
    await a;
    expect(await b).toBe("validation_failed:fields.1.sensitive");
  });
});

describe("encryption and tenants", () => {
  it("binds a ciphertext to its row and keeps each tenant's answers and keys to itself", async () => {
    const { event, occ } = await gala();
    const a = await acceptWith(event.id, occ.id, "h@example.com", { consent: true, answers: { org: "A", diet: "Egg" } });
    const b = await acceptWith(event.id, occ.id, "i@example.com", { consent: true, answers: { org: "B", diet: "Melk" } });
    // A ciphertext moved to another registration does not decrypt.
    await su.query("update registration.sensitive_answer set ciphertext = (select ciphertext from registration.sensitive_answer where registration_id = $1) where registration_id = $2", [a.reg.id, b.reg.id]);
    await expect(answersOf(b.reg.id, { kind: "attendee" })).rejects.toThrow();

    const theirs = await gala(other, [{ id: "diet", type: "dietary", label: { nb: "Mat" } }, { id: "org", type: "text", label: { nb: "Org" } }]);
    const theirInv = await run((tx) => registration.createInvitation(tx, other, theirs.event.id, { email: "x@example.com", name: "X" }), other);
    await run((tx) => registration.acceptInvitation(tx, other.tenantId, theirInv.id, { occurrenceId: theirs.occ.id, consent: true, answers: { diet: "Soya", org: "Y" } }, NOW), other);
    const keys = await su.query<{ wrapped: Buffer }>("select wrapped from registration.data_key order by tenant_id");
    expect(keys.rowCount).toBe(2);
    expect(keys.rows[0]!.wrapped.equals(keys.rows[1]!.wrapped)).toBe(false);

    for (const table of ["registration.answer", "registration.sensitive_answer", "registration.data_key", "registration.form_version"] as const) {
      const seen = await run((tx) => tx.selectFrom(table).select("tenant_id").execute(), other);
      expect(seen.length, table).toBeGreaterThan(0);
      expect(seen.every((r) => r.tenant_id === other.tenantId), table).toBe(true);
    }
    expect(await run((tx) => registration.readAnswers(tx, other.tenantId, [a.reg.id], { kind: "attendee" }), other)).toEqual(new Map([[a.reg.id, {}]]));
  });

  it("parses master keys and refuses bad ones", () => {
    const k = Buffer.alloc(32, 1).toString("base64");
    expect(registration.parseMasterKeys(`new:${k}, old:${k}`).currentId).toBe("new");
    expect(() => registration.parseMasterKeys("k1:c2hvcnQ=")).toThrow(/32 bytes/);
    expect(() => registration.parseMasterKeys(`k1:${k},k1:${k}`)).toThrow(/duplicate/);
  });

  it("rewraps the data key under a new master key and still decrypts", async () => {
    const { event, occ } = await gala();
    const { reg } = await acceptWith(event.id, occ.id, "j@example.com", { consent: true, answers: { org: "A", diet: "Sennep" } });
    registration.configureMasterKeys(`k2:${Buffer.alloc(32, 9).toString("base64")},k1:${Buffer.alloc(32, 7).toString("base64")}`);
    expect(await run((tx) => registration.rewrapDataKey(tx, ctx.tenantId))).toBe(true);
    registration.configureMasterKeys(`k2:${Buffer.alloc(32, 9).toString("base64")}`);
    expect(await answersOf(reg.id, { kind: "attendee" })).toMatchObject({ diet: "Sennep" });
  });
});

describe("retention settings", () => {
  it("validates the periods", async () => {
    const account = await run((tx) => tenancy.getAccount(tx));
    expect(account).toMatchObject({ anonymiseAfterMonths: 12, sensitiveDeleteAfterDays: 30 });
    const update = (patch: tenancy.AccountSettingsPatch) => code(run(async (tx) => tenancy.updateAccountSettings(tx, ctx, (await tenancy.getAccount(tx)).version, patch)));
    expect(await update({ sensitiveDeleteAfterDays: 400 })).toBe("validation_failed:sensitiveDeleteAfterDays");
    expect(await update({ anonymiseAfterMonths: 1, sensitiveDeleteAfterDays: 60 })).toBe("validation_failed:sensitiveDeleteAfterDays");
    expect(await update({ anonymiseAfterMonths: 6, sensitiveDeleteAfterDays: 14 })).toBe("ok");
    expect(await update({ anonymiseAfterMonths: 12, sensitiveDeleteAfterDays: 30 })).toBe("ok");
  });
});
