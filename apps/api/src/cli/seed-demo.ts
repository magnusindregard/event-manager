import { parseArgs } from "node:util";
import { createDb, withTenant } from "@event-manager/db";
import { type ActorContext, catalog, tenancy } from "@event-manager/domain";

// Creates a demo account with a venue, tags, events, series, a rule and API keys, so a fresh
// environment has something to click through before a real client's events are loaded.
// Dates are relative to today. In Azure:
//   az containerapp exec -g rg-em-staging -n ca-em-staging-api \
//     --command "node dist/cli/seed-demo.js --slug demo --owner-email you@example.com"
const { values } = parseArgs({
  options: {
    slug: { type: "string", default: "demo" },
    name: { type: "string", default: "Demo-museet" },
    "owner-email": { type: "string" },
  },
});
if (!values["owner-email"]) {
  console.error("Usage: seed-demo --owner-email <email> [--slug demo] [--name Demo-museet]");
  process.exit(2);
}
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = createDb(url, { max: 1 });

const TZ = "Europe/Oslo";
/** Local date YYYY-MM-DD, `days` from today in Oslo. */
const day = (days: number) => catalog.utcToLocal(new Date(Date.now() + days * 86_400_000), TZ).slice(0, 10);
const at = (days: number, time: string) => catalog.localToUtc(`${day(days)}T${time}:00`, TZ);

try {
  const account = await tenancy.createAccount(db, {
    slug: values.slug!, name: values.name!, ownerEmail: values["owner-email"], defaultTimezone: TZ, locales: ["nb", "en"],
  });
  const ctx: ActorContext = { tenantId: account.id, userId: null, clientId: "cli:seed-demo", roles: ["owner"] };
  const keys = await withTenant(db, ctx, async (tx) => {
    const venue = await catalog.createLocation(tx, ctx, { kind: "venue", name: values.name!, address: "Eksempelgata 1, 0150 Oslo", geo: { lat: 59.906, lng: 10.755 } });
    const gallery = await catalog.createLocation(tx, ctx, { kind: "space", parentId: venue.id, name: "Galleri 1" });
    const rooftop = await catalog.createLocation(tx, ctx, { kind: "space", parentId: venue.id, name: "Takterrassen" });
    const auditorium = await catalog.createLocation(tx, ctx, { kind: "space", parentId: venue.id, name: "Auditoriet" });

    const category = await catalog.createVocabulary(tx, ctx, { key: "kategori", labels: { nb: "Kategori", en: "Category" } });
    const tour = await catalog.createTag(tx, ctx, category.id, { key: "omvisning", labels: { nb: "Omvisning", en: "Guided tour" } });
    const concert = await catalog.createTag(tx, ctx, category.id, { key: "konsert", labels: { nb: "Konsert", en: "Concert" } });
    const family = await catalog.createTag(tx, ctx, category.id, { key: "familie", labels: { nb: "Familie", en: "Family" } });
    const program = await catalog.createVocabulary(tx, ctx, { key: "program", labels: { nb: "Program", en: "Programme" } });
    const late = await catalog.createTag(tx, ctx, program.id, { key: "kveldsapent", labels: { nb: "Kveldsåpent", en: "Late opening" } });

    const publish = async (e: catalog.CatalogEvent) => catalog.transitionEvent(tx, ctx, e.id, e.version, "publish");

    // A recurring tour with a rule: evening tours on Thursdays move to the rooftop.
    const guided = await publish(await catalog.createEvent(tx, ctx, {
      slug: "omvisning",
      translations: {
        nb: { title: "Omvisning", shortDescription: "En guidet tur gjennom samlingen." },
        en: { title: "Guided tour", shortDescription: "A guided walk through the collection." },
      },
      defaultLocationId: gallery.id, defaultDurationMin: 60, admissionMode: "external", externalUrl: "https://tickets.example.com/omvisning", tagIds: [tour.id],
    }));
    await catalog.createSeries(tx, ctx, guided.id, { rrule: "FREQ=WEEKLY;BYDAY=TU,TH,SA", dtstartLocal: `${day(1)}T14:00` });
    await catalog.createSeries(tx, ctx, guided.id, { rrule: "FREQ=WEEKLY;BYDAY=TH", dtstartLocal: `${day(1)}T19:00` });
    await catalog.createRule(tx, ctx, guided.id, {
      name: "Kveldsomvisning på taket", priority: 10, conditions: { startTimeFrom: "18:00" },
      effects: [{ type: "location", value: rooftop.id }, { type: "tags", value: { add: [late.id] } }, { type: "externalUrl", value: "https://tickets.example.com/kveld" }],
    });

    // One-off concerts.
    const jazz = await publish(await catalog.createEvent(tx, ctx, {
      slug: "jazz-pa-taket",
      translations: { nb: { title: "Jazz på taket" }, en: { title: "Jazz on the roof" } },
      defaultLocationId: rooftop.id, defaultDurationMin: 90, admissionMode: "external", externalUrl: "https://tickets.example.com/jazz", tagIds: [concert.id],
    }));
    for (const d of [5, 12, 19]) await catalog.createOccurrence(tx, ctx, jazz.id, { startUtc: at(d, "19:30") });

    // Sundays for eight weeks; one cancelled, so frontends can show "cancelled".
    const sundays = await publish(await catalog.createEvent(tx, ctx, {
      slug: "familiesondag",
      translations: { nb: { title: "Familiesøndag" }, en: { title: "Family Sunday" } },
      defaultLocationId: auditorium.id, defaultDurationMin: 120, tagIds: [family.id],
    }));
    const firstSunday = [...Array(7).keys()].map((i) => i + 1).find((i) => new Date(`${day(i)}T12:00:00Z`).getUTCDay() === 0)!;
    const fam = await catalog.createSeries(tx, ctx, sundays.id, { rrule: "FREQ=WEEKLY;COUNT=8", dtstartLocal: `${day(firstSunday)}T12:00` });
    const third = (await catalog.listOccurrences(tx, { eventId: sundays.id, seriesId: fam.series!.id, limit: 3 }))[2]!;
    await catalog.updateOccurrence(tx, ctx, third.id, third.version, { status: "cancelled" });

    // A draft, visible only with the preview key.
    await catalog.createEvent(tx, ctx, { slug: "hemmelig-forhandsvisning", translations: { nb: { title: "Hemmelig forhåndsvisning" } }, defaultLocationId: gallery.id });

    return {
      publishable: (await tenancy.createApiKey(tx, ctx, "publishable", "Demo website")).secret,
      preview: (await tenancy.createApiKey(tx, ctx, "preview", "Demo CMS preview")).secret,
    };
  });
  console.log(JSON.stringify({ accountId: account.id, slug: account.slug, invited: values["owner-email"], publishableKey: keys.publishable, previewKey: keys.preview }, null, 2));
} finally {
  await db.destroy();
}
