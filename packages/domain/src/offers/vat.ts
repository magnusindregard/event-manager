import { newId, sql, type Tx } from "@event-manager/db";
import { emit } from "../outbox/index.js";
import { type ActorContext, DomainError } from "../shared/index.js";
import { assertCan, diffFields, recordAudit } from "../tenancy/index.js";

// VAT classes per account (docs/ticketing.md, "VAT class"). Clients set them up with their
// accountant; the platform makes no claim about which admissions are exempt. A rate in use by
// an offer is not changed: a new class is added and the offers moved to it.

export interface VatClass {
  id: string;
  code: string;
  label: string;
  ratePct: number;
  archived: boolean;
  /** Offers use this class, so its rate is fixed. */
  inUse: boolean;
  version: number;
  updatedAt: Date;
}

export interface VatClassInput {
  code: string;
  label: string;
  ratePct: number;
}

export interface VatClassPatch {
  label?: string;
  ratePct?: number;
  archived?: boolean;
}

const CODE_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const invalid = (field: string, message: string) => new DomainError("validation_failed", message, { field });

function validateRate(v: number) {
  // Two decimals at most, as numeric(5, 2) stores it.
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100 || Math.abs(Math.round(v * 100) - v * 100) > 1e-9) {
    throw invalid("ratePct", "Must be a percentage, 0–100, with at most two decimals");
  }
}

function validateLabel(v: string) {
  if (!v?.trim() || v.trim().length > 200) throw invalid("label", "Label the class (at most 200 characters)");
}

const columns = ["id", "code", "label", "rate_pct", "archived_at", "version", "updated_at"] as const;

async function select(tx: Tx, id?: string): Promise<VatClass[]> {
  let q = tx
    .selectFrom("offers.vat_class as v")
    .select(columns.map((c) => `v.${c}` as const))
    .select((eb) => eb.exists(eb.selectFrom("offers.offer as o").whereRef("o.vat_class_id", "=", "v.id").select("o.id")).as("in_use"))
    .orderBy("v.rate_pct")
    .orderBy("v.code");
  if (id) q = q.where("v.id", "=", id);
  const rows = await q.execute();
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    label: r.label,
    ratePct: Number(r.rate_pct),
    archived: r.archived_at !== null,
    inUse: Boolean(r.in_use),
    version: r.version,
    updatedAt: r.updated_at,
  }));
}

export const listVatClasses = (tx: Tx): Promise<VatClass[]> => select(tx);

export async function getVatClass(tx: Tx, id: string): Promise<VatClass> {
  const [v] = await select(tx, id);
  if (!v) throw new DomainError("not_found", "VAT class not found");
  return v;
}

export async function createVatClass(tx: Tx, ctx: ActorContext, input: VatClassInput): Promise<VatClass> {
  assertCan(ctx, "account.write");
  if (!CODE_RE.test(input.code ?? "")) throw invalid("code", "Use lowercase letters, digits, - and _");
  validateLabel(input.label);
  validateRate(input.ratePct);
  const id = newId();
  try {
    await tx.insertInto("offers.vat_class").values({ id, tenant_id: ctx.tenantId, code: input.code, label: input.label.trim(), rate_pct: input.ratePct }).execute();
  } catch (e) {
    if (typeof e === "object" && e !== null && (e as { code?: string }).code === "23505") throw new DomainError("conflict", "Another VAT class uses this code", { field: "code" });
    throw e;
  }
  await recordAudit(tx, ctx, { action: "vat_class.created", entityType: "account", entityId: ctx.tenantId, diff: { id, code: input.code, ratePct: input.ratePct } });
  return getVatClass(tx, id);
}

export async function updateVatClass(tx: Tx, ctx: ActorContext, id: string, expectedVersion: number, patch: VatClassPatch): Promise<VatClass> {
  assertCan(ctx, "account.write");
  // Lock the class so an offer cannot start using it while its rate changes.
  const locked = await tx.selectFrom("offers.vat_class").select("id").where("id", "=", id).forUpdate().executeTakeFirst();
  if (!locked) throw new DomainError("not_found", "VAT class not found");
  const before = await getVatClass(tx, id);
  if (before.version !== expectedVersion) throw new DomainError("version_conflict", "VAT class was changed by someone else", { currentVersion: before.version });
  if (patch.label !== undefined) validateLabel(patch.label);
  if (patch.ratePct !== undefined) {
    validateRate(patch.ratePct);
    if (patch.ratePct !== before.ratePct && before.inUse) {
      throw new DomainError("conflict", "Offers use this VAT class, so its rate cannot change. Add a new class and move the offers to it", { field: "ratePct" });
    }
  }
  await tx
    .updateTable("offers.vat_class")
    .set({
      label: patch.label?.trim(),
      rate_pct: patch.ratePct,
      ...(patch.archived === undefined ? {} : { archived_at: patch.archived ? (before.archived ? undefined : sql<Date>`now()`) : null }),
      version: sql<number>`version + 1`,
    })
    .where("id", "=", id)
    .execute();
  const after = await getVatClass(tx, id);
  const diff = diffFields(before as unknown as Record<string, unknown>, { label: after.label, ratePct: after.ratePct, archived: after.archived });
  await recordAudit(tx, ctx, { action: "vat_class.updated", entityType: "account", entityId: ctx.tenantId, diff: { id, code: before.code, ...diff } });
  await emit(tx, ctx.tenantId, { type: "vat_class.changed.v1", subject: `vat-class/${id}`, data: { id, change: "updated" } });
  return after;
}

/** An active class for an offer to use. Locks it (share) so its rate cannot change under the offer. */
export async function assertUsableVatClass(tx: Tx, id: string, field = "vatClassId"): Promise<void> {
  const v = await tx.selectFrom("offers.vat_class").select(["id", "archived_at"]).where("id", "=", id).forShare().executeTakeFirst();
  if (!v) throw invalid(field, "Unknown VAT class");
  if (v.archived_at) throw invalid(field, "The VAT class is archived");
}
