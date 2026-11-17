import { type Db, type Tx, withoutTenant, withTenant } from "@event-manager/db";
import { catalog, registration, tenancy } from "@event-manager/domain";

// The attendee API and the hosted pages share these, so a page does exactly what the API
// does. Every call finds its tenant first (from the occurrence, or from the signed token)
// and then runs in that tenant's transaction, like every other request.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Details {
  locale: string;
  locales: string[];
  account: { name: string };
  target: catalog.RegistrationTarget;
  availability: catalog.Availability;
  title: string;
  shortDescription: string | null;
  image: { url: string; alt: string | null } | null;
  /** The time the availability was computed for. */
  now: Date;
}

async function details(tx: Tx, occurrenceId: string, wanted: string | undefined, now: Date): Promise<Details> {
  const [account, target] = await Promise.all([tenancy.getAccount(tx), catalog.getRegistrationTarget(tx, occurrenceId)]);
  const locale = wanted && account.locales.includes(wanted) ? wanted : account.defaultLocale;
  const t = target.event.translations[locale] ?? target.event.translations[account.defaultLocale] ?? Object.values(target.event.translations)[0];
  return {
    locale,
    locales: account.locales,
    account: { name: account.name },
    target,
    availability: catalog.targetAvailability(target, now),
    title: t?.title ?? target.event.slug,
    shortDescription: t?.shortDescription ?? null,
    image: t?.imageUrl ? { url: t.imageUrl, alt: t.imageAlt } : null,
    now,
  };
}

/** Picks the first of the browser's languages that the account offers. */
export function preferredLocale(acceptLanguage: string | undefined): string | undefined {
  return acceptLanguage?.split(",").map((s) => s.split(";")[0]!.trim().split("-")[0]!.toLowerCase()).find(Boolean);
}

export class AttendeeService {
  constructor(private readonly db: Db, private readonly clock: () => Date = () => new Date()) {}

  now(): Date {
    return this.clock();
  }

  private async tenantOf(occurrenceId: string): Promise<string | null> {
    if (!UUID.test(occurrenceId)) return null;
    return withoutTenant(this.db, (tx) => registration.occurrenceTenant(tx, occurrenceId));
  }

  /** The open registration page's data, or null for unknown or unpublished occurrences. */
  async occurrence(occurrenceId: string, locale?: string): Promise<Details | null> {
    const tenantId = await this.tenantOf(occurrenceId);
    if (!tenantId) return null;
    return withTenant(this.db, { tenantId }, (tx) => details(tx, occurrenceId, locale, this.now()));
  }

  async register(occurrenceId: string, input: registration.RegistrationInput): Promise<{ registration: registration.Registration; manageToken: string } | null> {
    const tenantId = await this.tenantOf(occurrenceId);
    if (!tenantId) return null;
    return withTenant(this.db, { tenantId }, async (tx) => {
      const reg = await registration.register(tx, tenantId, occurrenceId, input, { kind: "attendee" }, this.now());
      return { registration: reg, manageToken: await registration.manageToken(tx, tenantId, reg) };
    });
  }

  /** Runs fn for the registration behind a manage token; null for an invalid token. */
  private async withToken<T>(token: string, fn: (tx: Tx, tenantId: string, reg: registration.Registration) => Promise<T>): Promise<T | null> {
    const tenantId = registration.tokenTenant(token);
    if (!tenantId) return null;
    return withTenant(this.db, { tenantId }, async (tx) => {
      const reg = await registration.registrationByToken(tx, token);
      return reg ? fn(tx, tenantId, reg) : null;
    });
  }

  async view(token: string, locale?: string) {
    return this.withToken(token, async (tx, tenantId, reg) => {
      const d = await details(tx, reg.occurrenceId, locale ?? reg.locale, this.now());
      return {
        registration: reg,
        details: d,
        rights: registration.attendeeRights(reg, d.target, this.now()),
        admissionToken: await registration.admissionToken(tx, tenantId, reg),
      };
    });
  }

  async update(token: string, patch: registration.RegistrationPatch) {
    return this.withToken(token, (tx, tenantId, reg) => registration.updateRegistration(tx, tenantId, reg.id, patch, { kind: "attendee" }, { now: this.now() }));
  }

  async cancel(token: string) {
    return this.withToken(token, (tx, tenantId, reg) => registration.cancelRegistration(tx, tenantId, reg.id, { kind: "attendee" }, this.now()));
  }
}
