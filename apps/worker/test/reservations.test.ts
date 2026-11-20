import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, withTenant } from "@event-manager/db";
import { startTestDatabase, type TestDatabase } from "@event-manager/db/testing";
import { type ActorContext, catalog, inventory, offers, sales, tenancy } from "@event-manager/domain";
import { sweepReservations } from "../src/reservations.js";

// The reservation sweeper (docs/ticketing.md, milestone 3): overdue held reservations in every
// account release their places.

let tdb: TestDatabase;
let db: Db;

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
});
afterAll(async () => {
  await db?.destroy();
  await tdb?.stop();
});

async function heldReservation(slug: string, now: Date) {
  const account = await tenancy.createAccount(db, { slug, name: slug, ownerEmail: `owner@${slug}.test` });
  const userId = await tenancy.login(db, { issuer: "t", subject: slug, email: `owner@${slug}.test`, name: null });
  const ctx: ActorContext = { tenantId: account.id, userId, clientId: null, roles: ["owner"] };
  return withTenant(db, ctx, async (tx) => {
    const vat = await offers.createVatClass(tx, ctx, { code: "exempt", label: "Fritatt", ratePct: 0 });
    const web = await offers.createChannel(tx, ctx, { code: "web", name: "Web", kind: "ecom", holdMinutes: 10 });
    await offers.setSkuMapping(tx, ctx, vat.id, web.id, "T");
    const event = await catalog.createEvent(tx, ctx, { translations: { nb: { title: "Konsert" } }, admissionMode: "tickets", registration: { capacity: 5 } });
    const occ = await catalog.createOccurrence(tx, ctx, event.id, { startUtc: new Date(now.getTime() + 86_400_000) });
    const adult = (await offers.createOffer(tx, ctx, event.id, { translations: { nb: { name: "Voksen" } }, vatClassId: vat.id, defaultPrice: 100 })).offer!;
    await catalog.transitionEvent(tx, ctx, event.id, (await catalog.getEvent(tx, event.id)).version, "publish");
    const caller = { tenantId: ctx.tenantId, channelId: web.id, signingKey: null };
    const r = await sales.reserve(tx, caller, { lines: [{ occurrenceId: occ.id, offerId: adult.id, quantity: 2 }] }, now);
    return { ctx, caller, reservationId: r.id, occurrenceId: occ.id };
  });
}

describe("reservation sweeper", () => {
  it("expires overdue reservations in every account and leaves the rest held", async () => {
    const now = new Date();
    const a = await heldReservation("sweep-a", new Date(now.getTime() - 11 * 60_000));
    const b = await heldReservation("sweep-b", now);
    const logs: string[] = [];
    const r = await sweepReservations(db, now, (m) => logs.push(m));
    expect(r).toEqual({ tenants: 1, expired: 1, failed: 0 });
    expect(logs[0]).toContain("1 expired");
    const read = (s: typeof a) => withTenant(db, s.ctx, async (tx) => ({
      status: (await sales.getReservation(tx, s.caller, s.reservationId, now)).status,
      pool: await inventory.getPool(tx, s.occurrenceId),
    }));
    expect(await read(a)).toMatchObject({ status: "expired", pool: { held: 0, available: 5 } });
    expect(await read(b)).toMatchObject({ status: "held", pool: { held: 2, available: 3 } });
    expect(await sweepReservations(db, now, () => {})).toEqual({ tenants: 0, expired: 0, failed: 0 });
  });
});
