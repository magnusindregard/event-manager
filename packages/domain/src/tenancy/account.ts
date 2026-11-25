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
  /** Registrations are anonymised this many months after their occurrence (docs/registration.md, "Retention"). */
  anonymiseAfterMonths: number;
  /** Sensitive answers are deleted this many days after their occurrence. */
  sensitiveDeleteAfterDays: number;
  /** Printed on receipts from the hosted checkout (docs/checkout.md, "Receipts"). */
  merchant: MerchantDetails;
  version: number;
  updatedAt: Date;
}

export interface MerchantDetails {
  legalName: string | null;
  /** Norwegian organisation number, 9 digits. */
  orgNumber: string | null;
  address: string | null;
  /** Registered for VAT (MVA): receipts then show VAT per rate and "MVA" after the number. */
  vatRegistered: boolean;
}

export type AccountSettingsPatch = Partial<Pick<Account, "name" | "defaultTimezone" | "defaultLocale" | "locales" | "horizonMonths" | "anonymiseAfterMonths" | "sensitiveDeleteAfterDays">> & {
  merchant?: Partial<MerchantDetails>;
};

const columns = ["id", "slug", "name", "default_timezone", "default_locale", "locales", "horizon_months", "anonymise_after_months", "sensitive_delete_after_days",
  "merchant_legal_name", "merchant_org_number", "merchant_address", "merchant_vat_registered", "version", "updated_at"] as const;

type Row = {
  id: string; slug: string; name: string; default_timezone: string; default_locale: string;
  locales: string[]; horizon_months: number; anonymise_after_months: number; sensitive_delete_after_days: number;
  merchant_legal_name: string | null; merchant_org_number: string | null; merchant_address: string | null; merchant_vat_registered: boolean; version: number; updated_at: Date;
};

const toAccount = (r: Row): Account => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  defaultTimezone: r.default_timezone,
  defaultLocale: r.default_locale,
  locales: r.locales,
  horizonMonths: r.horizon_months,
  anonymiseAfterMonths: r.anonymise_after_months,
  sensitiveDeleteAfterDays: r.sensitive_delete_after_days,
  merchant: { legalName: r.merchant_legal_name, orgNumber: r.merchant_org_number, address: r.merchant_address, vatRegistered: r.merchant_vat_registered },
  version: r.version,
  updatedAt: r.updated_at,
});

/** Mod-11 check of a Norwegian organisation number (Brønnøysundregistrene). */
export function validOrgNumber(n: string): boolean {
  if (!/^[89][0-9]{8}$/.test(n)) return false;
  const w = [3, 2, 7, 6, 5, 4, 3, 2];
  const sum = w.reduce((s, x, i) => s + x * Number(n[i]), 0);
  const check = 11 - (sum % 11);
  return (check === 11 ? 0 : check) === Number(n[8]) && check !== 10;
}

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
  const whole = (field: string, v: number | undefined, min: number, max: number) => {
    if (v !== undefined && (!Number.isInteger(v) || v < min || v > max)) throw new DomainError("validation_failed", `Must be a whole number, ${min}–${max}`, { field });
  };
  whole("anonymiseAfterMonths", patch.anonymiseAfterMonths, 1, 120);
  // At most 12 months (docs/registration.md), and never longer than the registration itself is kept.
  whole("sensitiveDeleteAfterDays", patch.sensitiveDeleteAfterDays, 1, 365);
  if ((patch.sensitiveDeleteAfterDays ?? before.sensitiveDeleteAfterDays) > (patch.anonymiseAfterMonths ?? before.anonymiseAfterMonths) * 31) {
    throw new DomainError("validation_failed", "Sensitive answers cannot be kept longer than the registrations", { field: "sensitiveDeleteAfterDays" });
  }
  const m = patch.merchant;
  const text = (v: string | null | undefined) => (v === undefined ? undefined : v === null || !v.trim() ? null : v.trim());
  const legalName = text(m?.legalName);
  const orgNumber = m?.orgNumber === undefined ? undefined : m.orgNumber === null || !m.orgNumber.trim() ? null : m.orgNumber.replace(/\s/g, "");
  const address = text(m?.address);
  if (legalName && legalName.length > 200) throw new DomainError("validation_failed", "At most 200 characters", { field: "merchant.legalName" });
  if (address && address.length > 500) throw new DomainError("validation_failed", "At most 500 characters", { field: "merchant.address" });
  if (orgNumber && !validOrgNumber(orgNumber)) throw new DomainError("validation_failed", "Not a valid organisation number (9 digits)", { field: "merchant.orgNumber" });
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
      anonymise_after_months: patch.anonymiseAfterMonths,
      sensitive_delete_after_days: patch.sensitiveDeleteAfterDays,
      merchant_legal_name: legalName,
      merchant_org_number: orgNumber,
      merchant_address: address,
      merchant_vat_registered: m?.vatRegistered,
      version: sql<number>`version + 1`,
    })
    .where("id", "=", ctx.tenantId)
    .where("version", "=", expectedVersion)
    .returning(columns)
    .executeTakeFirst();
  if (!row) throw new DomainError("version_conflict", "Account was changed by someone else", { currentVersion: before.version });

  const after = toAccount(row);
  const { merchant: _merchant, ...rest } = patch;
  const diff = diffFields(before as unknown as Record<string, unknown>, rest as Record<string, unknown>);
  const merchantAfter = { legalName, orgNumber, address, vatRegistered: m?.vatRegistered };
  for (const [k, v] of Object.entries(diffFields(before.merchant as unknown as Record<string, unknown>, merchantAfter))) diff[`merchant.${k}`] = v;
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
    const invitationId = newId();
    await tx
      .insertInto("tenancy.invitation")
      .values({ id: invitationId, tenant_id: id, email: input.ownerEmail.toLowerCase(), role: "owner", invited_by: null })
      .execute();
    const system: ActorContext = { tenantId: id, userId: null, clientId: "admin-cli", roles: ["owner"] };
    await recordAudit(tx, system, { action: "account.created", entityType: "account", entityId: id, diff: { ownerEmail: input.ownerEmail } });
    await emit(tx, id, { type: "account.created.v1", subject: `account/${id}`, data: { id, slug: input.slug } });
    // The first owner gets an Entra identity like any other invitee (ADR 0012).
    await emit(tx, id, { type: "member.invited.v1", subject: `invitation/${invitationId}`, data: { id: invitationId, role: "owner" } });
    return toAccount(row);
  });
}
