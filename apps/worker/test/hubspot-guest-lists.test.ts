import pg from "pg";
import { runOnce } from "graphile-worker";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { type ActorContext, catalog, integrations, registration, tenancy } from "@event-manager/domain";
import { FakeHubSpot, HubSpotError, REQUIRED_SCOPES } from "@event-manager/hubspot";
import { defaultHandlers } from "../src/handlers.js";
import { localeFromHubSpot } from "../src/hubspot/guest-lists.js";
import { FakeDirectory } from "../src/identity/directory.js";
import { FakeMailer } from "../src/identity/mailer.js";
import { buildTaskList } from "../src/tasks.js";

// HubSpot connector milestone 6 (docs/hubspot.md, "Guest list from a HubSpot list"): a list's
// members staged in the guest import, imported with the file's rules, and "Refresh from HubSpot".

let tdb: TestDatabase;
let db: Db;
let admin: pg.Client;
let ctx: ActorContext;
let hubspot: FakeHubSpot;
const PORTAL = "600";
const contact = (id: string, email: string, firstname: string | null, lastname: string | null, language: string | null = null) => ({ id, email, firstname, lastname, language, marketable: true });

async function drain() {
  const mailer = new FakeMailer();
  for (let i = 0; i < 6; i++) {
    await admin.query(`update graphile_worker._private_jobs set run_at = now() where locked_at is null and run_at > now()`);
    await runOnce({
      connectionString: tdb.appUrl,
      taskList: buildTaskList(db, defaultHandlers, { directory: new FakeDirectory(), mailer, adminUrl: "https://admin.test/" }, { mailer, attendeeUrl: "https://attend.test/" }, { client: hubspot, pollMs: 0 }),
    });
  }
}
const run = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db, ctx, fn);
const source = (eventId: string) => run((tx) => integrations.getGuestListSource(tx, ctx, eventId));

async function gala() {
  return run(async (tx) => {
    const e = await catalog.createEvent(tx, ctx, { translations: { nb: { title: "Vernissage" } }, admissionMode: "registration", registration: { accessPolicy: "invite_only", capacity: 100 } });
    return catalog.transitionEvent(tx, ctx, e.id, e.version, "publish");
  });
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  admin = new pg.Client({ connectionString: tdb.superuserUrl });
  await admin.connect();
  const account = await tenancy.createAccount(db, { slug: "hs-lists", name: "MUNCH", ownerEmail: "owner@munch.test", locales: ["nb", "en"] });
  const userId = await tenancy.login(db, { issuer: "t", subject: "o", email: "owner@munch.test", name: null });
  ctx = { tenantId: account.id, userId, clientId: null, roles: ["owner"] };
  hubspot = new FakeHubSpot();
  const t = await hubspot.exchangeCode(hubspot.approve(PORTAL, [...REQUIRED_SCOPES]));
  await run((tx) => integrations.saveConnection(tx, ctx, { provider: "hubspot", portalId: PORTAL, scopes: [...REQUIRED_SCOPES], tokens: { ...t, accessExpiresAt: t.expiresAt }, requiredScopes: REQUIRED_SCOPES }));
  await drain();
});
beforeEach(() => {
  hubspot.calls.length = 0;
});
afterAll(async () => {
  await db?.destroy();
  await admin?.end();
  await tdb?.stop();
});

describe("guest list from a HubSpot list", () => {
  it("reads HubSpot's language as one of the account's locales", () => {
    expect(["nb", "no", "en-us", "EN", "sv", "", null].map((v) => localeFromHubSpot(v, ["nb", "en"]))).toEqual(["nb", "nb", "en", "en", "", "", ""]);
  });

  it("stages the list's members for the import, and imports them with their HubSpot record id", async () => {
    const event = await gala();
    const listId = hubspot.addClientList(PORTAL, "Långivere 2027", [
      contact("901", "Kari@Example.com", "Kari", "Nordmann", "nb"),
      contact("902", "ola@example.com", "Ola", null, "en-gb"),
      contact("903", "", "Uten", "Epost"),
    ]);
    const asked = await run((tx) => integrations.requestGuestList(tx, ctx, event.id, { listId, listName: "Långivere" }));
    expect(asked).toMatchObject({ status: "fetching", importId: null });
    await drain();

    const s = (await source(event.id))!;
    expect(s).toMatchObject({ status: "ready", listName: "Långivere 2027", memberCount: 3, error: null });
    const draft = await run((tx) => registration.getImportDraft(tx, ctx, s.importId!));
    expect(draft).toMatchObject({ fileName: "HubSpot: Långivere 2027", rowCount: 3, mapping: { email: 0, firstName: 1, lastName: 2, locale: 3, externalContactId: 4 } });

    const preview = await run((tx) => registration.previewImport(tx, ctx, draft.id, draft.mapping));
    expect(preview).toMatchObject({ added: 2, errors: [expect.objectContaining({ code: "missing_email" })] });
    await run((tx) => registration.commitImport(tx, ctx, draft.id, draft.mapping));
    const guests = await run((tx) => registration.listInvitations(tx, ctx, event.id));
    expect(guests.items.map((g) => [g.email, g.name, g.locale, g.externalContactId])).toEqual([
      ["kari@example.com", "Kari Nordmann", "nb", "901"],
      ["ola@example.com", "Ola", "en", "902"],
    ]);
    // Committed: the draft is gone, and the list is remembered.
    expect(await source(event.id)).toMatchObject({ status: "ready", importId: null, listId });
  });

  it("refreshes from the remembered list, listing guests who left it without removing them", async () => {
    const event = await gala();
    const listId = hubspot.addClientList(PORTAL, "Styret", [contact("911", "a@example.com", "A", null), contact("912", "b@example.com", "B", null)]);
    await run((tx) => integrations.requestGuestList(tx, ctx, event.id, { listId, listName: "Styret" }));
    await drain();
    const first = (await source(event.id))!;
    const d1 = await run((tx) => registration.getImportDraft(tx, ctx, first.importId!));
    await run((tx) => registration.commitImport(tx, ctx, d1.id, d1.mapping));

    // In HubSpot, B leaves the list and C joins.
    const list = hubspot.portals.get(PORTAL)!.lists.get(listId)!;
    list.members.delete("912");
    hubspot.addClientList(PORTAL, "annen", [contact("913", "c@example.com", "C", null)]);
    list.members.add("913");
    await run((tx) => integrations.requestGuestList(tx, ctx, event.id));
    await drain();
    const again = (await source(event.id))!;
    const d2 = await run((tx) => registration.getImportDraft(tx, ctx, again.importId!));
    const preview = await run((tx) => registration.previewImport(tx, ctx, d2.id, d2.mapping));
    expect(preview).toMatchObject({ added: 1, unchanged: 1, missing: [expect.objectContaining({ email: "b@example.com", removable: true })] });
  });

  it("says why when the list is gone or HubSpot refuses, and replaces an uncommitted fetch when asked again", async () => {
    const event = await gala();
    await run((tx) => integrations.requestGuestList(tx, ctx, event.id, { listId: "424242", listName: "Borte" }));
    await drain();
    expect(await source(event.id)).toMatchObject({ status: "failed", error: "HubSpot has no such list any more" });

    const listId = hubspot.addClientList(PORTAL, "Venner", [contact("921", "v@example.com", "V", null)]);
    await run((tx) => integrations.requestGuestList(tx, ctx, event.id, { listId, listName: "Venner" }));
    await drain();
    const staged = (await source(event.id))!.importId!;
    await run((tx) => integrations.requestGuestList(tx, ctx, event.id));
    expect((await admin.query(`select 1 from registration.guest_import where id = $1`, [staged])).rowCount).toBe(0);

    const refused = hubspot.readContacts.bind(hubspot);
    hubspot.readContacts = async () => {
      throw new HubSpotError("HubSpot POST /crm/v3/objects/contacts/batch/read: 403 missing scope", 403);
    };
    try {
      await drain();
    } finally {
      hubspot.readContacts = refused;
    }
    expect((await source(event.id))!.status).toBe("failed");
  });
});
