import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { type ActorContext, catalog, tenancy } from "@event-manager/domain";
import { buildAttendeeApp } from "../src/app.js";

let tdb: TestDatabase;
let db: Db;
let app: Awaited<ReturnType<typeof buildAttendeeApp>>;
let ctx: ActorContext;
const DAY = 86_400_000;

async function registrationOccurrence(settings: Partial<catalog.RegistrationSettings> = {}, publish = true) {
  return withTenant(db, ctx, async (tx) => {
    let e = await catalog.createEvent(tx, ctx, {
      translations: { nb: { title: "Kveldsforedrag", shortDescription: "Om Munch" }, en: { title: "Evening talk" } },
      admissionMode: "registration", registration: { capacity: 3, guestAllowed: true, ...settings },
    });
    if (publish) e = await catalog.transitionEvent(tx, ctx, e.id, e.version, "publish");
    return catalog.createOccurrence(tx, ctx, e.id, { startUtc: new Date(Date.now() + 10 * DAY) });
  });
}

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const post = (url: string, fields: Record<string, string>) =>
  app.inject({ method: "POST", url, headers: { "content-type": "application/x-www-form-urlencoded" }, payload: form(fields) });
const filled = (extra: Record<string, string> = {}) => ({ name: "Kari Nordmann", email: "kari@example.com", locale: "nb", t: String(Date.now() - 5000), website: "", ...extra });
const json = (method: "GET" | "POST" | "PATCH", url: string, body?: unknown, token?: string) =>
  app.inject({ method, url, payload: body as object, headers: token ? { authorization: `Bearer ${token}` } : {} });
const pool = (occurrenceId: string) => withTenant(db, ctx, async (tx) => (await catalog.getOccurrence(tx, occurrenceId)).pool);

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  app = await buildAttendeeApp({ db, rateLimit: { capacity: 1000, refillPerSecond: 1000 } });
  const account = await tenancy.createAccount(db, { slug: "attendee", name: "Museet", ownerEmail: "owner@attendee.test", locales: ["nb", "en"] });
  const userId = await tenancy.login(db, { issuer: "https://idp.test", subject: "owner@attendee.test", email: "owner@attendee.test", name: null });
  ctx = { tenantId: account.id, userId, clientId: null, roles: ["owner"] };
});
afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await tdb?.stop();
});

describe("hosted pages", () => {
  it("registers through the open page, then shows, changes and cancels the registration", async () => {
    const occ = await registrationOccurrence();
    const page = await app.inject({ url: `/r/${occ.id}` });
    expect(page.statusCode).toBe(200);
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(page.body).toContain("Kveldsforedrag");
    expect(page.body).toContain("Museet");
    expect(page.body).toContain('name="guest"');

    const en = await app.inject({ url: `/r/${occ.id}?lang=en` });
    expect(en.body).toContain("Evening talk");

    const res = await post(`/r/${occ.id}`, filled({ guest: "1" }));
    expect(res.statusCode).toBe(303);
    const location = res.headers.location as string;
    expect(location).toMatch(/^\/m\/[A-Za-z0-9_-]{72}\?welcome=1$/);
    expect(await pool(occ.id)).toMatchObject({ taken: 2 });

    const manage = await app.inject({ url: location });
    expect(manage.statusCode).toBe(200);
    expect(manage.headers["referrer-policy"]).toBe("no-referrer");
    expect(manage.body).toContain("Du er påmeldt");
    expect(manage.body).toContain("Kari Nordmann");
    expect(manage.body).toContain("<svg");

    const base = location.split("?")[0]!;
    const changed = await post(base, { name: "Kari N.", guestField: "1", locale: "nb" });
    expect(changed.statusCode).toBe(303);
    expect(await pool(occ.id)).toMatchObject({ taken: 1 });
    expect((await app.inject({ url: base })).body).toContain("Kari N.");

    const cancelled = await post(`${base}/cancel`, { locale: "nb" });
    expect(cancelled.statusCode).toBe(303);
    expect(await pool(occ.id)).toMatchObject({ taken: 0 });
    const after = await app.inject({ url: base });
    expect(after.body).toContain("avbestilt");
    expect(after.body).not.toContain("<svg");
  });

  it("rejects bots: a filled honeypot or a form sent too fast", async () => {
    const occ = await registrationOccurrence();
    expect((await post(`/r/${occ.id}`, filled({ website: "http://spam.test" }))).statusCode).toBe(400);
    expect((await post(`/r/${occ.id}`, filled({ t: String(Date.now()) }))).statusCode).toBe(400);
    expect(await pool(occ.id)).toMatchObject({ taken: 0 });
  });

  it("shows errors in the form and says when it is full", async () => {
    const occ = await registrationOccurrence({ capacity: 1, guestAllowed: false });
    expect((await post(`/r/${occ.id}`, filled())).statusCode).toBe(303);
    const dup = await post(`/r/${occ.id}`, filled({ email: "KARI@example.com" }));
    expect(dup.statusCode).toBe(409);
    expect(dup.body).toMatch(/allerede påmeldt|ingen ledige plasser/);
    const full = await app.inject({ url: `/r/${occ.id}` });
    expect(full.body).toContain("Fullt");
    expect(full.body).not.toContain('name="email"');
  });

  it("answers 404 for drafts, unknown occurrences and invalid links", async () => {
    const draft = await registrationOccurrence({}, false);
    expect((await app.inject({ url: `/r/${draft.id}` })).statusCode).toBe(404);
    expect((await app.inject({ url: "/r/not-a-uuid" })).statusCode).toBe(404);
    expect((await app.inject({ url: `/m/${"A".repeat(72)}` })).statusCode).toBe(404);
  });

  it("escapes what attendees type", async () => {
    const occ = await registrationOccurrence();
    const res = await post(`/r/${occ.id}`, filled({ name: "<script>alert(1)</script>", email: "x@example.com" }));
    const manage = await app.inject({ url: res.headers.location as string });
    expect(manage.body).not.toContain("<script>alert(1)</script>");
    expect(manage.body).toContain("&lt;script&gt;");
  });
});

describe("attendee API", () => {
  it("registers, reads, changes and cancels with the manage token", async () => {
    const occ = await registrationOccurrence({ capacity: 2 });
    const info = await json("GET", `/attendee/v1/occurrences/${occ.id}?locale=en`);
    expect(info.statusCode).toBe(200);
    expect(info.json()).toMatchObject({ locale: "en", event: { title: "Evening talk", guestAllowed: true, accessPolicy: "open" }, availability: { status: "available" } });

    const created = await json("POST", `/attendee/v1/occurrences/${occ.id}/registrations`, { name: "Ola", email: "ola@example.com", partySize: 2 });
    expect(created.statusCode).toBe(201);
    const { registration: reg, manageToken } = created.json();
    expect(reg).toMatchObject({ name: "Ola", partySize: 2, status: "confirmed", locale: "nb" });

    expect((await json("POST", `/attendee/v1/occurrences/${occ.id}/registrations`, { name: "Ola", email: "ola@example.com" })).json()).toMatchObject({ code: "already_registered" });
    expect((await json("POST", `/attendee/v1/occurrences/${occ.id}/registrations`, { name: "Per", email: "per@example.com" })).json()).toMatchObject({ status: 409, code: "full" });

    const view = await json("GET", "/attendee/v1/registration", undefined, manageToken);
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({ registration: { id: reg.id }, rights: { change: true, cancel: true }, details: { availability: { status: "full" } } });
    expect(view.json().admissionToken).toHaveLength(72);

    const patched = await json("PATCH", "/attendee/v1/registration", { partySize: 1 }, manageToken);
    expect(patched.json()).toMatchObject({ registration: { partySize: 1 } });
    const cancelled = await json("POST", "/attendee/v1/registration/cancel", undefined, manageToken);
    expect(cancelled.json()).toMatchObject({ registration: { status: "cancelled" } });
    expect((await json("GET", "/attendee/v1/registration", undefined, manageToken)).json()).toMatchObject({ admissionToken: null, rights: { change: false, cancel: false } });
  });

  it("refuses missing, forged and admission tokens", async () => {
    const occ = await registrationOccurrence();
    const { manageToken } = (await json("POST", `/attendee/v1/occurrences/${occ.id}/registrations`, { name: "Liv", email: "liv@example.com" })).json();
    const { admissionToken } = (await json("GET", "/attendee/v1/registration", undefined, manageToken)).json();
    expect((await json("GET", "/attendee/v1/registration")).json()).toMatchObject({ status: 401, code: "token_required" });
    expect((await json("GET", "/attendee/v1/registration", undefined, admissionToken)).json()).toMatchObject({ status: 401, code: "invalid_token" });
    const forged = `${manageToken.slice(0, 71)}${manageToken.endsWith("A") ? "B" : "A"}`;
    expect((await json("GET", "/attendee/v1/registration", undefined, forged)).json()).toMatchObject({ code: "invalid_token" });
  });

  it("needs an invitation for invite-only events", async () => {
    const occ = await registrationOccurrence({ accessPolicy: "invite_only" });
    const res = await json("POST", `/attendee/v1/occurrences/${occ.id}/registrations`, { name: "Kim", email: "kim@example.com" });
    expect(res.json()).toMatchObject({ status: 403, code: "invitation_required" });
  });

  it("validates input", async () => {
    const occ = await registrationOccurrence();
    expect((await json("POST", `/attendee/v1/occurrences/${occ.id}/registrations`, { name: "Kim", email: "nope" })).json()).toMatchObject({ status: 422, code: "validation_failed" });
    expect((await json("POST", `/attendee/v1/occurrences/${occ.id}/registrations`, { name: "Kim" })).statusCode).toBe(400);
  });

  it("rate limits posts per IP", async () => {
    const limited = await buildAttendeeApp({ db, rateLimit: { capacity: 1, refillPerSecond: 0.001 } });
    const occ = await registrationOccurrence();
    const send = (email: string) => limited.inject({ method: "POST", url: `/attendee/v1/occurrences/${occ.id}/registrations`, payload: { name: "R", email } });
    expect((await send("r1@example.com")).statusCode).toBe(201);
    expect((await send("r2@example.com")).json()).toMatchObject({ status: 429, code: "rate_limited" });
    await limited.close();
  });
});
