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
  A = (await tenancy.createAccount(db, { slug: "cat-a", name: "A", ownerEmail: "owner@a.test" })).id;
  B = (await tenancy.createAccount(db, { slug: "cat-b", name: "B", ownerEmail: "owner@b.test" })).id;
  await call("GET", "/v1/me");
  await call("GET", "/v1/me", { as: "owner@b.test" });
});
afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await tdb?.stop();
});

describe("/v1 catalog", () => {
  let venueId: string;
  let spaceId: string;
  let eventId: string;
  let eventEtag: string;

  it("creates venues and spaces and edits them with If-Match", async () => {
    const venue = await call("POST", "/v1/locations", { body: { kind: "venue", name: "MUNCH", geo: { lat: 59.906, lng: 10.755 } } });
    expect(venue.status).toBe(201);
    expect(venue.headers.etag).toBe('"1"');
    venueId = venue.body.id;
    const space = await call("POST", "/v1/locations", { body: { kind: "space", parentId: venueId, name: "Floor 12" } });
    spaceId = space.body.id;

    const bad = await call("POST", "/v1/locations", { body: { kind: "space", name: "Orphan" } });
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({ code: "validation_failed", details: { field: "parentId" } });

    const renamed = await call("PATCH", `/v1/locations/${spaceId}`, { body: { name: "Floor 13" }, headers: { "if-match": '"1"' } });
    expect(renamed.status).toBe(200);
    expect(renamed.headers.etag).toBe('"2"');
    const stale = await call("PATCH", `/v1/locations/${spaceId}`, { body: { name: "X" }, headers: { "if-match": '"1"' } });
    expect(stale.status).toBe(412);

    const list = await call("GET", "/v1/locations");
    expect(list.body.items.map((l: { name: string }) => l.name).sort()).toEqual(["Floor 13", "MUNCH"]);
  });

  it("hides other tenants' locations and events (404, not 403)", async () => {
    const res = await call("GET", `/v1/locations/${venueId}`, { as: "owner@b.test", account: B });
    expect(res.status).toBe(404);
    const ref = await call("POST", "/v1/events", { as: "owner@b.test", account: B, body: { translations: { nb: { title: "X" } }, defaultLocationId: venueId } });
    expect(ref.status).toBe(422);
  });

  it("creates an event idempotently", async () => {
    const body = { translations: { nb: { title: "Omvisning" }, en: { title: "Guided tour" } }, defaultLocationId: venueId, externalUrl: "https://tix.example/tour" };
    const first = await call("POST", "/v1/events", { body, headers: { "idempotency-key": "create-tour" } });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ slug: "omvisning", status: "draft", admissionMode: "external" });
    const replay = await call("POST", "/v1/events", { body, headers: { "idempotency-key": "create-tour" } });
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(first.body.id);
    const reused = await call("POST", "/v1/events", { body: { ...body, slug: "other" }, headers: { "idempotency-key": "create-tour" } });
    expect(reused.status).toBe(422);
    expect(reused.body.code).toBe("idempotency_key_reused");
    const list = await call("GET", "/v1/events?q=tour");
    expect(list.body.items).toHaveLength(1);
    eventId = first.body.id;
    eventEtag = first.headers.etag as string;
  });

  it("adds, overrides and deletes one-off occurrences with effective values", async () => {
    const occ = await call("POST", `/v1/events/${eventId}/occurrences`, { body: { startUtc: "2026-12-01T13:00:00Z" } });
    expect(occ.status).toBe(201);
    expect(occ.body.effective.location).toEqual({ value: venueId, source: "default", ruleId: null });
    const moved = await call("PATCH", `/v1/occurrences/${occ.body.id}`, { body: { locationOverrideId: spaceId }, headers: { "if-match": occ.headers.etag as string } });
    expect(moved.status).toBe(200);
    expect(moved.body.effective.location).toEqual({ value: spaceId, source: "override", ruleId: null });
    const both = await call("PATCH", `/v1/occurrences/${occ.body.id}`, { body: { locationOverrideId: spaceId, locationOverrideCleared: true }, headers: { "if-match": moved.headers.etag as string } });
    expect(both.status).toBe(422);
    const cleared = await call("PATCH", `/v1/occurrences/${occ.body.id}`, { body: { locationOverrideCleared: true }, headers: { "if-match": moved.headers.etag as string } });
    expect(cleared.status).toBe(200);
    expect(cleared.body.overrides).toMatchObject({ locationId: null, locationCleared: true, externalUrlCleared: false });
    expect(cleared.body.effective.location).toEqual({ value: null, source: "override", ruleId: null });

    const second = await call("POST", `/v1/events/${eventId}/occurrences`, { body: { startUtc: "2026-12-02T13:00:00Z", endUtc: "2026-12-02T15:00:00Z" } });
    const p1 = await call("GET", `/v1/events/${eventId}/occurrences?limit=1`);
    expect(p1.body.items[0].id).toBe(occ.body.id);
    const p2 = await call("GET", `/v1/events/${eventId}/occurrences?limit=1&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items[0].id).toBe(second.body.id);
    expect(p2.body.nextCursor).toBeNull();

    const noMatch = await call("DELETE", `/v1/occurrences/${second.body.id}`);
    expect(noMatch.status).toBe(428);
    const del = await call("DELETE", `/v1/occurrences/${second.body.id}`, { headers: { "if-match": second.headers.etag as string } });
    expect(del.status).toBe(204);
    expect((await call("GET", `/v1/occurrences/${second.body.id}`)).status).toBe(404);

    const bad = await call("GET", `/v1/events/${eventId}/occurrences?cursor=nope`);
    expect(bad.body.code).toBe("invalid_cursor");
  });

  it("publishes with If-Match and rejects invalid transitions", async () => {
    const pub = await call("POST", `/v1/events/${eventId}/publish`, { headers: { "if-match": eventEtag } });
    expect(pub.status).toBe(200);
    expect(pub.body.status).toBe("published");
    const again = await call("POST", `/v1/events/${eventId}/publish`, { headers: { "if-match": pub.headers.etag as string } });
    expect(again.status).toBe(409);
    const filtered = await call("GET", "/v1/events?status=published");
    expect(filtered.body.items.map((e: { id: string }) => e.id)).toEqual([eventId]);

    const audit = await call("GET", `/v1/audit?entityType=event&entityId=${eventId}`);
    expect(audit.body.items.map((a: { action: string }) => a.action)).toEqual(
      expect.arrayContaining(["event.created", "event.published", "occurrence.created", "occurrence.updated", "occurrence.deleted"]),
    );
  });

  it("tag vocabularies are owner-managed; editors assign tags", async () => {
    const vocab = await call("POST", "/v1/tag-vocabularies", { body: { key: "category", labels: { nb: "Kategori", en: "Category" } } });
    expect(vocab.status).toBe(201);
    const tag = await call("POST", `/v1/tag-vocabularies/${vocab.body.id}/tags`, { body: { key: "tour", labels: { nb: "Omvisning" } } });
    expect(tag.status).toBe(201);

    await call("POST", "/v1/account/invitations", { body: { email: "editor@a.test", role: "editor" } });
    await call("GET", "/v1/me", { as: "editor@a.test" });
    const denied = await call("POST", "/v1/tag-vocabularies", { as: "editor@a.test", body: { key: "audience", labels: {} } });
    expect(denied.status).toBe(403);

    const ev = await call("GET", `/v1/events/${eventId}`, { as: "editor@a.test" });
    const tagged = await call("PATCH", `/v1/events/${eventId}`, { as: "editor@a.test", body: { tagIds: [tag.body.id] }, headers: { "if-match": ev.headers.etag as string } });
    expect(tagged.status).toBe(200);
    expect(tagged.body.tagIds).toEqual([tag.body.id]);
    const byTag = await call("GET", `/v1/events?tagId=${tag.body.id}`, { as: "editor@a.test" });
    expect(byTag.body.items).toHaveLength(1);
  });

  it("API keys: owner only, secret shown once, revocable", async () => {
    const denied = await call("GET", "/v1/api-keys", { as: "editor@a.test" });
    expect(denied.status).toBe(403);
    const created = await call("POST", "/v1/api-keys", { body: { kind: "publishable", label: "Website" } });
    expect(created.status).toBe(201);
    expect(created.body.secret).toMatch(/^pk_[A-Za-z0-9]{12}_[A-Za-z0-9_-]{43}$/);
    expect(await tenancy.verifyApiKey(db, created.body.secret, "publishable")).toEqual({ tenantId: A, kind: "publishable", channelId: null });
    expect(await tenancy.verifyApiKey(db, created.body.secret, "preview")).toBeNull();
    expect(await tenancy.verifyApiKey(db, `${created.body.secret.slice(0, -1)}x`, "publishable")).toBeNull();

    const list = await call("GET", "/v1/api-keys");
    expect(list.body.items[0]).not.toHaveProperty("secret");
    const revoked = await call("DELETE", `/v1/api-keys/${created.body.id}`);
    expect(revoked.status).toBe(204);
    expect(await tenancy.verifyApiKey(db, created.body.secret, "publishable")).toBeNull();
  });
});

describe("/v1 registration settings and capacity", () => {
  it("round-trips settings and shows each occurrence's pool", async () => {
    const created = await call("POST", "/v1/events", {
      body: { translations: { nb: { title: "Galla" } }, admissionMode: "registration", registration: { accessPolicy: "invite_only", capacity: 120, overbookingPct: 5 } },
    });
    expect(created.status).toBe(201);
    expect(created.body.registration).toMatchObject({ accessPolicy: "invite_only", listed: false, capacity: 120, overbookingPct: 5, closesMinBefore: 0 });

    const bad = await call("PATCH", `/v1/events/${created.body.id}`, { body: { registration: { overbookingPct: 101 } }, headers: { "if-match": created.headers.etag as string } });
    expect(bad.status).toBe(400);

    const occ = await call("POST", `/v1/events/${created.body.id}/occurrences`, { body: { startUtc: "2027-06-01T17:00:00Z", capacityOverride: 100 } });
    expect(occ.status).toBe(201);
    expect(occ.body.overrides.capacity).toBe(100);
    expect(occ.body.effective.capacity).toMatchObject({ value: 100, source: "override" });
    expect(occ.body.pool).toMatchObject({ capacity: 100, overbookingPct: 5, bookableLimit: 105, taken: 0, available: 105, overLimit: false });
  });

  it("keeps null as no limit instead of coercing it to 0", async () => {
    const created = await call("POST", "/v1/events", {
      body: { translations: { nb: { title: "Uten grense" } }, admissionMode: "registration", registration: { capacity: null, opensMinBefore: null, closesMinBefore: 0 } },
    });
    expect(created.status).toBe(201);
    expect(created.body.registration).toMatchObject({ capacity: null, opensMinBefore: null });
    const occ = await call("POST", `/v1/events/${created.body.id}/occurrences`, { body: { startUtc: "2027-06-02T17:00:00Z", capacityOverride: null } });
    expect(occ.body.pool).toMatchObject({ capacity: null, bookableLimit: null, available: null });
  });

  it("keeps 0 as zero places instead of coercing it to null (#46)", async () => {
    const created = await call("POST", "/v1/events", {
      body: { translations: { nb: { title: "Fullt" } }, admissionMode: "registration", registration: { capacity: 0 } },
    });
    expect(created.status).toBe(201);
    expect(created.body.registration.capacity).toBe(0);
    const inherits = await call("POST", `/v1/events/${created.body.id}/occurrences`, { body: { startUtc: "2027-06-03T17:00:00Z" } });
    expect(inherits.body.pool).toMatchObject({ capacity: 0, bookableLimit: 0, available: 0 });

    // Patch the event: positive, then 0 again, then null (no limit).
    let etag = created.headers.etag as string;
    for (const capacity of [40, 0, null]) {
      const r = await call("PATCH", `/v1/events/${created.body.id}`, { body: { registration: { capacity } }, headers: { "if-match": etag } });
      expect(r.status).toBe(200);
      expect(r.body.registration.capacity).toBe(capacity);
      etag = r.headers.etag as string;
    }
    await call("PATCH", `/v1/events/${created.body.id}`, { body: { registration: { capacity: 40 } }, headers: { "if-match": etag } });

    // A zero override wins over the positive default; null inherits it again.
    const occ = await call("POST", `/v1/events/${created.body.id}/occurrences`, { body: { startUtc: "2027-06-04T17:00:00Z", capacityOverride: 0 } });
    expect(occ.body.overrides.capacity).toBe(0);
    expect(occ.body.pool).toMatchObject({ capacity: 0, bookableLimit: 0, available: 0 });
    let v = occ.headers.etag as string;
    for (const [capacityOverride, poolCapacity] of [[5, 5], [0, 0], [null, 40]] as const) {
      const r = await call("PATCH", `/v1/occurrences/${occ.body.id}`, { body: { capacityOverride }, headers: { "if-match": v } });
      expect(r.status).toBe(200);
      expect(r.body.overrides.capacity).toBe(capacityOverride);
      expect(r.body.pool.capacity).toBe(poolCapacity);
      v = r.headers.etag as string;
    }
  });
});
