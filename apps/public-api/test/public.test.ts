import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { type ActorContext, catalog, offers, tenancy } from "@event-manager/domain";
import { buildPublicApp } from "../src/app.js";

let tdb: TestDatabase;
let db: Db;
let admin: pg.Client;
let app: Awaited<ReturnType<typeof buildPublicApp>>;
let keyA: string;
let keyB: string;
let previewA: string;
let ctxA: ActorContext;
const ids: Record<string, string> = {};

const DAY = 86_400_000;
const inDays = (d: number, hourUtc = 13) => {
  const t = new Date(Date.now() + d * DAY);
  t.setUTCHours(hourUtc, 0, 0, 0);
  return t;
};

async function get(url: string, headers: Record<string, string> = {}) {
  const res = await app.inject({ method: "GET", url, headers });
  return { status: res.statusCode, headers: res.headers, body: res.body ? res.json() : undefined };
}

async function bootstrap(slug: string): Promise<ActorContext> {
  const email = `owner@${slug}.test`;
  const account = await tenancy.createAccount(db, { slug, name: slug, ownerEmail: email, locales: ["nb", "en"] });
  const userId = await tenancy.login(db, { issuer: "https://idp.test", subject: email, email, name: null });
  return { tenantId: account.id, userId, clientId: null, roles: ["owner"] };
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  admin = new pg.Client({ connectionString: tdb.superuserUrl });
  await admin.connect();
  app = await buildPublicApp({ db, rateLimit: { capacity: 1000, refillPerSecond: 1000 } });

  const a = await bootstrap("pub-a");
  ctxA = a;
  const b = await bootstrap("pub-b");

  await withTenant(db, a, async (tx) => {
    const venue = await catalog.createLocation(tx, a, { kind: "venue", name: "MUNCH" });
    const rooftop = await catalog.createLocation(tx, a, { kind: "space", parentId: venue.id, name: "Rooftop" });
    const vocab = await catalog.createVocabulary(tx, a, { key: "category", labels: { nb: "Kategori", en: "Category" } });
    const tour = await catalog.createTag(tx, a, vocab.id, { key: "tour", labels: { nb: "Omvisning", en: "Tour" } });
    Object.assign(ids, { venue: venue.id, rooftop: rooftop.id, tour: tour.id });

    let ev = await catalog.createEvent(tx, a, {
      slug: "guided-tour",
      translations: { nb: { title: "Omvisning", shortDescription: "Bli med" }, en: { title: "Guided tour" } },
      defaultLocationId: venue.id,
      externalUrl: "https://tix.example/tour",
      tagIds: [tour.id],
    });
    ev = await catalog.transitionEvent(tx, a, ev.id, ev.version, "publish");
    ids.event = ev.id;
    ids.o1 = (await catalog.createOccurrence(tx, a, ev.id, { startUtc: inDays(2) })).id;
    ids.o2 = (await catalog.createOccurrence(tx, a, ev.id, {
      startUtc: inDays(10, 17),
      locationOverrideId: rooftop.id,
      externalUrlOverride: "https://tix.example/evening",
    })).id;
    // The event has a ticket link; this occurrence explicitly has none.
    ids.late = (await catalog.createOccurrence(tx, a, ev.id, { startUtc: inDays(45), externalUrlOverrideCleared: true })).id;
    ids.past = (await catalog.createOccurrence(tx, a, ev.id, { startUtc: inDays(-3) })).id;
    const o3 = await catalog.createOccurrence(tx, a, ev.id, { startUtc: inDays(12) });
    await catalog.updateOccurrence(tx, a, o3.id, o3.version, { status: "cancelled" });
    ids.cancelled = o3.id;

    const nbOnly = await catalog.createEvent(tx, a, { slug: "konsert", translations: { nb: { title: "Konsert" } } });
    await catalog.transitionEvent(tx, a, nbOnly.id, nbOnly.version, "publish");
    ids.nbOnlyOcc = (await catalog.createOccurrence(tx, a, nbOnly.id, { startUtc: inDays(5) })).id;

    const draft = await catalog.createEvent(tx, a, { slug: "secret-draft", translations: { nb: { title: "Hemmelig" } } });
    ids.draftOcc = (await catalog.createOccurrence(tx, a, draft.id, { startUtc: inDays(3) })).id;

    keyA = (await tenancy.createApiKey(tx, a, "publishable", "web")).secret;
    previewA = (await tenancy.createApiKey(tx, a, "preview", "cms")).secret;
  });
  await withTenant(db, b, async (tx) => {
    const ev = await catalog.createEvent(tx, b, { slug: "guided-tour", translations: { nb: { title: "B sin omvisning" } } });
    await catalog.transitionEvent(tx, b, ev.id, ev.version, "publish");
    await catalog.createOccurrence(tx, b, ev.id, { startUtc: inDays(2) });
    keyB = (await tenancy.createApiKey(tx, b, "publishable", "web")).secret;
  });
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
  await db?.destroy();
  await tdb?.stop();
});

describe("/public/v1", () => {
  it("acceptance: lists the next 30 days in nb and en with effective location and ticket link", async () => {
    const from = new Date().toISOString();
    const to = new Date(Date.now() + 30 * DAY).toISOString();
    for (const locale of ["nb", "en"] as const) {
      const res = await get(`/public/v1/occurrences?key=${keyA}&locale=${locale}&from=${from}&to=${to}`);
      expect(res.status).toBe(200);
      expect(res.body.locale).toBe(locale);
      const items = res.body.items as { id: string; event: { title: string; locale: string }; location: { name: string; venue: { name: string } | null }; admission: unknown; tags: { label: string }[]; status: string }[];
      expect(items.map((o) => o.id)).toEqual([ids.o1, ids.nbOnlyOcc, ids.o2, ids.cancelled]);

      const [o1, nbOnly, o2, cancelled] = items;
      expect(o1!.event.title).toBe(locale === "nb" ? "Omvisning" : "Guided tour");
      expect(o1!.location).toMatchObject({ name: "MUNCH", kind: "venue", venue: null });
      expect(o1!.admission).toEqual({ mode: "external", url: "https://tix.example/tour" });
      expect(o1!.tags.map((t) => t.label)).toEqual([locale === "nb" ? "Omvisning" : "Tour"]);
      expect(o2!.location).toMatchObject({ name: "Rooftop", venue: { name: "MUNCH" } });
      expect(o2!.admission).toEqual({ mode: "external", url: "https://tix.example/evening" });
      expect(cancelled!.status).toBe("cancelled");
      // No English translation: falls back to the account default and says so.
      expect(nbOnly!.event).toMatchObject({ title: "Konsert", locale: "nb" });
      expect(nbOnly!.admission).toEqual({ mode: "none" });
    }
  });

  it("requires a valid key and never mixes tenants", async () => {
    expect((await get("/public/v1/occurrences")).body.code).toBe("key_required");
    expect((await get("/public/v1/occurrences?key=pk_nope")).status).toBe(401);
    const b = await get(`/public/v1/occurrences?key=${keyB}`);
    expect(b.body.items.map((o: { event: { title: string } }) => o.event.title)).toEqual(["B sin omvisning"]);
    const a = await get(`/public/v1/events/guided-tour?key=${keyA}`);
    expect(a.body.event.title).toBe("Omvisning");
    // A publishable key is not a preview token.
    expect((await get("/public/v1/occurrences", { authorization: `Bearer ${keyA}` })).status).toBe(401);
  });

  it("hides drafts and unresolved occurrences, but preview sees drafts and is never cached", async () => {
    const pub = await get(`/public/v1/occurrences?key=${keyA}&limit=200`);
    const pubIds = pub.body.items.map((o: { id: string }) => o.id);
    expect(pubIds).not.toContain(ids.draftOcc);
    expect(pubIds).not.toContain(ids.past);
    expect((await get(`/public/v1/events/secret-draft?key=${keyA}`)).status).toBe(404);

    const prev = await get("/public/v1/occurrences?limit=200", { authorization: `Bearer ${previewA}` });
    expect(prev.body.items.map((o: { id: string }) => o.id)).toContain(ids.draftOcc);
    expect(prev.headers["cache-control"]).toBe("private, no-store");
    expect(prev.headers.etag).toBeUndefined();

    // Simulate a change that the resolver has not caught up with yet.
    await admin.query("update catalog.occurrence set version = version + 1 where id = $1", [ids.o1]);
    const after = await get(`/public/v1/occurrences?key=${keyA}`);
    expect(after.body.items.map((o: { id: string }) => o.id)).not.toContain(ids.o1);
    await admin.query("update catalog.occurrence set resolved_version = version where id = $1", [ids.o1]);
  });

  it("sets edge cache headers and answers If-None-Match with 304", async () => {
    const url = `/public/v1/events?key=${keyA}&locale=en`;
    const first = await get(url);
    expect(first.headers["cache-control"]).toBe("public, max-age=0, s-maxage=30, stale-while-revalidate=300");
    expect(first.headers.etag).toMatch(/^W\/"/);
    const again = await app.inject({ method: "GET", url, headers: { "if-none-match": first.headers.etag as string } });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe("");
    const err = await get("/public/v1/occurrences?key=pk_nope");
    expect(err.headers["cache-control"]).toBe("no-store");
  });

  it("filters by venue (including spaces), tag, event and status, and pages with a cursor", async () => {
    const byRooftop = await get(`/public/v1/occurrences?key=${keyA}&location=${ids.rooftop}`);
    expect(byRooftop.body.items.map((o: { id: string }) => o.id)).toEqual([ids.o2]);
    const byVenue = await get(`/public/v1/occurrences?key=${keyA}&location=${ids.venue}&limit=200`);
    expect(byVenue.body.items.map((o: { id: string }) => o.id)).toEqual(expect.arrayContaining([ids.o1, ids.o2, ids.late]));
    const byTag = await get(`/public/v1/occurrences?key=${keyA}&tag=${ids.tour}&limit=200`);
    expect(byTag.body.items.every((o: { event: { slug: string } }) => o.event.slug === "guided-tour")).toBe(true);
    const cancelled = await get(`/public/v1/occurrences?key=${keyA}&status=cancelled`);
    expect(cancelled.body.items.map((o: { id: string }) => o.id)).toEqual([ids.cancelled]);

    const p1 = await get(`/public/v1/occurrences?key=${keyA}&event=guided-tour&limit=2`);
    expect(p1.body.items).toHaveLength(2);
    const p2 = await get(`/public/v1/occurrences?key=${keyA}&event=guided-tour&limit=2&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items[0].id).not.toBe(p1.body.items[1].id);
    expect(p2.body.items.map((o: { id: string }) => o.id)).toEqual([ids.cancelled, ids.late]);
  });

  it("returns the venue tree and an event page with its occurrences", async () => {
    const locs = await get(`/public/v1/locations?key=${keyA}`);
    expect(locs.body.items).toEqual([expect.objectContaining({ name: "MUNCH", spaces: [expect.objectContaining({ name: "Rooftop" })] })]);
    const ev = await get(`/public/v1/events/${ids.event}?key=${keyA}&locale=en`);
    expect(ev.body.event).toMatchObject({ slug: "guided-tour", title: "Guided tour", tags: [{ key: "tour", label: "Tour" }] });
    expect(ev.body.event.occurrences.map((o: { id: string }) => o.id)).toEqual([ids.o1, ids.o2, ids.cancelled, ids.late]);
    const occs = ev.body.event.occurrences as { id: string; admission: unknown; location: unknown }[];
    expect(occs.find((o) => o.id === ids.late)).toMatchObject({ admission: { mode: "none" }, location: { name: "MUNCH" } });
    expect(occs.find((o) => o.id === ids.o1)).toMatchObject({ admission: { mode: "external", url: "https://tix.example/tour" } });
  });

  it("serves rule-resolved locations, tags and ticket links", async () => {
    const c = await bootstrap("pub-rules");
    const key = await withTenant(db, c, async (tx) => {
      const venue = await catalog.createLocation(tx, c, { kind: "venue", name: "MUNCH" });
      const rooftop = await catalog.createLocation(tx, c, { kind: "space", parentId: venue.id, name: "Rooftop" });
      const vocab = await catalog.createVocabulary(tx, c, { key: "program", labels: { nb: "Program", en: "Programme" } });
      const late = await catalog.createTag(tx, c, vocab.id, { key: "late-opening", labels: { nb: "Kveldsåpent", en: "Late opening" } });
      let ev = await catalog.createEvent(tx, c, {
        slug: "tour", translations: { nb: { title: "Omvisning" } }, defaultLocationId: venue.id, externalUrl: "https://tix.example/day",
      });
      ev = await catalog.transitionEvent(tx, c, ev.id, ev.version, "publish");
      ids.cDay = (await catalog.createOccurrence(tx, c, ev.id, { startUtc: inDays(3, 10) })).id;
      ids.cEvening = (await catalog.createOccurrence(tx, c, ev.id, { startUtc: inDays(3, 18) })).id;
      // Europe/Oslo is UTC+1 or +2, so 18:00 UTC is 19:00 or 20:00 local.
      await catalog.createRule(tx, c, ev.id, {
        name: "Kveld", conditions: { startTimeFrom: "18:00" },
        effects: [{ type: "location", value: rooftop.id }, { type: "tags", value: { add: [late.id] } }, { type: "externalUrl", value: "https://tix.example/evening" }],
      });
      return (await tenancy.createApiKey(tx, c, "publishable", "web")).secret;
    });
    const res = await get(`/public/v1/occurrences?key=${key}&locale=en`);
    const byId = new Map(res.body.items.map((o: { id: string }) => [o.id, o]));
    expect(byId.get(ids.cDay)).toMatchObject({ location: { name: "MUNCH" }, tags: [], admission: { mode: "external", url: "https://tix.example/day" } });
    expect(byId.get(ids.cEvening)).toMatchObject({
      location: { name: "Rooftop", venue: { name: "MUNCH" } }, tags: [{ key: "late-opening", label: "Late opening" }], admission: { mode: "external", url: "https://tix.example/evening" },
    });
  });

  it("serves tags from rules that name them in uppercase (#43)", async () => {
    const c = await bootstrap("pub-upper");
    const key = await withTenant(db, c, async (tx) => {
      const vocab = await catalog.createVocabulary(tx, c, { key: "program", labels: { nb: "Program", en: "Programme" } });
      const kept = await catalog.createTag(tx, c, vocab.id, { key: "kept", labels: { nb: "Beholdt", en: "Kept" } });
      const dropped = await catalog.createTag(tx, c, vocab.id, { key: "dropped", labels: { nb: "Fjernet", en: "Dropped" } });
      const added = await catalog.createTag(tx, c, vocab.id, { key: "added", labels: { nb: "Lagt til", en: "Added" } });
      let ev = await catalog.createEvent(tx, c, { slug: "upper", translations: { nb: { title: "Store bokstaver" } }, tagIds: [kept.id, dropped.id] });
      ev = await catalog.transitionEvent(tx, c, ev.id, ev.version, "publish");
      ids.upper = (await catalog.createOccurrence(tx, c, ev.id, { startUtc: inDays(4) })).id;
      await catalog.createRule(tx, c, ev.id, {
        name: "Store", effects: [{ type: "tags", value: { add: [added.id.toUpperCase()], remove: [dropped.id.toUpperCase()] } }],
      });
      return (await tenancy.createApiKey(tx, c, "publishable", "web")).secret;
    });
    const res = await get(`/public/v1/occurrences?key=${key}&locale=en`);
    const occ = res.body.items.find((o: { id: string }) => o.id === ids.upper);
    expect(occ.tags.map((t: { key: string }) => t.key).sort()).toEqual(["added", "kept"]);
  });

  it("channel keys see their channel's offers with SKUs and places left, uncached, and stop with their channel", async () => {
    const c = await bootstrap("pub-tickets");
    const setup = await withTenant(db, c, async (tx) => {
      const vat = await offers.createVatClass(tx, c, { code: "exempt", label: "Fritatt", ratePct: 0 });
      const web = await offers.createChannel(tx, c, { code: "web", name: "Nett", kind: "ecom" });
      const pos = await offers.createChannel(tx, c, { code: "pos", name: "Luke", kind: "pos" });
      await offers.setSkuMapping(tx, c, vat.id, web.id, "TICKET-VAT0");
      let ev = await catalog.createEvent(tx, c, { slug: "hamlet", translations: { nb: { title: "Hamlet" } }, admissionMode: "tickets", registration: { capacity: 40 } });
      await offers.createOffer(tx, c, ev.id, { translations: { nb: { name: "Voksen" } }, vatClassId: vat.id, defaultPrice: 45000 });
      await offers.createOffer(tx, c, ev.id, { translations: { nb: { name: "Luke" } }, vatClassId: vat.id, defaultPrice: 40000, channelIds: [pos.id] });
      ev = await catalog.transitionEvent(tx, c, ev.id, ev.version, "publish");
      const occ = await catalog.createOccurrence(tx, c, ev.id, { startUtc: inDays(7) });
      return {
        web, occ,
        pk: (await tenancy.createApiKey(tx, c, "publishable", "site")).secret,
        sk: (await offers.createChannelKey(tx, c, web.id, "Shopify")).secret,
      };
    });
    const url = `/public/v1/occurrences?event=hamlet`;

    const anon = await get(`${url}&key=${setup.pk}`);
    expect(anon.body.items[0].offers.map((o: { code: string }) => o.code)).toEqual(["voksen", "luke"]);
    expect(anon.body.items[0].offers[0]).not.toHaveProperty("sku");
    expect(anon.body.items[0].availability).toMatchObject({ status: "available" });
    expect(anon.body.items[0].availability).not.toHaveProperty("placesLeft");

    const viaWeb = await get(url, { authorization: `Bearer ${setup.sk}` });
    expect(viaWeb.status).toBe(200);
    expect(viaWeb.headers["cache-control"]).toBe("private, no-store");
    const occ = viaWeb.body.items[0];
    expect(occ.offers).toEqual([expect.objectContaining({ code: "voksen", sku: "TICKET-VAT0", onSale: true, placesPerUnit: 1, minPerReservation: 1, maxPerReservation: 20 })]);
    expect(occ.availability).toMatchObject({ status: "available", placesLeft: 40 });

    // A channel key is not a preview token: no drafts, and it cannot be passed as ?key=.
    expect((await get(`${url}&key=${setup.sk}`)).status).toBe(401);
    expect((await get(url, { authorization: "Bearer sk_nope" })).body.code).toBe("invalid_channel_key");

    // Deactivating the channel stops the key at once, despite the key cache.
    await withTenant(db, c, (tx) => offers.updateChannel(tx, c, setup.web.id, setup.web.version, { active: false }));
    const stopped = await get(url, { authorization: `Bearer ${setup.sk}` });
    expect(stopped).toMatchObject({ status: 401, body: { code: "channel_inactive" } });
  });

  it("flags events restricted to user groups and keeps them cacheable (docs/user-groups.md)", async () => {
    const a = ctxA;
    await withTenant(db, a, async (tx) => {
      const member = await catalog.createUserGroup(tx, a, { code: "member", names: { nb: "Medlem", en: "Member" } });
      const ev = await catalog.createEvent(tx, a, { slug: "members-evening", translations: { nb: { title: "Medlemskveld" } }, accessGroupIds: [member.id] });
      await catalog.transitionEvent(tx, a, ev.id, ev.version, "publish");
      await catalog.createOccurrence(tx, a, ev.id, { startUtc: inDays(4) });
    });
    const list = await get(`/public/v1/events?key=${keyA}&locale=en`);
    expect(list.headers["cache-control"]).toBe("public, max-age=0, s-maxage=30, stale-while-revalidate=300");
    const items = list.body.items as { slug: string; access: { groups: { code: string; name: string }[] } }[];
    expect(items.find((e) => e.slug === "members-evening")?.access).toEqual({ groups: [{ code: "member", name: "Member" }] });
    expect(items.find((e) => e.slug === "guided-tour")?.access).toEqual({ groups: [] });
    const occs = await get(`/public/v1/occurrences?key=${keyA}&event=members-evening`);
    expect(occs.body.items[0].event.access.groups).toEqual([{ code: "member", name: "Medlem" }]);
  });

  it("serves one group's view with ?group=, cached separately, and refuses unknown codes", async () => {
    const plain = await get(`/public/v1/occurrences?key=${keyA}`);
    const grouped = await get(`/public/v1/occurrences?key=${keyA}&group=member`);
    expect(grouped.status).toBe(200);
    expect(grouped.headers["cache-control"]).toBe("public, max-age=0, s-maxage=30, stale-while-revalidate=300");
    expect(grouped.body.items.length).toBeGreaterThan(0);
    expect(grouped.headers.etag).toBeTruthy();
    expect(plain.headers.etag).toBeTruthy();
    const unknown = await get(`/public/v1/occurrences?key=${keyA}&group=nobody`);
    expect(unknown).toMatchObject({ status: 400, body: { code: "unknown_group" } });
    expect(unknown.headers["cache-control"]).toBe("no-store");
    expect((await get(`/public/v1/events/guided-tour?key=${keyA}&group=nobody`)).status).toBe(400);
  });

  it("rate-limits per key", async () => {
    const small = await buildPublicApp({ db, rateLimit: { capacity: 2, refillPerSecond: 0.01 } });
    const url = `/public/v1/locations?key=${keyB}`;
    expect((await small.inject({ method: "GET", url })).statusCode).toBe(200);
    expect((await small.inject({ method: "GET", url })).statusCode).toBe(200);
    const limited = await small.inject({ method: "GET", url });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeTruthy();
    expect((await small.inject({ method: "GET", url: `/public/v1/locations?key=${keyA}` })).statusCode).toBe(200);
    await small.close();
  });
});
