import { type LocationKind, newId, sql, type Tx } from "@event-manager/db";
import { emit } from "../outbox/index.js";
import type { ActorContext } from "../shared/index.js";
import { assertCan, diffFields, recordAudit } from "../tenancy/index.js";
import { invalid, notFound, versionConflict } from "./shared.js";
import { DomainError } from "../shared/index.js";

export interface Location {
  id: string;
  kind: LocationKind;
  parentId: string | null;
  name: string;
  address: string | null;
  geo: { lat: number; lng: number } | null;
  archived: boolean;
  version: number;
  updatedAt: Date;
}

export interface LocationInput {
  kind: LocationKind;
  parentId?: string | null;
  name: string;
  address?: string | null;
  geo?: { lat: number; lng: number } | null;
}

export type LocationPatch = Partial<Pick<LocationInput, "name" | "address" | "geo" | "parentId">> & { archived?: boolean };

const columns = ["id", "kind", "parent_id", "name", "address", "lat", "lng", "archived_at", "version", "updated_at"] as const;
type Row = {
  id: string; kind: LocationKind; parent_id: string | null; name: string; address: string | null;
  lat: number | null; lng: number | null; archived_at: Date | null; version: number; updated_at: Date;
};

const toLocation = (r: Row): Location => ({
  id: r.id,
  kind: r.kind,
  parentId: r.parent_id,
  name: r.name,
  address: r.address,
  geo: r.lat !== null && r.lng !== null ? { lat: r.lat, lng: r.lng } : null,
  archived: r.archived_at !== null,
  version: r.version,
  updatedAt: r.updated_at,
});

export async function listLocations(tx: Tx, opts: { includeArchived?: boolean } = {}): Promise<Location[]> {
  let q = tx.selectFrom("catalog.location").select(columns).orderBy("name").orderBy("id");
  if (!opts.includeArchived) q = q.where("archived_at", "is", null);
  return (await q.execute()).map(toLocation);
}

export async function getLocation(tx: Tx, id: string): Promise<Location> {
  const row = await tx.selectFrom("catalog.location").select(columns).where("id", "=", id).executeTakeFirst();
  if (!row) throw notFound("Location");
  return toLocation(row);
}

/** For references from events and occurrences: must exist and not be archived. */
export async function assertUsableLocation(tx: Tx, id: string, field: string): Promise<void> {
  const row = await tx.selectFrom("catalog.location").select("archived_at").where("id", "=", id).executeTakeFirst();
  if (!row) throw invalid(field, "Unknown location");
  if (row.archived_at) throw invalid(field, "Location is archived");
}

async function assertVenueParent(tx: Tx, kind: LocationKind, parentId: string | null | undefined): Promise<void> {
  if (kind === "venue") {
    if (parentId) throw invalid("parentId", "A venue cannot have a parent");
    return;
  }
  if (!parentId) throw invalid("parentId", "A space must belong to a venue");
  const parent = await tx.selectFrom("catalog.location").select(["kind", "archived_at"]).where("id", "=", parentId).executeTakeFirst();
  if (!parent || parent.kind !== "venue") throw invalid("parentId", "A space must belong to a venue");
  if (parent.archived_at) throw invalid("parentId", "Venue is archived");
}

export async function createLocation(tx: Tx, ctx: ActorContext, input: LocationInput): Promise<Location> {
  assertCan(ctx, "content.write");
  await assertVenueParent(tx, input.kind, input.parentId);
  const row = await tx
    .insertInto("catalog.location")
    .values({
      id: newId(),
      tenant_id: ctx.tenantId,
      kind: input.kind,
      parent_id: input.parentId ?? null,
      name: input.name.trim(),
      address: input.address ?? null,
      lat: input.geo?.lat ?? null,
      lng: input.geo?.lng ?? null,
    })
    .returning(columns)
    .executeTakeFirstOrThrow();
  const loc = toLocation(row);
  await recordAudit(tx, ctx, { action: "location.created", entityType: "location", entityId: loc.id, diff: { kind: loc.kind, name: loc.name, parentId: loc.parentId } });
  await emit(tx, ctx.tenantId, { type: "location.changed.v1", subject: `location/${loc.id}`, data: { id: loc.id, change: "created" } });
  return loc;
}

export async function updateLocation(tx: Tx, ctx: ActorContext, id: string, expectedVersion: number, patch: LocationPatch): Promise<Location> {
  assertCan(ctx, "content.write");
  const before = await getLocation(tx, id);
  if (patch.parentId !== undefined && patch.parentId !== before.parentId) {
    if (patch.parentId === id) throw invalid("parentId", "A location cannot contain itself");
    await assertVenueParent(tx, before.kind, patch.parentId);
  }
  if (patch.archived === true && !before.archived && before.kind === "venue") {
    const active = await tx.selectFrom("catalog.location").select("id").where("parent_id", "=", id).where("archived_at", "is", null).executeTakeFirst();
    if (active) throw new DomainError("conflict", "Archive the venue's spaces first", { field: "archived" });
  }
  if (patch.archived === false && before.archived && before.parentId) {
    const parent = await getLocation(tx, before.parentId);
    if (parent.archived) throw new DomainError("conflict", "Restore the venue first", { field: "archived" });
  }

  const row = await tx
    .updateTable("catalog.location")
    .set({
      name: patch.name?.trim(),
      address: patch.address,
      parent_id: patch.parentId,
      ...(patch.geo !== undefined ? { lat: patch.geo?.lat ?? null, lng: patch.geo?.lng ?? null } : {}),
      ...(patch.archived !== undefined ? { archived_at: patch.archived ? (before.archived ? sql<Date>`archived_at` : new Date()) : null } : {}),
      version: sql<number>`version + 1`,
    })
    .where("id", "=", id)
    .where("version", "=", expectedVersion)
    .returning(columns)
    .executeTakeFirst();
  if (!row) throw versionConflict("Location", before.version);

  const after = toLocation(row);
  const diff = diffFields(before as unknown as Record<string, unknown>, patch as Record<string, unknown>);
  const action = patch.archived === true && !before.archived ? "location.archived" : patch.archived === false && before.archived ? "location.restored" : "location.updated";
  await recordAudit(tx, ctx, { action, entityType: "location", entityId: id, diff });
  await emit(tx, ctx.tenantId, { type: "location.changed.v1", subject: `location/${id}`, data: { id, change: action.split(".")[1], changed: Object.keys(diff) } });
  return after;
}
