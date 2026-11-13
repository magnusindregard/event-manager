import { type Db, newId, sql, type Tx, withTenant } from "@event-manager/db";
import { emit } from "../outbox/index.js";
import { type ActorContext, DomainError } from "../shared/index.js";
import { diffFields, recordAudit } from "./audit.js";
import { assertCan } from "./permissions.js";

export interface Account {
  id: string;
  slug: string;
  name: string;
  defaultTimezone: string;
  defaultLocale: string;
  locales: string[];
  horizonMonths: number;
  version: number;
  updatedAt: Date;
}

export type AccountSettingsPatch = Partial<Pick<Account, "name" | "defaultTimezone" | "defaultLocale" | "locales" | "horizonMonths">>;

const columns = ["id", "slug", "name", "default_timezone", "default_locale", "locales", "horizon_months", "version", "updated_at"] as const;

type Row = {
  id: string; slug: string; name: string; default_timezone: string; default_locale: string;
  locales: string[]; horizon_months: number; version: number; updated_at: Date;
};

const toAccount = (r: Row): Account => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  defaultTimezone: r.default_timezone,
  defaultLocale: r.default_locale,
  locales: r.locales,
  horizonMonths: r.horizon_months,
  version: r.version,
  updatedAt: r.updated_at,
});

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The account for the transaction's tenant (RLS makes it the only visible one). */
export async function getAccount(tx: Tx): Promise<Account> {
  const row = await tx.selectFrom("tenancy.account").select(columns).executeTakeFirst();
  if (!row) throw new DomainError("not_found", "Account not found");
  return toAccount(row);
}

export async function updateAccountSettings(
  tx: Tx,
  ctx: ActorContext,
  expectedVersion: number,
  patch: AccountSettingsPatch,
): Promise<Account> {
  assertCan(ctx, "account.write");
  const before = await getAccount(tx);

  const locales = patch.locales ?? before.locales;
  const defaultLocale = patch.defaultLocale ?? before.defaultLocale;
  if (patch.defaultTimezone !== undefined && !isValidTimezone(patch.defaultTimezone)) {
    throw new DomainError("validation_failed", "Unknown IANA timezone", { field: "defaultTimezone" });
  }
  if (locales.length === 0 || !locales.includes(defaultLocale)) {
    throw new DomainError("validation_failed", "defaultLocale must be one of locales", { field: "defaultLocale" });
  }

  const row = await tx
    .updateTable("tenancy.account")
    .set({
      name: patch.name,
      default_timezone: patch.defaultTimezone,
      default_locale: patch.defaultLocale,
      locales: patch.locales,
      horizon_months: patch.horizonMonths,
      version: sql<number>`version + 1`,
    })
    .where("id", "=", ctx.tenantId)
    .where("version", "=", expectedVersion)
    .returning(columns)
    .executeTakeFirst();
  if (!row) throw new DomainError("version_conflict", "Account was changed by someone else", { currentVersion: before.version });

  const after = toAccount(row);
  const diff = diffFields(before as unknown as Record<string, unknown>, patch as Record<string, unknown>);
  await recordAudit(tx, ctx, { action: "account.updated", entityType: "account", entityId: after.id, diff });
  await emit(tx, ctx.tenantId, { type: "account.changed.v1", subject: `account/${after.id}`, data: { id: after.id, changed: Object.keys(diff) } });
  return after;
}

export interface CreateAccountInput {
  slug: string;
  name: string;
  ownerEmail: string;
  defaultTimezone?: string;
  locales?: string[];
  defaultLocale?: string;
}

/**
 * Bootstrap: creates an account and invites its first owner. Not exposed in the
 * API; run from the admin CLI. The owner becomes a member on first sign-in.
 */
export async function createAccount(db: Db, input: CreateAccountInput): Promise<Account> {
  const id = newId();
  const locales = input.locales ?? ["nb", "en"];
  return withTenant(db, { tenantId: id }, async (tx) => {
    const row = await tx
      .insertInto("tenancy.account")
      .values({
        id,
        slug: input.slug,
        name: input.name,
        default_timezone: input.defaultTimezone ?? "Europe/Oslo",
        locales,
        default_locale: input.defaultLocale ?? locales[0],
      })
      .returning(columns)
      .executeTakeFirstOrThrow();
    await tx
      .insertInto("tenancy.invitation")
      .values({ id: newId(), tenant_id: id, email: input.ownerEmail.toLowerCase(), role: "owner", invited_by: null })
      .execute();
    const system: ActorContext = { tenantId: id, userId: null, clientId: "admin-cli", roles: ["owner"] };
    await recordAudit(tx, system, { action: "account.created", entityType: "account", entityId: id, diff: { ownerEmail: input.ownerEmail } });
    await emit(tx, id, { type: "account.created.v1", subject: `account/${id}`, data: { id, slug: input.slug } });
    return toAccount(row);
  });
}
