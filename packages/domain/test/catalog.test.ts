import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { type ActorContext, catalog, tenancy } from "../src/index.js";

let tdb: TestDatabase;
let db: Db;
let ctx: ActorContext;
let other: ActorContext;

const run = <T>(c: ActorContext, fn: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<T>) => withTenant(db, c, fn);

async function bootstrap(slug: string): Promise<ActorContext> {
  const email = `owner@${slug}.test`;
  const account = await tenancy.createAccount(db, { slug, name: slug, ownerEmail: email });
  const userId = await tenancy.login(db, { issuer: "https://idp.test", subject: email, email, name: null });
  return { tenantId: account.id, userId, clientId: null, roles: ["owner"] };
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  ctx = await bootstrap("cat-a");
  other = await bootstrap("cat-b");
});
afterAll(async () => {
  await db?.destroy();
  await tdb?.stop();
});

describe("resolveFields", () => {
  const event = { defaultLocationId: "loc-default", admissionMode: "external" as const, externalUrl: "https://tix/e", tagIds: ["b", "a"] };
  it("uses event defaults when nothing is overridden", () => {
    expect(catalog.resolveFields(event, { locationOverrideId: null, externalUrlOverride: null, tagsOverride: null })).toEqual({
      location: { value: "loc-default", source: "default", ruleId: null },
      tags: { value: ["a", "b"], source: "default", ruleId: null },
      externalUrl: { value: "https://tix/e", source: "default", ruleId: null },
      capacity: { value: null, source: "default", ruleId: null },
      overbooking: { value: 0, source: "default", ruleId: null },
    });
  });
  it("overrides win, including an empty tag list", () => {
    const r = catalog.resolveFields(event, { locationOverrideId: "loc-x", externalUrlOverride: "https://tix/o", tagsOverride: [] });
    expect(r.location).toMatchObject({ value: "loc-x", source: "override" });
    expect(r.tags).toMatchObject({ value: [], source: "override" });
    expect(r.externalUrl).toMatchObject({ value: "https://tix/o", source: "override" });
  });
  it("a cleared override has no value and wins over the default", () => {
    const r = catalog.resolveFields(event, {
      locationOverrideId: null, externalUrlOverride: null, locationCleared: true, externalUrlCleared: true, tagsOverride: null,
    });
    expect(r.location).toEqual({ value: null, source: "override", ruleId: null });
    expect(r.externalUrl).toEqual({ value: null, source: "override", ruleId: null });
    expect(r.tags).toMatchObject({ source: "default" });
  });
  it("no admission link unless the event is external", () => {
    expect(catalog.resolveFields({ ...event, admissionMode: "none" }, { locationOverrideId: null, externalUrlOverride: null, tagsOverride: null }).externalUrl.value).toBeNull();
  });
});

describe("catalog", () => {
  it("keeps venues and spaces in a two-level tree", async () => {
    const venue = await run(ctx, (tx) => catalog.createLocation(tx, ctx, { kind: "venue", name: "MUNCH" }));
    const space = await run(ctx, (tx) => catalog.createLocation(tx, ctx, { kind: "space", parentId: venue.id, name: "Floor 12" }));
    await expect(run(ctx, (tx) => catalog.createLocation(tx, ctx, { kind: "space", name: "Orphan" }))).rejects.toMatchObject({ code: "validation_failed" });
    await expect(run(ctx, (tx) => catalog.createLocation(tx, ctx, { kind: "space", parentId: space.id, name: "Nested" }))).rejects.toMatchObject({ code: "validation_failed" });
    await expect(run(ctx, (tx) => catalog.updateLocation(tx, ctx, venue.id, venue.version, { archived: true }))).rejects.toMatchObject({ code: "conflict" });
    // Another tenant cannot hang a space under this venue.
    await expect(run(other, (tx) => catalog.createLocation(tx, other, { kind: "space", parentId: venue.id, name: "Hijack" }))).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("creates an event with translations, slug and tags, and resolves occurrence values", async () => {
    const venue = await run(ctx, (tx) => catalog.createLocation(tx, ctx, { kind: "venue", name: "Main" }));
    const rooftop = await run(ctx, (tx) => catalog.createLocation(tx, ctx, { kind: "space", parentId: venue.id, name: "Rooftop" }));
    const vocab = await run(ctx, (tx) => catalog.createVocabulary(tx, ctx, { key: "category", labels: { nb: "Kategori", en: "Category" } }));
    const tour = await run(ctx, (tx) => catalog.createTag(tx, ctx, vocab.id, { key: "tour", labels: { nb: "Omvisning", en: "Tour" } }));

    const event = await run(ctx, (tx) =>
      catalog.createEvent(tx, ctx, {
        translations: { nb: { title: "Omvisning på Øvre plan" }, en: { title: "Guided tour" } },
        defaultLocationId: venue.id,
        externalUrl: "https://tickets.example/tour",
        tagIds: [tour.id],
      }),
    );
    expect(event).toMatchObject({ slug: "omvisning-pa-ovre-plan", status: "draft", timezone: "Europe/Oslo", admissionMode: "external", tagIds: [tour.id] });

    const occ = await run(ctx, (tx) => catalog.createOccurrence(tx, ctx, event.id, { startUtc: new Date("2026-12-01T13:00:00Z") }));
    expect(occ.endUtc.toISOString()).toBe("2026-12-01T14:00:00.000Z");
    expect(occ.effective.location).toMatchObject({ value: venue.id, source: "default" });
    expect(occ.effective.externalUrl).toMatchObject({ value: "https://tickets.example/tour", source: "default" });

    const moved = await run(ctx, (tx) => catalog.updateOccurrence(tx, ctx, occ.id, occ.version, { locationOverrideId: rooftop.id }));
    expect(moved.version).toBe(occ.version + 1);
    expect(moved.effective.location).toMatchObject({ value: rooftop.id, source: "override" });
    expect(moved.detached).toBe(false); // one-offs have no series to detach from

    // Changing the event default re-resolves occurrences that inherit it.
    const occ2 = await run(ctx, (tx) => catalog.createOccurrence(tx, ctx, event.id, { startUtc: new Date("2026-12-02T13:00:00Z") }));
    const updated = await run(ctx, (tx) => catalog.updateEvent(tx, ctx, event.id, event.version, { externalUrl: "https://tickets.example/new" }));
    expect(updated.version).toBe(event.version + 1);
    const [a, b] = await run(ctx, (tx) => Promise.all([catalog.getOccurrence(tx, occ.id), catalog.getOccurrence(tx, occ2.id)]));
    expect(a.effective.externalUrl?.value).toBe("https://tickets.example/new");
    expect(a.effective.location?.value).toBe(rooftop.id);
    expect(b.effective.externalUrl?.value).toBe("https://tickets.example/new");

    const resolved = await run(ctx, (tx) => tx.selectFrom("catalog.occurrence").select(["version", "resolved_version"]).where("event_id", "=", event.id).execute());
    for (const r of resolved) expect(r.resolved_version).toBe(r.version);
  });

  it("clears an inherited location and link per occurrence, and inherits again", async () => {
    const venue = await run(ctx, (tx) => catalog.createLocation(tx, ctx, { kind: "venue", name: "Clear venue" }));
    const rooftop = await run(ctx, (tx) => catalog.createLocation(tx, ctx, { kind: "space", parentId: venue.id, name: "Clear rooftop" }));
    const event = await run(ctx, (tx) =>
      catalog.createEvent(tx, ctx, { translations: { nb: { title: "Tømt lenke" } }, defaultLocationId: venue.id, externalUrl: "https://tickets.example/clear" }),
    );
    const s = await run(ctx, (tx) => catalog.createSeries(tx, ctx, event.id, { rrule: "FREQ=DAILY;COUNT=3", dtstartLocal: "2027-02-01T14:00" }, { now: new Date("2027-01-01T00:00:00Z") }));
    // A rule that also sets a link: a cleared override must win over it too.
    await run(ctx, (tx) => catalog.createRule(tx, ctx, event.id, { name: "Alle", priority: 1, conditions: {}, effects: [{ type: "externalUrl", value: "https://tickets.example/rule" }] }));
    const [first, second] = await run(ctx, (tx) => catalog.listOccurrences(tx, { eventId: event.id, seriesId: s.series!.id, limit: 10 }));
    expect(first!.effective.externalUrl).toMatchObject({ value: "https://tickets.example/rule", source: "rule" });

    await expect(run(ctx, (tx) => catalog.updateOccurrence(tx, ctx, first!.id, first!.version, { externalUrlOverride: "https://x.example", externalUrlOverrideCleared: true })))
      .rejects.toMatchObject({ code: "validation_failed" });
    await expect(run(ctx, (tx) => catalog.updateOccurrence(tx, ctx, first!.id, first!.version, { locationOverrideId: rooftop.id, locationOverrideCleared: true })))
      .rejects.toMatchObject({ code: "validation_failed" });

    const cleared = await run(ctx, (tx) => catalog.updateOccurrence(tx, ctx, first!.id, first!.version, { externalUrlOverrideCleared: true, locationOverrideCleared: true }));
    expect(cleared.overrides).toMatchObject({ externalUrl: null, externalUrlCleared: true, locationId: null, locationCleared: true });
    expect(cleared.effective.externalUrl).toEqual({ value: null, source: "override", ruleId: null });
    expect(cleared.effective.location).toEqual({ value: null, source: "override", ruleId: null });
    expect(cleared.detached).toBe(true);

    // Clearing again changes nothing.
    const same = await run(ctx, (tx) => catalog.updateOccurrence(tx, ctx, cleared.id, cleared.version, { externalUrlOverrideCleared: true }));
    expect(same.overrides.externalUrlCleared).toBe(true);

    // Setting a value replaces the clear; null inherits; cleared false inherits too.
    const set = await run(ctx, (tx) => catalog.updateOccurrence(tx, ctx, same.id, same.version, { locationOverrideId: rooftop.id }));
    expect(set.overrides).toMatchObject({ locationId: rooftop.id, locationCleared: false, externalUrlCleared: true });
    const inherited = await run(ctx, (tx) => catalog.updateOccurrence(tx, ctx, set.id, set.version, { locationOverrideId: null, externalUrlOverrideCleared: false }));
    expect(inherited.overrides).toMatchObject({ locationId: null, locationCleared: false, externalUrl: null, externalUrlCleared: false });
    expect(inherited.effective.location).toMatchObject({ value: venue.id, source: "default" });
    expect(inherited.effective.externalUrl).toMatchObject({ value: "https://tickets.example/rule", source: "rule" });

    // Created cleared, and bulk cleared; reattaching a series occurrence drops the clear.
    const oneOff = await run(ctx, (tx) => catalog.createOccurrence(tx, ctx, event.id, { startUtc: new Date("2027-03-01T13:00:00Z"), externalUrlOverrideCleared: true }));
    expect(oneOff.effective.externalUrl).toMatchObject({ value: null, source: "override" });
    const [bulk] = await run(ctx, (tx) => catalog.bulkUpdateOccurrences(tx, ctx, event.id, [{ id: second!.id, version: second!.version }], { externalUrlOverrideCleared: true }));
    expect(bulk!.effective.externalUrl).toMatchObject({ value: null, source: "override" });
    expect(bulk!.detached).toBe(true);
    const back = await run(ctx, (tx) => catalog.reattachOccurrence(tx, ctx, bulk!.id, bulk!.version));
    expect(back.overrides.externalUrlCleared).toBe(false);
    expect(back.effective.externalUrl).toMatchObject({ value: "https://tickets.example/rule", source: "rule" });
  });

  it("rejects stale versions, duplicate slugs and unknown locales", async () => {
    const e = await run(ctx, (tx) => catalog.createEvent(tx, ctx, { slug: "concert", translations: { nb: { title: "Konsert" } } }));
    await run(ctx, (tx) => catalog.updateEvent(tx, ctx, e.id, e.version, { defaultDurationMin: 90 }));
    await expect(run(ctx, (tx) => catalog.updateEvent(tx, ctx, e.id, e.version, { defaultDurationMin: 30 }))).rejects.toMatchObject({ code: "version_conflict" });
    await expect(run(ctx, (tx) => catalog.createEvent(tx, ctx, { slug: "concert", translations: { nb: { title: "Igjen" } } }))).rejects.toMatchObject({ code: "conflict" });
    await expect(run(ctx, (tx) => catalog.createEvent(tx, ctx, { translations: { de: { title: "Konzert" }, nb: { title: "K" } } }))).rejects.toMatchObject({ code: "validation_failed" });
    await expect(run(ctx, (tx) => catalog.createEvent(tx, ctx, { translations: { en: { title: "No default language" } } }))).rejects.toMatchObject({ code: "validation_failed" });
    // Auto slugs avoid collisions; another tenant may reuse a slug.
    const again = await run(ctx, (tx) => catalog.createEvent(tx, ctx, { translations: { nb: { title: "Concert" } } }));
    expect(again.slug).toBe("concert-2");
    const elsewhere = await run(other, (tx) => catalog.createEvent(tx, other, { slug: "concert", translations: { nb: { title: "Konsert" } } }));
    expect(elsewhere.slug).toBe("concert");
  });

  it("moves events through publish, cancel and archive", async () => {
    let e = await run(ctx, (tx) => catalog.createEvent(tx, ctx, { translations: { nb: { title: "Status" } } }));
    e = await run(ctx, (tx) => catalog.transitionEvent(tx, ctx, e.id, e.version, "publish"));
    expect(e.status).toBe("published");
    e = await run(ctx, (tx) => catalog.transitionEvent(tx, ctx, e.id, e.version, "cancel"));
    expect(e.status).toBe("cancelled");
    e = await run(ctx, (tx) => catalog.transitionEvent(tx, ctx, e.id, e.version, "archive"));
    await expect(run(ctx, (tx) => catalog.transitionEvent(tx, ctx, e.id, e.version, "unpublish"))).rejects.toMatchObject({ code: "conflict" });
    await expect(run(ctx, (tx) => catalog.createOccurrence(tx, ctx, e.id, { startUtc: new Date() }))).rejects.toMatchObject({ code: "conflict" });
  });

  it("lists events with filters and a keyset cursor", async () => {
    const page1 = await run(ctx, (tx) => catalog.listEvents(tx, { limit: 2 }));
    expect(page1).toHaveLength(2);
    const page2 = await run(ctx, (tx) => catalog.listEvents(tx, { limit: 2, before: page1[1]!.id }));
    expect(page2[0]!.id < page1[1]!.id).toBe(true);
    const search = await run(ctx, (tx) => catalog.listEvents(tx, { limit: 10, q: "guided" }));
    expect(search.map((e) => e.slug)).toEqual(["omvisning-pa-ovre-plan"]);
    expect(search[0]!.occurrenceCount).toBe(2);
    const inRange = await run(ctx, (tx) => catalog.listEvents(tx, { limit: 10, from: new Date("2026-12-02T00:00:00Z"), to: new Date("2026-12-03T00:00:00Z") }));
    expect(inRange.map((e) => e.slug)).toEqual(["omvisning-pa-ovre-plan"]);
    const otherTenant = await run(other, (tx) => catalog.listEvents(tx, { limit: 10 }));
    expect(otherTenant.map((e) => e.slug)).toEqual(["concert"]);
  });

  it("editors write content but not tag vocabularies", async () => {
    const editor: ActorContext = { ...ctx, roles: ["editor"] };
    await expect(run(editor, (tx) => catalog.createVocabulary(tx, editor, { key: "audience", labels: {} }))).rejects.toMatchObject({ code: "forbidden" });
    await expect(run(editor, (tx) => catalog.createLocation(tx, editor, { kind: "venue", name: "Editor venue" }))).resolves.toBeTruthy();
  });

  it("a failed change rolls back the occurrence, its effective values and its outbox event", async () => {
    const e = await run(ctx, (tx) => catalog.createEvent(tx, ctx, { translations: { nb: { title: "Rollback" } } }));
    await expect(
      run(ctx, async (tx) => {
        await catalog.createOccurrence(tx, ctx, e.id, { startUtc: new Date("2026-12-10T10:00:00Z") });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const counts = await run(ctx, async (tx) => ({
      occ: (await tx.selectFrom("catalog.occurrence").select("id").where("event_id", "=", e.id).execute()).length,
      events: (await tx.selectFrom("outbox.event").select("id").where("type", "=", "occurrence.created.v1").where("data", "@>", JSON.stringify({ eventId: e.id })).execute()).length,
    }));
    expect(counts).toEqual({ occ: 0, events: 0 });
  });
});
