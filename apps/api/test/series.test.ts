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
  A = (await tenancy.createAccount(db, { slug: "ser-a", name: "A", ownerEmail: "owner@a.test" })).id;
  B = (await tenancy.createAccount(db, { slug: "ser-b", name: "B", ownerEmail: "owner@b.test" })).id;
  await call("GET", "/v1/me");
  await call("GET", "/v1/me", { as: "owner@b.test" });
});
afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await tdb?.stop();
});

describe("/v1 series", () => {
  it("previews, creates, edits, splits and deletes a series with ETags", async () => {
    const event = await call("POST", "/v1/events", { body: { translations: { nb: { title: "Omvisning" } }, defaultDurationMin: 45 } });
    const eventId = event.body.id;
    const rule = { rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=24", dtstartLocal: "2027-01-04T14:00" };

    const preview = await call("POST", `/v1/events/${eventId}/series?dryRun=true`, { body: rule });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ series: null, changes: { counts: { created: 24 } } });
    expect(preview.body.changes.created[0]).toMatchObject({ occurrenceId: null, recurrenceIdLocal: "2027-01-04T14:00:00", startUtc: "2027-01-04T13:00:00.000Z", endUtc: "2027-01-04T13:45:00.000Z" });
    expect((await call("GET", `/v1/events/${eventId}/occurrences`)).body.items).toEqual([]);

    const bad = await call("POST", `/v1/events/${eventId}/series`, { body: { ...rule, rrule: "FREQ=MINUTELY" } });
    expect(bad).toMatchObject({ status: 422, body: { code: "validation_failed", details: { field: "rrule" } } });

    const created = await call("POST", `/v1/events/${eventId}/series`, { body: rule, headers: { "idempotency-key": "series-1" } });
    expect(created.status).toBe(201);
    expect(created.headers.etag).toBe('"1"');
    const seriesId = created.body.series.id;
    expect(created.body.series).toMatchObject({ rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=24", dtstartLocal: "2027-01-04T14:00:00", durationMin: 45, timezone: "Europe/Oslo", complete: true });
    const replay = await call("POST", `/v1/events/${eventId}/series`, { body: rule, headers: { "idempotency-key": "series-1" } });
    expect(replay.body.series.id).toBe(seriesId);
    expect((await call("GET", `/v1/events/${eventId}/series`)).body.items).toHaveLength(1);

    let occs = (await call("GET", `/v1/events/${eventId}/occurrences?seriesId=${seriesId}`)).body.items;
    expect(occs).toHaveLength(24);
    expect(occs[0]).toMatchObject({ seriesId, recurrenceIdLocal: "2027-01-04T14:00:00", detached: false, conflict: false });

    // This occurrence: move it to 16:00 → detached. Cancelling another does not detach.
    const moved = await call("PATCH", `/v1/occurrences/${occs[2].id}`, { body: { startUtc: "2027-01-08T15:00:00Z" }, headers: { "if-match": `"${occs[2].version}"` } });
    expect(moved.body).toMatchObject({ detached: true, conflict: false });
    const cancelled = await call("PATCH", `/v1/occurrences/${occs[3].id}`, { body: { status: "cancelled" }, headers: { "if-match": `"${occs[3].version}"` } });
    expect(cancelled.body).toMatchObject({ status: "cancelled", detached: false });

    // Delete this occurrence → EXDATE on the series, whose ETag changes.
    const del = await call("DELETE", `/v1/occurrences/${occs[4].id}`, { headers: { "if-match": `"${occs[4].version}"` } });
    expect(del.status).toBe(204);
    const series = await call("GET", `/v1/series/${seriesId}`);
    expect(series.body.exdates).toEqual(["2027-01-13T14:00:00"]);
    expect(series.headers.etag).toBe('"2"');

    // Entire series: If-Match is required and checked.
    expect((await call("PATCH", `/v1/series/${seriesId}`, { body: { dtstartLocal: "2027-01-04T15:00" } })).status).toBe(428);
    expect((await call("PATCH", `/v1/series/${seriesId}`, { body: { dtstartLocal: "2027-01-04T15:00" }, headers: { "if-match": '"1"' } })).status).toBe(412);
    const dry = await call("PATCH", `/v1/series/${seriesId}?dryRun=true`, { body: { dtstartLocal: "2027-01-04T15:00" }, headers: { "if-match": '"2"' } });
    expect(dry.body.changes.counts).toEqual({ created: 0, moved: 22, deleted: 0, conflicts: 1, unchanged: 0 });
    const edited = await call("PATCH", `/v1/series/${seriesId}`, { body: { dtstartLocal: "2027-01-04T15:00" }, headers: { "if-match": '"2"' } });
    expect(edited.status).toBe(200);
    expect(edited.headers.etag).toBe('"3"');
    expect(edited.body.changes.conflicts).toMatchObject([{ occurrenceId: occs[2].id, reason: "moved" }]);

    occs = (await call("GET", `/v1/events/${eventId}/occurrences`)).body.items;
    const flagged = occs.find((o: { id: string }) => o.id === moved.body.id);
    expect(flagged).toMatchObject({ startUtc: "2027-01-08T15:00:00.000Z", conflict: true });
    // Keep as is: dismiss the conflict.
    const kept = await call("PATCH", `/v1/occurrences/${flagged.id}`, { body: { conflict: false }, headers: { "if-match": `"${flagged.version}"` } });
    expect(kept.body).toMatchObject({ conflict: false, detached: true, startUtc: "2027-01-08T15:00:00.000Z" });
    // Or put it back on the series' slot.
    const back = await call("POST", `/v1/occurrences/${flagged.id}/reattach`, { headers: { "if-match": `"${kept.body.version}"` } });
    expect(back.body).toMatchObject({ detached: false, startUtc: "2027-01-08T14:00:00.000Z" });

    // This and following from the 10th slot: 30-minute later start.
    const at = occs[8];
    const split = await call("POST", `/v1/series/${seriesId}/split`, { body: { at: at.recurrenceIdLocal, dtstartLocal: at.recurrenceIdLocal.replace("T15:00", "T15:30") }, headers: { "if-match": '"3"' } });
    expect(split.status).toBe(200);
    expect(split.body.series).toMatchObject({ dtstartLocal: at.recurrenceIdLocal.replace("T15:00", "T15:30"), rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=15" });
    expect((await call("GET", `/v1/events/${eventId}/series`)).body.items).toHaveLength(2);
    expect((await call("GET", `/v1/occurrences/${at.id}`)).body).toMatchObject({ seriesId: split.body.series.id });

    // Another tenant sees none of it.
    expect((await call("GET", `/v1/series/${seriesId}`, { as: "owner@b.test", account: B })).status).toBe(404);

    const gone = await call("DELETE", `/v1/series/${split.body.series.id}`, { headers: { "if-match": `"${split.body.series.version}"` } });
    expect(gone.status).toBe(200);
    expect(gone.body.changes.counts.deleted).toBe(15);
    expect((await call("GET", `/v1/series/${split.body.series.id}`)).status).toBe(404);
  });
});
