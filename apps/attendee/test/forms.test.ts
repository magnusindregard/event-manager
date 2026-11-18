import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { type ActorContext, catalog, registration, tenancy } from "@event-manager/domain";
import { buildAttendeeApp } from "../src/app.js";

// Form fields on the hosted pages and in the attendee API (docs/registration.md, milestone 4).

let tdb: TestDatabase;
let db: Db;
let app: Awaited<ReturnType<typeof buildAttendeeApp>>;
let ctx: ActorContext;
const DAY = 86_400_000;
const run = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db, ctx, fn);

const FORM: registration.FormFieldInput[] = [
  { id: "diet", type: "dietary", label: { nb: "Allergier", en: "Allergies" } },
  { id: "org", type: "text", label: { nb: "Organisasjon", en: "Organisation" }, required: true },
  { id: "menu", type: "choice", multiple: true, label: { nb: "Retter", en: "Courses" }, options: [{ id: "soup", label: { nb: "Suppe" } }, { id: "cake", label: { nb: "Kake" } }] },
  { id: "photo", type: "checkbox", label: { nb: "Jeg kan bli fotografert", en: "I may be photographed" } },
];

async function openEvent() {
  return run(async (tx) => {
    let e = await catalog.createEvent(tx, ctx, { translations: { nb: { title: "Foredrag" } }, admissionMode: "registration", registration: { capacity: 40 } });
    e = await catalog.transitionEvent(tx, ctx, e.id, e.version, "publish");
    const occ = await catalog.createOccurrence(tx, ctx, e.id, { startUtc: new Date(Date.now() + 10 * DAY) });
    await registration.saveForm(tx, ctx, e.id, 0, FORM);
    return { event: e, occ };
  });
}

const post = (url: string, fields: Record<string, string>) =>
  app.inject({ method: "POST", url, headers: { "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams(fields).toString() });
const started = () => String(Date.now() - 5000);

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  app = await buildAttendeeApp({ db, rateLimit: { capacity: 1000, refillPerSecond: 1000 } });
  const account = await tenancy.createAccount(db, { slug: "forms", name: "Museet", ownerEmail: "owner@forms.test", locales: ["nb", "en"] });
  const userId = await tenancy.login(db, { issuer: "https://idp.test", subject: "owner@forms.test", email: "owner@forms.test", name: null });
  ctx = { tenantId: account.id, userId, clientId: null, roles: ["owner"] };
});
afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await tdb?.stop();
});

describe("form fields on the open registration page", () => {
  it("shows the fields and the consent line, and points at the field that needs attention", async () => {
    const { occ } = await openEvent();
    const page = await app.inject({ url: `/r/${occ.id}` });
    expect(page.body).toContain('<textarea id="a_diet" name="a_diet"');
    expect(page.body).toContain('name="a_org"');
    expect(page.body).toContain('name="a_menu__soup"');
    expect(page.body).toContain('name="a_photo"');
    expect(page.body).toContain("Jeg samtykker til at Museet lagrer opplysningene");
    expect(page.body).toContain("til 30 dager etter arrangementet");

    const base = { name: "Kari", email: "kari@example.com", locale: "nb", t: started() };
    const noOrg = await post(`/r/${occ.id}`, { ...base, a_diet: "" });
    expect(noOrg.statusCode).toBe(422);
    expect(noOrg.body).toMatch(/name="a_org"[^>]*aria-invalid="true"/);
    expect(noOrg.body).toContain("Feltet må fylles ut.");

    const noConsent = await post(`/r/${occ.id}`, { ...base, a_org: "NTNU", a_diet: "Nøtter" });
    expect(noConsent.statusCode).toBe(422);
    expect(noConsent.body).toContain("Kryss av for å samtykke");
    // What was typed is kept.
    expect(noConsent.body).toContain(">Nøtter</textarea>");

    const ok = await post(`/r/${occ.id}`, { ...base, a_org: "NTNU", a_diet: "Nøtter", consent: "1", a_menu__soup: "1", a_menu__cake: "1", a_photo: "1" });
    expect(ok.statusCode).toBe(303);
    const token = (ok.headers.location as string).slice(3, 75);
    const reg = (await run((tx) => registration.registrationByToken(tx, token)))!;
    expect(await run(async (tx) => (await registration.readAnswers(tx, ctx.tenantId, [reg.id], { kind: "attendee" })).get(reg.id)))
      .toEqual({ diet: "Nøtter", org: "NTNU", menu: ["soup", "cake"], photo: true });

    // The manage page lists the answers and fills them into the change form.
    const manage = await app.inject({ url: `/m/${token}` });
    expect(manage.body).toContain("Dine svar");
    expect(manage.body).toContain("Suppe, Kake");
    expect(manage.body).toMatch(/name="a_menu__cake" value="1" checked/);
    expect(manage.body).toMatch(/name="consent" value="1" checked/);

    // Emptying the dietary field deletes it.
    const saved = await post(`/m/${token}`, { name: "Kari", locale: "nb", answersField: "1", a_org: "UiO", a_menu__cake: "1" });
    expect(saved.statusCode).toBe(303);
    expect(await run(async (tx) => (await registration.readAnswers(tx, ctx.tenantId, [reg.id], { kind: "attendee" })).get(reg.id)))
      .toEqual({ org: "UiO", menu: ["cake"] });
  });
});

describe("form fields in the attendee API", () => {
  it("describes the form and takes answers", async () => {
    const { occ } = await openEvent();
    const details = await app.inject({ url: `/attendee/v1/occurrences/${occ.id}?locale=en` });
    expect(details.json().form).toMatchObject({ sensitiveDeleteAfterDays: 30, fields: [{ id: "diet", sensitive: true }, { id: "org", required: true }, { id: "menu" }, { id: "photo" }] });
    const res = await app.inject({
      method: "POST", url: `/attendee/v1/occurrences/${occ.id}/registrations`,
      payload: { name: "Ola", email: "ola@example.com", answers: { org: "Equinor", diet: "Laktose" }, consent: true },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().registration.answers).toEqual({ org: "Equinor", diet: "Laktose" });
    const bad = await app.inject({ method: "POST", url: `/attendee/v1/occurrences/${occ.id}/registrations`, payload: { name: "Per", email: "per@example.com", answers: { org: "X", menu: ["nope"] } } });
    expect(bad.statusCode).toBe(422);
  });
});
