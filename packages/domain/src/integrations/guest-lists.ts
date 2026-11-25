import { type Tx } from "@event-manager/db";
import * as catalog from "../catalog/index.js";
import { emit } from "../outbox/index.js";
import { type ActorContext, DomainError } from "../shared/index.js";
import { assertCan, recordAudit } from "../tenancy/index.js";
import { type ConnectionRef, loadConnection } from "./index.js";

// A guest list from a HubSpot list (docs/hubspot.md, milestone 6). Staff pick a list in the
// portal; the worker fetches its members into the guest import's staging, and staff map,
// preview and commit as for a file, with the same rules (row errors, re-import on email,
// removals listed and never silent). The list is remembered on the event, so "Refresh from
// HubSpot" fetches it again. There is no live sync.

export interface GuestListSource {
  provider: "hubspot";
  listId: string;
  listName: string;
  /** fetching: the worker is reading the list; ready: `importId` is staged; failed: see `error`. */
  status: "fetching" | "ready" | "failed";
  importId: string | null;
  error: string | null;
  memberCount: number | null;
  requestedAt: Date;
  fetchedAt: Date | null;
}

const columns = ["provider", "list_id", "list_name", "status", "import_id", "error", "member_count", "requested_at", "fetched_at"] as const;
type Row = {
  provider: "hubspot"; list_id: string; list_name: string; status: GuestListSource["status"]; import_id: string | null; error: string | null;
  member_count: number | null; requested_at: Date; fetched_at: Date | null;
};
const toSource = (r: Row): GuestListSource => ({
  provider: r.provider, listId: r.list_id, listName: r.list_name, status: r.status, importId: r.import_id, error: r.error,
  memberCount: r.member_count, requestedAt: r.requested_at, fetchedAt: r.fetched_at,
});

async function read(tx: Tx, eventId: string): Promise<GuestListSource | null> {
  const r = await tx.selectFrom("integrations.guest_list_source").select(columns).where("event_id", "=", eventId).executeTakeFirst();
  return r ? toSource(r) : null;
}

/** The HubSpot list the event's guests came from, and how the last fetch went; null when none. */
export async function getGuestListSource(tx: Tx, ctx: ActorContext, eventId: string): Promise<GuestListSource | null> {
  assertCan(ctx, "registrations.read");
  await catalog.getEvent(tx, eventId);
  const s = await read(tx, eventId);
  // Committed or expired since: the draft is gone.
  if (s?.importId && !(await tx.selectFrom("registration.guest_import").select("id").where("id", "=", s.importId).where("expires_at", ">", new Date()).executeTakeFirst())) {
    return { ...s, importId: null };
  }
  return s;
}

/**
 * Fetches a HubSpot list's members as the event's guest list (or the remembered list again, for
 * "Refresh from HubSpot"). The worker stages them; nothing changes on the guest list until staff
 * commit the import.
 */
export async function requestGuestList(tx: Tx, ctx: ActorContext, eventId: string, list?: { listId: string; listName: string }): Promise<GuestListSource> {
  assertCan(ctx, "registrations.write");
  const event = await catalog.getEvent(tx, eventId);
  if (event.admissionMode !== "registration") throw new DomainError("conflict", "The event does not take registrations", { eventId });
  const c = await loadConnection(tx, "hubspot");
  if (!c || c.status !== "active") throw new DomainError("conflict", c?.status === "needs_reconnect" ? "HubSpot refuses our access: reconnect in Settings → Integrations" : "HubSpot is not connected");
  const before = await read(tx, eventId);
  const target = list ?? (before ? { listId: before.listId, listName: before.listName } : null);
  if (!target) throw new DomainError("validation_failed", "Choose a HubSpot list", { field: "listId" });
  const listId = target.listId.trim();
  if (!/^\d{1,20}$/.test(listId)) throw new DomainError("validation_failed", "Not a HubSpot list id", { field: "listId" });
  const listName = target.listName.trim().slice(0, 300) || `#${listId}`;
  // A draft staged from the last fetch and never committed goes: the new fetch replaces it.
  if (before?.importId) await tx.deleteFrom("registration.guest_import").where("id", "=", before.importId).execute();
  const values = { provider: "hubspot" as const, list_id: listId, list_name: listName, status: "fetching" as const, import_id: null, error: null, member_count: null, requested_by: ctx.userId, requested_at: new Date(), fetched_at: null };
  await tx
    .insertInto("integrations.guest_list_source")
    .values({ tenant_id: ctx.tenantId, event_id: eventId, ...values })
    .onConflict((oc) => oc.columns(["tenant_id", "event_id"]).doUpdateSet(values))
    .execute();
  await recordAudit(tx, ctx, { action: "invitation.import_requested", entityType: "event", entityId: eventId, diff: { source: "hubspot", listId, listName, refresh: !list } });
  await emit(tx, ctx.tenantId, { type: "integration.guest_list_requested.v1", subject: `event/${eventId}`, data: { eventId, provider: "hubspot", listId, requestedBy: ctx.userId } });
  return (await read(tx, eventId))!;
}

/** What the worker needs to fetch: the list, and who asked (the import is staged in their name). */
export async function pendingGuestList(tx: Tx, eventId: string): Promise<{ listId: string; requestedBy: string | null; requestedAt: Date } | null> {
  const r = await tx.selectFrom("integrations.guest_list_source").select(["list_id", "requested_by", "requested_at", "status"]).where("event_id", "=", eventId).executeTakeFirst();
  return r && r.status === "fetching" ? { listId: r.list_id, requestedBy: r.requested_by, requestedAt: r.requested_at } : null;
}

const live = (tx: Tx, ref: ConnectionRef) =>
  tx.selectFrom("integrations.connection").select("id").where("id", "=", ref.id).where("generation", "=", ref.generation).where("status", "=", "active").executeTakeFirst();

/**
 * The worker fetched the list and staged it. Only for the request it fetched (`requestedAt`): if
 * staff asked again meanwhile, the newer request wins and this draft is dropped. False then.
 */
export async function recordGuestListFetched(
  tx: Tx, ref: ConnectionRef, eventId: string, requestedAt: Date, r: { importId: string; listName: string; memberCount: number },
): Promise<boolean> {
  const done = (await live(tx, ref))
    ? await tx
        .updateTable("integrations.guest_list_source")
        .set({ status: "ready", import_id: r.importId, list_name: r.listName.slice(0, 300), member_count: r.memberCount, error: null, fetched_at: new Date() })
        .where("event_id", "=", eventId)
        .where("status", "=", "fetching")
        .where("requested_at", "=", requestedAt)
        .executeTakeFirst()
    : null;
  if (done && Number(done.numUpdatedRows)) return true;
  await tx.deleteFrom("registration.guest_import").where("id", "=", r.importId).execute();
  return false;
}

export async function recordGuestListFailed(tx: Tx, eventId: string, requestedAt: Date, error: string): Promise<void> {
  await tx
    .updateTable("integrations.guest_list_source")
    .set({ status: "failed", error: error.slice(0, 1000), fetched_at: new Date() })
    .where("event_id", "=", eventId)
    .where("status", "=", "fetching")
    .where("requested_at", "=", requestedAt)
    .execute();
}
