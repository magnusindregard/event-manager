import { type Db, type Tx, withoutTenant, withTenant } from "@event-manager/db";
import { catalog, registration, sales, tenancy } from "@event-manager/domain";

// The attendee API and the hosted pages share these, so a page does exactly what the API
// does. Every call finds its tenant first (from the occurrence, or from the signed token)
// and then runs in that tenant's transaction, like every other request.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The form the attendee fills in, and how long sensitive answers are kept (for the consent text). */
export interface FormDetails {
  fields: registration.FormField[];
  sensitiveDeleteAfterDays: number;
}

export interface Details {
  form: FormDetails;
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
  const form = await registration.getForm(tx, target.event.id);
  const locale = wanted && account.locales.includes(wanted) ? wanted : account.defaultLocale;
  const t = target.event.translations[locale] ?? target.event.translations[account.defaultLocale] ?? Object.values(target.event.translations)[0];
  return {
    form: { fields: form.fields, sensitiveDeleteAfterDays: account.sensitiveDeleteAfterDays },
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

/** An occurrence the guest can pick on the invitation page. */
export interface InvitationOption {
  target: catalog.RegistrationTarget;
  availability: catalog.Availability;
  /** Open for registration and not full, or full with an open waitlist. */
  bookable: boolean;
}

export interface InvitationDetails {
  form: FormDetails;
  locale: string;
  locales: string[];
  account: { name: string };
  invitation: registration.GuestInvitation;
  event: catalog.CatalogEvent;
  title: string;
  shortDescription: string | null;
  image: { url: string; alt: string | null } | null;
  guestAllowed: boolean;
  options: InvitationOption[];
  now: Date;
}

async function invitationDetails(tx: Tx, inv: registration.GuestInvitation, wanted: string | undefined, now: Date): Promise<InvitationDetails> {
  const [account, event, targets, form] = await Promise.all([
    tenancy.getAccount(tx), catalog.getEvent(tx, inv.eventId), catalog.upcomingRegistrationTargets(tx, inv.eventId, now), registration.getForm(tx, inv.eventId),
  ]);
  const pick = [wanted, inv.locale].find((l): l is string => !!l && account.locales.includes(l));
  const locale = pick ?? account.defaultLocale;
  const t = event.translations[locale] ?? event.translations[account.defaultLocale] ?? Object.values(event.translations)[0];
  const options = targets
    .filter((target) => target.event.admissionMode === "registration" && target.pool)
    .map((target) => {
      const availability = catalog.targetAvailability(target, now);
      // A full time with an open waitlist can be chosen too: accepting joins its waitlist.
      return { target, availability, bookable: ["available", "few_left", "waitlist"].includes(availability.status) };
    });
  return {
    form: { fields: form.fields, sensitiveDeleteAfterDays: account.sensitiveDeleteAfterDays },
    locale, locales: account.locales, account: { name: account.name }, invitation: inv, event,
    title: t?.title ?? event.slug, shortDescription: t?.shortDescription ?? null, image: t?.imageUrl ? { url: t.imageUrl, alt: t.imageAlt } : null,
    guestAllowed: registration.effectiveGuestAllowed(inv, event.registration), options, now,
  };
}

/** Picks the first of the browser's languages that the account offers. */
export function preferredLocale(acceptLanguage: string | undefined): string | undefined {
  return acceptLanguage?.split(",").map((s) => s.split(";")[0]!.trim().split("-")[0]!.toLowerCase()).find(Boolean);
}

/** A registration with its answers; the attendee sees all of their own, sensitive ones too. */
export interface AttendeeRegistration {
  registration: registration.Registration;
  answers: registration.Answers;
  /** Place in line while waitlisted. */
  waitlistPosition: number | null;
}

const withAnswers = async (tx: Tx, tenantId: string, reg: registration.Registration): Promise<AttendeeRegistration> => ({
  registration: reg,
  answers: (await registration.readAnswers(tx, tenantId, [reg.id], { kind: "attendee" })).get(reg.id) ?? {},
  waitlistPosition: reg.status === "waitlisted" ? ((await registration.waitlistRanks(tx, [reg.id])).get(reg.id) ?? null) : null,
});

export interface RegistrationView extends AttendeeRegistration {
  details: Details;
  rights: { change: boolean; cancel: boolean; claim: boolean };
  admissionToken: string | null;
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

  async register(occurrenceId: string, input: registration.RegistrationInput): Promise<(AttendeeRegistration & { manageToken: string }) | null> {
    const tenantId = await this.tenantOf(occurrenceId);
    if (!tenantId) return null;
    return withTenant(this.db, { tenantId }, async (tx) => {
      const reg = await registration.register(tx, tenantId, occurrenceId, input, { kind: "attendee" }, this.now());
      return { ...(await withAnswers(tx, tenantId, reg)), manageToken: await registration.manageToken(tx, tenantId, reg) };
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

  async view(token: string, locale?: string): Promise<RegistrationView | null> {
    return this.withToken(token, async (tx, tenantId, reg) => {
      const d0 = await details(tx, reg.occurrenceId, locale ?? reg.locale, this.now());
      // An invited guest's allowance can differ from the event's.
      const d: Details = { ...d0, target: { ...d0.target, event: { ...d0.target.event, guestAllowed: await registration.guestAllowedFor(tx, reg, d0.target) } } };
      return {
        ...(await withAnswers(tx, tenantId, reg)),
        details: d,
        rights: registration.attendeeRights(reg, d.target, this.now()),
        admissionToken: await registration.admissionToken(tx, tenantId, reg),
      };
    });
  }

  async update(token: string, patch: registration.RegistrationPatch): Promise<AttendeeRegistration | null> {
    return this.withToken(token, async (tx, tenantId, reg) =>
      withAnswers(tx, tenantId, await registration.updateRegistration(tx, tenantId, reg.id, patch, { kind: "attendee" }, { now: this.now() })));
  }

  /** Claims a waitlist offer. */
  async claim(token: string): Promise<AttendeeRegistration | null> {
    return this.withToken(token, async (tx, tenantId, reg) => withAnswers(tx, tenantId, await registration.claimOffer(tx, tenantId, reg.id, this.now())));
  }

  async cancel(token: string): Promise<AttendeeRegistration | null> {
    return this.withToken(token, async (tx, tenantId, reg) => withAnswers(tx, tenantId, await registration.cancelRegistration(tx, tenantId, reg.id, { kind: "attendee" }, this.now())));
  }

  // ── Ticket links ──

  /** The ticket page's data, or null for an invalid token. */
  async ticket(token: string, locale?: string): Promise<sales.TicketPage | null> {
    const tenantId = sales.ticketTenant(token);
    if (!tenantId) return null;
    return withTenant(this.db, { tenantId }, (tx) => sales.ticketPage(tx, token, locale));
  }

  // ── Invitation links ──

  /** Runs fn for the invitation behind a personal link; null for an invalid token. */
  private async withInvitation<T>(token: string, fn: (tx: Tx, tenantId: string, inv: registration.GuestInvitation) => Promise<T>): Promise<T | null> {
    const tenantId = registration.tokenTenant(token);
    if (!tenantId) return null;
    return withTenant(this.db, { tenantId }, async (tx) => {
      const inv = await registration.invitationByToken(tx, token);
      return inv ? fn(tx, tenantId, inv) : null;
    });
  }

  /** The invitation page's data; for a guest who has accepted, their manage token instead. */
  async invitation(token: string, locale?: string): Promise<{ accepted: string } | { details: InvitationDetails } | null> {
    return this.withInvitation(token, async (tx, tenantId, inv) => {
      const regId = await registration.activeRegistrationFor(tx, inv.id);
      if (regId) return { accepted: await registration.manageToken(tx, tenantId, await registration.getRegistration(tx, regId)) };
      return { details: await invitationDetails(tx, inv, locale, this.now()) };
    });
  }

  async accept(token: string, input: registration.AcceptInput): Promise<(AttendeeRegistration & { manageToken: string }) | null> {
    return this.withInvitation(token, async (tx, tenantId, inv) => {
      const reg = await registration.acceptInvitation(tx, tenantId, inv.id, input, this.now());
      return { ...(await withAnswers(tx, tenantId, reg)), manageToken: await registration.manageToken(tx, tenantId, reg) };
    });
  }

  /** The form behind an invitation link, to read a posted form; null for an invalid token. */
  async invitationForm(token: string): Promise<FormDetails | null> {
    return this.withInvitation(token, async (tx, _tenantId, inv) => {
      const [form, account] = await Promise.all([registration.getForm(tx, inv.eventId), tenancy.getAccount(tx)]);
      return { fields: form.fields, sensitiveDeleteAfterDays: account.sensitiveDeleteAfterDays };
    });
  }

  async decline(token: string): Promise<registration.GuestInvitation | null> {
    return this.withInvitation(token, (tx, tenantId, inv) => registration.declineInvitation(tx, tenantId, inv.id, this.now()));
  }
}
