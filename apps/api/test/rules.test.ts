import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { tenancy } from "@event-manager/domain";
import { buildApp } from "../src/app.js";
import { DEV_ISSUER, devVerifier } from "../src/auth.js";

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
  A = (await tenancy.createAccount(db, { slug: "rul-a", name: "A", ownerEmail: "owner@a.test" })).id;
  B = (await tenancy.createAccount(db, { slug: "rul-b", name: "B", ownerEmail: "owner@b.test" })).id;
  await call("GET", "/v1/me");
  await call("GET", "/v1/me", { as: "owner@b.test" });
});
afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await tdb?.stop();
});

describe("/v1 rules", () => {
  it("previews, creates, edits and deletes rules with ETags, and bulk-overrides occurrences", async () => {
    const venue = (await call("POST", "/v1/locations", { body: { kind: "venue", name: "MUNCH" } })).body;
    const rooftop = (await call("POST", "/v1/locations", { body: { kind: "space", parentId: venue.id, name: "Rooftop" } })).body;
    const eventId = (await call("POST", "/v1/events", { body: { translations: { nb: { title: "Omvisning" } }, defaultLocationId: venue.id } })).body.id;
    await call("POST", `/v1/events/${eventId}/series`, { body: { rrule: "FREQ=DAILY;BYHOUR=12,19;COUNT=20", dtstartLocal: "2027-06-01T12:00" } });

    const rule = { name: "Sommerkveld", priority: 5, conditions: { dateFrom: "2027-06-01", dateTo: "2027-08-31", startTimeFrom: "18:00" }, effects: [{ type: "location", value: rooftop.id }] };
    const bad = await call("POST", `/v1/events/${eventId}/rules`, { body: { ...rule, effects: [{ type: "price", value: 1 }] } });
    expect(bad.status).toBe(400); // not one of the effect types in the schema
    const badRef = await call("POST", `/v1/events/${eventId}/rules`, { body: { ...rule, effects: [{ type: "location", value: "0190a000-0000-7000-8000-000000000000" }] } });
    expect(badRef).toMatchObject({ status: 422, body: { code: "validation_failed" } });

    const dry = await call("POST", `/v1/events/${eventId}/rules?dryRun=true`, { body: rule });
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ rule: null, resolution: "none", preview: { counts: { matched: 10, changed: 10, overridden: 0, conflicts: 0 } } });
    expect(dry.body.preview.changes[0].fields).toEqual([{ field: "location", targetRef: null, group: null, from: { value: venue.id, source: "default", ruleId: null }, to: { value: rooftop.id, source: "rule", ruleId: expect.any(String) } }]);
    expect((await call("GET", `/v1/events/${eventId}/rules`)).body.items).toEqual([]);

    const created = await call("POST", `/v1/events/${eventId}/rules`, { body: rule, headers: { "idempotency-key": "rule-1" } });
    expect(created.status).toBe(201);
    expect(created.headers.etag).toBe('"1"');
    expect(created.body).toMatchObject({ resolution: "done", rule: { name: "Sommerkveld", priority: 5, active: true, effects: [{ type: "location", targetRef: null, value: rooftop.id }] } });
    const ruleId = created.body.rule.id;
    const replay = await call("POST", `/v1/events/${eventId}/rules`, { body: rule, headers: { "idempotency-key": "rule-1" } });
    expect(replay.body.rule.id).toBe(ruleId);

    let occs = (await call("GET", `/v1/events/${eventId}/occurrences`)).body.items;
    const evening = occs.filter((o: { effective: { location: { source: string } } }) => o.effective.location.source === "rule");
    expect(evening).toHaveLength(10);
    expect(evening[0].effective.location).toEqual({ value: rooftop.id, source: "rule", ruleId });

    // Edits need If-Match; switching the rule off restores the defaults.
    expect((await call("PATCH", `/v1/rules/${ruleId}`, { body: { active: false } })).status).toBe(428);
    expect((await call("PATCH", `/v1/rules/${ruleId}`, { body: { active: false }, headers: { "if-match": '"9"' } })).status).toBe(412);
    const off = await call("PATCH", `/v1/rules/${ruleId}`, { body: { active: false }, headers: { "if-match": '"1"' } });
    expect(off).toMatchObject({ status: 200, headers: { etag: '"2"' }, body: { rule: { active: false }, preview: { counts: { changed: 10 } } } });
    occs = (await call("GET", `/v1/events/${eventId}/occurrences`)).body.items;
    expect(occs.every((o: { effective: { location: { source: string } } }) => o.effective.location.source === "default")).toBe(true);
    await call("PATCH", `/v1/rules/${ruleId}`, { body: { active: true }, headers: { "if-match": '"2"' } });

    // Bulk override: the first three evening occurrences move back indoors.
    const items = evening.slice(0, 3).map((o: { id: string }) => ({ id: o.id, version: occs.find((x: { id: string }) => x.id === o.id).version }));
    const bulk = await call("POST", `/v1/events/${eventId}/occurrences/bulk-update`, { body: { items, set: { locationOverrideId: venue.id } } });
    expect(bulk.status).toBe(200);
    expect(bulk.body.items.map((o: { effective: { location: { source: string } }; detached: boolean }) => [o.effective.location.source, o.detached])).toEqual([["override", true], ["override", true], ["override", true]]);
    const staleBulk = await call("POST", `/v1/events/${eventId}/occurrences/bulk-update`, { body: { items, set: { status: "cancelled" } } });
    expect(staleBulk.status).toBe(412);

    const delDry = await call("DELETE", `/v1/rules/${ruleId}?dryRun=true`, { headers: { "if-match": '"3"' } });
    expect(delDry.body).toMatchObject({ rule: { id: ruleId }, preview: { counts: { matched: 10, changed: 7, overridden: 3 } } });
    expect((await call("GET", `/v1/rules/${ruleId}`, { as: "owner@b.test", account: B })).status).toBe(404);
    const del = await call("DELETE", `/v1/rules/${ruleId}`, { headers: { "if-match": '"3"' } });
    expect(del.body).toMatchObject({ rule: null, resolution: "done" });
    expect((await call("GET", `/v1/rules/${ruleId}`)).status).toBe(404);
  });
});
