import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { type ActorContext, catalog, registration, tenancy } from "@event-manager/domain";
import { buildAttendeeApp } from "../src/app.js";

// The waitlist on the hosted pages and in the attendee API (docs/registration.md, milestone 5).

let tdb: TestDatabase;
let db: Db;
let app: Awaited<ReturnType<typeof buildAttendeeApp>>;
let ctx: ActorContext;
const DAY = 86_400_000;

async function fullOccurrence() {
  const occ = await withTenant(db, ctx, async (tx) => {
    let e = await catalog.createEvent(tx, ctx, {
      translations: { nb: { title: "Kveldsforedrag" }, en: { title: "Evening talk" } },
      admissionMode: "registration", registration: { capacity: 1, waitlistEnabled: true },
    });
    e = await catalog.transitionEvent(tx, ctx, e.id, e.version, "publish");
    return catalog.createOccurrence(tx, ctx, e.id, { startUtc: new Date(Date.now() + 10 * DAY) });
  });
  const first = await withTenant(db, ctx, (tx) => registration.register(tx, ctx.tenantId, occ.id, { name: "Først", email: `first-${occ.id}@example.com` }, { kind: "attendee" }));
  return { occ, first };
}

const post = (url: string, fields: Record<string, string>) =>
  app.inject({ method: "POST", url, headers: { "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams(fields).toString() });
const filled = (email: string) => ({ name: "Kari Nordmann", email, locale: "nb", t: String(Date.now() - 5000), website: "" });
const json = (method: "GET" | "POST", url: string, body?: unknown, token?: string) =>
  app.inject({ method, url, payload: body as object, headers: token ? { authorization: `Bearer ${token}` } : {} });
const cancelFirst = (id: string) => withTenant(db, ctx, (tx) => registration.cancelRegistration(tx, ctx.tenantId, id, { kind: "attendee" }));

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  app = await buildAttendeeApp({ db, rateLimit: { capacity: 1000, refillPerSecond: 1000 } });
  const account = await tenancy.createAccount(db, { slug: "waitlist", name: "Museet", ownerEmail: "owner@waitlist.test", locales: ["nb", "en"] });
  const userId = await tenancy.login(db, { issuer: "https://idp.test", subject: "owner@waitlist.test", email: "owner@waitlist.test", name: null });
  ctx = { tenantId: account.id, userId, clientId: null, roles: ["owner"] };
});
afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await tdb?.stop();
});

describe("hosted pages", () => {
  it("joins the waitlist on a full page, then claims the offered place", async () => {
    const { occ, first } = await fullOccurrence();
    const page = await app.inject({ url: `/r/${occ.id}` });
    expect(page.body).toContain("Fullt – sett deg på ventelisten");
    expect(page.body).toContain("Sett meg på ventelisten");

    const res = await post(`/r/${occ.id}`, filled("kari@example.com"));
    expect(res.statusCode).toBe(303);
    const location = res.headers.location as string;
    const manage = await app.inject({ url: location });
    expect(manage.body).toContain("Du står på ventelisten");
    expect(manage.body).toContain("Du er nummer 1 i køen.");
    expect(manage.body).not.toContain("<svg");
    expect(manage.body).toContain("Meld meg av ventelisten");

    await cancelFirst(first.id);
    const base = location.split("?")[0]!;
    const offered = await app.inject({ url: base });
    expect(offered.body).toContain("Du har fått en plass");
    expect(offered.body).toContain(`action="${base}/claim"`);
    expect(offered.body).toContain("Jeg kan likevel ikke komme");

    const claimed = await post(`${base}/claim`, { locale: "nb" });
    expect(claimed.statusCode).toBe(303);
    const after = await app.inject({ url: claimed.headers.location as string });
    expect(after.body).toContain("Plassen er din.");
    expect(after.body).toContain("Du er påmeldt");
    expect(after.body).toContain("<svg");
  });

  it("leaves the waitlist", async () => {
    const { occ } = await fullOccurrence();
    const res = await post(`/r/${occ.id}`, filled("ola@example.com"));
    const base = (res.headers.location as string).split("?")[0]!;
    const left = await post(`${base}/cancel`, { locale: "nb" });
    expect(left.statusCode).toBe(303);
    const after = await app.inject({ url: left.headers.location as string });
    expect(after.body).toContain("Du har meldt deg av ventelisten");
  });
});

describe("attendee API", () => {
  it("reports waitlist availability, the position and the offer, and claims it", async () => {
    const { occ, first } = await fullOccurrence();
    const o = await json("GET", `/attendee/v1/occurrences/${occ.id}`);
    expect(o.json().availability.status).toBe("waitlist");

    const created = await json("POST", `/attendee/v1/occurrences/${occ.id}/registrations`, { name: "Per", email: "per@example.com" });
    expect(created.statusCode).toBe(201);
    const { registration: reg, manageToken } = created.json();
    expect(reg).toMatchObject({ status: "waitlisted", waitlistPosition: 1, offerExpiresAt: null });

    expect((await json("POST", "/attendee/v1/registration/claim", undefined, manageToken)).json()).toMatchObject({ code: "no_offer", status: 409 });
    await cancelFirst(first.id);
    const view = (await json("GET", "/attendee/v1/registration", undefined, manageToken)).json();
    expect(view.registration).toMatchObject({ status: "offered", waitlistPosition: null });
    expect(view.registration.offerExpiresAt).toEqual(expect.any(String));
    expect(view.rights).toMatchObject({ claim: true, cancel: true });
    expect(view.admissionToken).toBeNull();

    const claim = await json("POST", "/attendee/v1/registration/claim", undefined, manageToken);
    expect(claim.statusCode).toBe(200);
    expect(claim.json().registration.status).toBe("confirmed");
    expect((await json("GET", "/attendee/v1/registration", undefined, manageToken)).json().admissionToken).toEqual(expect.any(String));
  });
});
