import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { type ActorContext, catalog, registration, tenancy } from "@event-manager/domain";
import { buildAttendeeApp } from "../src/app.js";

// The invitation page /i/{token} and /attendee/v1/invitation (docs/registration.md, milestone 3).

let tdb: TestDatabase;
let db: Db;
let app: Awaited<ReturnType<typeof buildAttendeeApp>>;
let ctx: ActorContext;
const DAY = 86_400_000;
const run = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db, ctx, fn);

async function invited(opts: { occurrences?: number; guestAllowed?: boolean | null; name?: string | null; email?: string; capacity?: number } = {}) {
  return run(async (tx) => {
    let e = await catalog.createEvent(tx, ctx, {
      translations: { nb: { title: "Sommerfest" }, en: { title: "Summer party" } },
      admissionMode: "registration", registration: { accessPolicy: "invite_only", capacity: opts.capacity ?? 50, guestAllowed: false },
    });
    e = await catalog.transitionEvent(tx, ctx, e.id, e.version, "publish");
    const occs = [];
    for (let i = 0; i < (opts.occurrences ?? 1); i++) occs.push(await catalog.createOccurrence(tx, ctx, e.id, { startUtc: new Date(Date.now() + (10 + i) * DAY) }));
    const inv = await registration.createInvitation(tx, ctx, e.id, {
      email: opts.email ?? `g${Math.random().toString(36).slice(2)}@example.com`, name: opts.name === undefined ? "Kari" : opts.name, guestAllowed: opts.guestAllowed ?? null,
    });
    return { event: e, occs, inv, token: await registration.invitationToken(tx, ctx.tenantId, inv) };
  });
}

const post = (url: string, fields: Record<string, string>) =>
  app.inject({ method: "POST", url, headers: { "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams(fields).toString() });
const json = (method: "GET" | "POST", url: string, token: string, body?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(body !== undefined ? { payload: body as object } : {}) });

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  app = await buildAttendeeApp({ db, rateLimit: { capacity: 1000, refillPerSecond: 1000 } });
  const account = await tenancy.createAccount(db, { slug: "invite", name: "Museet", ownerEmail: "owner@invite.test", locales: ["nb", "en"] });
  const userId = await tenancy.login(db, { issuer: "https://idp.test", subject: "owner@invite.test", email: "owner@invite.test", name: null });
  ctx = { tenantId: account.id, userId, clientId: null, roles: ["owner"] };
});
afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await tdb?.stop();
});

describe("invitation page", () => {
  it("accepts with a chosen time and a guest, then sends the guest to their registration", async () => {
    const { occs, inv, token } = await invited({ occurrences: 2, guestAllowed: true });
    const page = await app.inject({ url: `/i/${token}` });
    expect(page.statusCode).toBe(200);
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.body).toContain("Museet inviterer deg");
    expect(page.body).toContain("Sommerfest");
    expect(page.body).toContain("Velg tidspunkt");
    expect(page.body.match(/type="radio"/g)).toHaveLength(2);
    expect(page.body).toContain('name="guest"');
    expect(page.body).toContain(inv.email);
    expect(page.body).toContain('value="Kari"');

    const missing = await post(`/i/${token}`, { answer: "accept", name: "Kari", locale: "nb" });
    expect(missing.statusCode).toBe(422);
    expect(missing.body).toContain("Velg et av tidspunktene");

    const res = await post(`/i/${token}`, { answer: "accept", occurrenceId: occs[1]!.id, name: "Kari N.", guest: "1", locale: "en" });
    expect(res.statusCode).toBe(303);
    const location = res.headers.location as string;
    expect(location).toMatch(/^\/m\/[A-Za-z0-9_-]{72}\?welcome=1&lang=en$/);
    const reg = await run((tx) => registration.registrationByToken(tx, location.slice(3, 75)));
    expect(reg).toMatchObject({ occurrenceId: occs[1]!.id, partySize: 2, source: "invitation", name: "Kari N.", locale: "en" });

    // The invitation link now leads to the registration, where the guest can be removed and added again.
    const again = await app.inject({ url: `/i/${token}` });
    expect(again.statusCode).toBe(303);
    expect(again.headers.location).toBe(location.split("?")[0]);
    const manage = await app.inject({ url: location });
    expect(manage.body).toContain('name="guest"');
  });

  it("declines, and keeps the link working so the guest can change their mind", async () => {
    const { occs, token } = await invited();
    const res = await post(`/i/${token}`, { answer: "decline", locale: "nb" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`/i/${token}?declined=1&lang=nb`);
    const done = await app.inject({ url: res.headers.location as string });
    expect(done.body).toContain("Takk for at du ga beskjed");
    expect(done.body).not.toContain('value="decline"');
    // One time only: no choice to make, just the details and the accept button.
    expect(done.body).not.toContain('type="radio"');
    expect(done.body).toContain(`name="occurrenceId" value="${occs[0]!.id}"`);
    const later = await app.inject({ url: `/i/${token}` });
    expect(later.body).toContain("Du har takket nei");
    const accept = await post(`/i/${token}`, { answer: "accept", occurrenceId: occs[0]!.id, name: "Kari", locale: "nb" });
    expect(accept.statusCode).toBe(303);
  });

  it("does not offer a guest the invitation doesn't allow, and asks for a name when the list has none", async () => {
    const { occs, token } = await invited({ name: null });
    const page = await app.inject({ url: `/i/${token}?lang=en` });
    expect(page.body).toContain("Summer party");
    expect(page.body).not.toContain('name="guest"');
    expect(page.body).toContain('id="name" name="name" required maxlength="200" autocomplete="name" value=""');
    const res = await post(`/i/${token}`, { answer: "accept", occurrenceId: occs[0]!.id, name: "", guest: "1", locale: "en" });
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain("Check the fields");
  });

  it("shows full times as unavailable", async () => {
    const { occs, token } = await invited({ occurrences: 2, capacity: 1 });
    await run((tx) => registration.register(tx, ctx.tenantId, occs[0]!.id, { name: "X", email: "x@example.com" }, { kind: "staff", ctx }));
    const page = await app.inject({ url: `/i/${token}` });
    expect(page.body).toMatch(new RegExp(`value="${occs[0]!.id}" disabled`));
    expect(page.body).toContain("Fullt");
    // The only bookable time is preselected.
    expect(page.body).toMatch(new RegExp(`value="${occs[1]!.id}" checked`));
  });

  it("rejects forged and rotated links", async () => {
    const { inv, token } = await invited();
    expect((await app.inject({ url: `/i/${"A".repeat(72)}` })).statusCode).toBe(404);
    await run((tx) => registration.rotateInvitationLink(tx, ctx, inv.id));
    const old = await app.inject({ url: `/i/${token}` });
    expect(old.statusCode).toBe(404);
    // The tenant's language is unknown for a link that doesn't verify.
    expect(old.body).toContain("This link is not valid");
  });
});

describe("/attendee/v1/invitation", () => {
  it("shows the invitation, accepts and then points to the registration", async () => {
    const { occs, token } = await invited({ guestAllowed: true });
    const view = await json("GET", "/attendee/v1/invitation?locale=en", token);
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({
      locale: "en", account: { name: "Museet" }, invitation: { name: "Kari", status: "pending", guestAllowed: true },
      event: { title: "Summer party" }, occurrences: [{ id: occs[0]!.id, availability: { status: "available" } }], manageToken: null,
    });
    const acc = await json("POST", "/attendee/v1/invitation/accept", token, { occurrenceId: occs[0]!.id, partySize: 2 });
    expect(acc.statusCode).toBe(201);
    expect(acc.json().registration).toMatchObject({ partySize: 2, status: "confirmed" });
    const twice = await json("POST", "/attendee/v1/invitation/accept", token, { occurrenceId: occs[0]!.id });
    expect(twice.json()).toMatchObject({ status: 409, code: "already_registered" });
    const after = await json("GET", "/attendee/v1/invitation", token);
    expect(after.json()).toMatchObject({ invitation: { status: "accepted" }, manageToken: acc.json().manageToken, occurrences: [] });
  });

  it("declines, and rejects other tokens", async () => {
    const { token } = await invited();
    expect((await json("POST", "/attendee/v1/invitation/decline", token)).json()).toEqual({ status: "declined" });
    expect((await json("GET", "/attendee/v1/invitation", "nope")).statusCode).toBe(401);
    expect((await app.inject({ url: "/attendee/v1/invitation" })).json()).toMatchObject({ code: "token_required" });
  });
});

describe("logging", () => {
  it("hides manage and invitation tokens", async () => {
    const { redactUrl } = await import("../src/app.js");
    const t = "A".repeat(72);
    expect(redactUrl(`/i/${t}?lang=en`)).toBe("/i/[token]?lang=en");
    expect(redactUrl(`/m/${t}/cancel`)).toBe("/m/[token]/cancel");
    expect(redactUrl("/r/0193")).toBe("/r/0193");
  });
});
