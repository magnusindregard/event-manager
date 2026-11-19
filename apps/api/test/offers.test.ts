import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { tenancy } from "@event-manager/domain";
import { buildApp } from "../src/app.js";
import { DEV_ISSUER, devVerifier } from "../src/auth.js";

// Ticketing milestone 1 over HTTP: VAT classes, offers, price rules, overrides and the price grid.

const SECRET = "test-secret";
let tdb: TestDatabase;
let db: Db;
let app: Awaited<ReturnType<typeof buildApp>>;
let A: string;
let B: string;

const token = (email: string) =>
  new SignJWT({ email }).setProtectedHeader({ alg: "HS256" }).setIssuer(DEV_ISSUER).setSubject(email).setExpirationTime("5m").sign(new TextEncoder().encode(SECRET));

async function call(method: string, url: string, opts: { as?: string; account?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...opts.headers };
  headers.authorization = `Bearer ${await token(opts.as ?? "owner@a.test")}`;
  headers["account-id"] = opts.account ?? A;
  const res = await app.inject({ method: method as "GET", url, headers, ...(opts.body !== undefined ? { payload: opts.body as object } : {}) });
  return { status: res.statusCode, headers: res.headers, body: res.body ? res.json() : undefined };
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  app = await buildApp({ db, verifier: devVerifier(SECRET) });
  A = (await tenancy.createAccount(db, { slug: "off-a", name: "A", ownerEmail: "owner@a.test" })).id;
  B = (await tenancy.createAccount(db, { slug: "off-b", name: "B", ownerEmail: "owner@b.test" })).id;
  await call("GET", "/v1/me");
  await call("GET", "/v1/me", { as: "owner@b.test" });
  // An editor in A: content, but not offers.
  await call("POST", "/v1/account/invitations", { body: { email: "editor@a.test", role: "editor" } });
  await call("GET", "/v1/me", { as: "editor@a.test" });
});
afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await tdb?.stop();
});

describe("/v1 offers and prices", () => {
  it("sets up VAT, offers, a price rule and an override, and shows them in the price grid", async () => {
    const vat = await call("POST", "/v1/vat-classes", { body: { code: "exempt", label: "Fritatt", ratePct: 0 }, headers: { "idempotency-key": "vat-1" } });
    expect(vat).toMatchObject({ status: 201, body: { code: "exempt", ratePct: 0, inUse: false } });
    expect((await call("POST", "/v1/vat-classes", { as: "editor@a.test", body: { code: "x", label: "X", ratePct: 1 } })).status).toBe(403);

    const eventId = (await call("POST", "/v1/events", { body: { translations: { nb: { title: "Konsert" } }, admissionMode: "tickets" } })).body.id;
    // Fri 12 and Sat 13 February 2027, 19:30 in Oslo.
    const fri = (await call("POST", `/v1/events/${eventId}/occurrences`, { body: { startUtc: "2027-02-12T18:30:00Z" } })).body;
    const sat = (await call("POST", `/v1/events/${eventId}/occurrences`, { body: { startUtc: "2027-02-13T18:30:00Z" } })).body;

    const offer = { translations: { nb: { name: "Voksen", description: "Fra 18 år" } }, vatClassId: vat.body.id, defaultPrice: 45000 };
    expect((await call("POST", `/v1/events/${eventId}/offers`, { as: "editor@a.test", body: offer })).status).toBe(403);
    const created = await call("POST", `/v1/events/${eventId}/offers`, { body: offer, headers: { "idempotency-key": "offer-1" } });
    expect(created).toMatchObject({ status: 201, body: { resolution: "done", offer: { code: "voksen", defaultPrice: 45000, placesPerUnit: 1, maxPerReservation: 20 } } });
    expect(created.headers.etag).toBe(`"${created.body.offer.version}"`);
    const retried = await call("POST", `/v1/events/${eventId}/offers`, { body: offer, headers: { "idempotency-key": "offer-1" } });
    expect(retried.body.offer.id).toBe(created.body.offer.id);
    const adult = created.body.offer;
    const student = (await call("POST", `/v1/events/${eventId}/offers`, { body: { ...offer, translations: { nb: { name: "Student" } }, defaultPrice: 25000 } })).body.offer;

    const rule = await call("POST", `/v1/events/${eventId}/rules`, {
      body: { name: "Lørdag", conditions: { weekdays: [6] }, effects: [{ type: "price", targetRef: adult.id, value: { amount: 50000 } }, { type: "offerAvailable", targetRef: student.id, value: false }] },
    });
    expect(rule).toMatchObject({ status: 201, body: { resolution: "done", preview: { counts: { matched: 1, changed: 1 } } } });
    expect(rule.body.preview.changes[0].fields.map((f: { field: string; targetRef: string }) => [f.field, f.targetRef])).toEqual([["price", adult.id], ["offerAvailable", student.id]]);
    expect(rule.body.rule.effects).toContainEqual({ type: "price", targetRef: adult.id, value: { amount: 50000 } });

    const override = await call("PUT", `/v1/offers/${adult.id}/occurrences/${fri.id}/override`, { body: { amount: 40000 } });
    expect(override).toMatchObject({ status: 200, body: { price: { value: 40000, source: "override" }, override: { amount: 40000, available: null } } });

    const grid = await call("GET", `/v1/events/${eventId}/prices?limit=1`);
    expect(grid.status).toBe(200);
    expect(grid.body.offers.map((o: { code: string }) => o.code)).toEqual(["voksen", "student"]);
    expect(grid.body.items).toHaveLength(1);
    expect(grid.body.items[0]).toMatchObject({ occurrenceId: fri.id, status: "scheduled" });
    expect(grid.body.items[0].cells).toEqual([
      { offerId: adult.id, price: { value: 40000, source: "override", ruleId: null }, available: { value: true, source: "default", ruleId: null }, override: { amount: 40000, available: null } },
      { offerId: student.id, price: { value: 25000, source: "default", ruleId: null }, available: { value: true, source: "default", ruleId: null }, override: null },
    ]);
    const next = await call("GET", `/v1/events/${eventId}/prices?limit=1&cursor=${grid.body.nextCursor}`);
    expect(next.body.items[0].occurrenceId).toBe(sat.id);
    expect(next.body.items[0].cells[0].price).toEqual({ value: 50000, source: "rule", ruleId: rule.body.rule.id });
    expect(next.body.items[0].cells[1].available).toEqual({ value: false, source: "rule", ruleId: rule.body.rule.id });
    expect(next.body.nextCursor).toBeNull();

    const cleared = await call("DELETE", `/v1/offers/${adult.id}/occurrences/${fri.id}/override`);
    expect(cleared.body).toMatchObject({ price: { value: 45000, source: "default" }, override: null });

    // Editing an offer needs its ETag; a new default price is resolved.
    expect((await call("PATCH", `/v1/offers/${adult.id}`, { body: { defaultPrice: 47000 } })).status).toBe(428);
    const patched = await call("PATCH", `/v1/offers/${adult.id}`, { body: { defaultPrice: 47000 }, headers: { "if-match": created.headers.etag as string } });
    expect(patched).toMatchObject({ status: 200, body: { resolution: "done", offer: { defaultPrice: 47000 } } });
    // Rules refer to both offers, so neither can be deleted.
    expect((await call("DELETE", `/v1/offers/${adult.id}`, { headers: { "if-match": patched.headers.etag as string } })).status).toBe(409);

    // VAT in use keeps its rate.
    const vatNow = (await call("GET", "/v1/vat-classes")).body.items[0];
    expect(vatNow.inUse).toBe(true);
    expect((await call("PATCH", `/v1/vat-classes/${vatNow.id}`, { body: { ratePct: 12 }, headers: { "if-match": `"${vatNow.version}"` } })).status).toBe(409);

    // Copying to another ticketed event.
    const other = (await call("POST", "/v1/events", { body: { translations: { nb: { title: "Ny konsert" } }, admissionMode: "tickets" } })).body.id;
    const copy = await call("POST", `/v1/events/${other}/offers/copy`, { body: { fromEventId: eventId } });
    expect(copy).toMatchObject({ status: 200, body: { skipped: [], resolution: "done" } });
    expect(copy.body.created.map((o: { code: string; defaultPrice: number }) => [o.code, o.defaultPrice])).toEqual([["voksen", 47000], ["student", 25000]]);

    // Another tenant sees none of it.
    expect((await call("GET", `/v1/offers/${adult.id}`, { as: "owner@b.test", account: B })).status).toBe(404);
    expect((await call("GET", `/v1/events/${eventId}/prices`, { as: "owner@b.test", account: B })).status).toBe(404);
    expect((await call("PUT", `/v1/offers/${adult.id}/occurrences/${fri.id}/override`, { as: "owner@b.test", account: B, body: { amount: 1 } })).status).toBe(404);
  });
});
