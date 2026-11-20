import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { tenancy } from "@event-manager/domain";
import { buildApp } from "../src/app.js";
import { DEV_ISSUER, devVerifier } from "../src/auth.js";

// User groups milestone 1 over HTTP (docs/user-groups.md): groups, and access lists on events and offers.

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
  A = (await tenancy.createAccount(db, { slug: "grp-a", name: "A", ownerEmail: "owner@a.test" })).id;
  B = (await tenancy.createAccount(db, { slug: "grp-b", name: "B", ownerEmail: "owner@b.test" })).id;
  await call("GET", "/v1/me");
  await call("GET", "/v1/me", { as: "owner@b.test" });
  await call("POST", "/v1/account/invitations", { body: { email: "editor@a.test", role: "editor" } });
  await call("GET", "/v1/me", { as: "editor@a.test" });
});
afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await tdb?.stop();
});

describe("/v1/user-groups", () => {
  it("creates, lists and archives groups, and events and offers name them", async () => {
    const created = await call("POST", "/v1/user-groups", { body: { code: "member", names: { nb: "Medlem" } }, headers: { "idempotency-key": "g-1" } });
    expect(created).toMatchObject({ status: 201, body: { code: "member", names: { nb: "Medlem" }, archived: false, usedBy: 0, version: 1 } });
    expect(created.headers.etag).toBe('"1"');
    // A retry with the same key returns the same group.
    expect((await call("POST", "/v1/user-groups", { body: { code: "member", names: { nb: "Medlem" } }, headers: { "idempotency-key": "g-1" } })).body.id).toBe(created.body.id);
    expect((await call("POST", "/v1/user-groups", { body: { code: "member", names: { nb: "X" } } })).status).toBe(409);
    expect((await call("POST", "/v1/user-groups", { body: { code: "Bad Code", names: { nb: "X" } } })).status).toBe(400);
    expect((await call("POST", "/v1/user-groups", { as: "editor@a.test", body: { code: "x", names: { nb: "X" } } })).status).toBe(403);
    // Members can read; another account sees none.
    expect((await call("GET", "/v1/user-groups", { as: "editor@a.test" })).body.items).toHaveLength(1);
    expect((await call("GET", "/v1/user-groups", { as: "owner@b.test", account: B })).body.items).toEqual([]);

    const groupId = created.body.id;
    const event = await call("POST", "/v1/events", { as: "editor@a.test", body: { translations: { nb: { title: "Medlemskveld" } }, admissionMode: "tickets", accessGroupIds: [groupId] } });
    expect(event).toMatchObject({ status: 201, body: { accessGroupIds: [groupId] } });
    // Another account's group is unknown here.
    const foreign = await call("POST", "/v1/user-groups", { as: "owner@b.test", account: B, body: { code: "member", names: { nb: "Medlem" } } });
    expect((await call("PATCH", `/v1/events/${event.body.id}`, { as: "editor@a.test", body: { accessGroupIds: [foreign.body.id] }, headers: { "if-match": '"1"' } })).status).toBe(422);

    const vat = await call("POST", "/v1/vat-classes", { body: { code: "exempt", label: "Fritatt", ratePct: 0 } });
    const offer = await call("POST", `/v1/events/${event.body.id}/offers`, { body: { translations: { nb: { name: "Voksen" } }, vatClassId: vat.body.id, defaultPrice: 45000, accessGroupIds: [groupId] } });
    expect(offer).toMatchObject({ status: 201, body: { offer: { accessGroupIds: [groupId] } } });

    const used = (await call("GET", "/v1/user-groups")).body.items[0];
    expect(used.usedBy).toBe(2);
    const refused = await call("PATCH", `/v1/user-groups/${groupId}`, { body: { archived: true }, headers: { "if-match": `"${used.version}"` } });
    expect(refused).toMatchObject({ status: 409, body: { code: "conflict" } });
    expect((await call("PATCH", `/v1/user-groups/${groupId}`, { body: { names: { nb: "Medlemmer" } } })).status).toBe(428);
    const renamed = await call("PATCH", `/v1/user-groups/${groupId}`, { body: { names: { nb: "Medlemmer", en: "Members" } }, headers: { "if-match": `"${used.version}"` } });
    expect(renamed).toMatchObject({ status: 200, body: { names: { nb: "Medlemmer", en: "Members" }, version: 2 } });
  });

  it("prices offers per group, takes group price rules and group overrides, and shows a group in the price grid", async () => {
    const group = (await call("POST", "/v1/user-groups", { body: { code: "sponsor", names: { nb: "Sponsor" } } })).body;
    const vat = (await call("GET", "/v1/vat-classes")).body.items[0];
    const eventId = (await call("POST", "/v1/events", { body: { translations: { nb: { title: "Konsert" } }, admissionMode: "tickets" } })).body.id;
    const occ = (await call("POST", `/v1/events/${eventId}/occurrences`, { body: { startUtc: "2027-02-13T18:30:00Z" } })).body;
    const created = await call("POST", `/v1/events/${eventId}/offers`, { body: { translations: { nb: { name: "Voksen" } }, vatClassId: vat.id, defaultPrice: 45000, groupPrices: [{ groupId: group.id, amount: 35000 }] } });
    expect(created).toMatchObject({ status: 201, body: { offer: { groupPrices: [{ groupId: group.id, amount: 35000 }] }, resolution: "done" } });
    const offerId = created.body.offer.id;

    const rule = await call("POST", `/v1/events/${eventId}/rules`, {
      body: { name: "Helg", conditions: { weekdays: [6, 7] }, effects: [{ type: "price", targetRef: offerId, targetGroup: group.id, value: { amount: 30000 } }] },
    });
    expect(rule.status).toBe(201);
    expect(rule.body.rule.effects[0]).toMatchObject({ type: "price", targetRef: offerId, targetGroup: group.id });
    expect(rule.body.preview.changes[0].fields[0]).toMatchObject({ field: "price", targetRef: offerId, group: group.id, to: { value: 30000, source: "rule" } });
    // offerAvailable takes no group.
    expect((await call("POST", `/v1/events/${eventId}/rules`, { body: { name: "X", effects: [{ type: "offerAvailable", targetRef: offerId, targetGroup: group.id, value: false }] } })).status).toBe(400);

    const grid = await call("GET", `/v1/events/${eventId}/prices?groupId=${group.id}`);
    expect(grid.body.items[0].cells[0]).toMatchObject({ price: { value: 45000 }, group: { groupId: group.id, price: { value: 30000, source: "rule" }, inherited: false, override: null } });
    expect((await call("GET", `/v1/events/${eventId}/prices`)).body.items[0].cells[0].group).toBeUndefined();

    const url = `/v1/offers/${offerId}/occurrences/${occ.id}/groups/${group.id}/override`;
    expect(await call("PUT", url, { body: { amount: 25000 } })).toMatchObject({ status: 200, body: { price: { value: 25000, source: "override" }, override: 25000 } });
    expect((await call("PUT", url, { as: "editor@a.test", body: { amount: 1 } })).status).toBe(403);
    expect(await call("DELETE", url)).toMatchObject({ status: 200, body: { price: { value: 30000, source: "rule" }, override: null } });
  });
});
