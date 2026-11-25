// The HubSpot calls the platform makes (docs/hubspot.md). The API uses the OAuth part when an
// owner connects or disconnects; the worker refreshes tokens and sets up the portal. Tests and
// local stacks use FakeHubSpot, so nothing calls HubSpot unless HUBSPOT_CLIENT_ID is set.

export interface HubSpotAppConfig {
  clientId: string;
  clientSecret: string;
  /** Where HubSpot sends the browser back after install: the admin's callback page. */
  redirectUrl: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** When the access token stops working. */
  expiresAt: Date;
}

export interface TokenInfo {
  /** The portal (hub) id. */
  portalId: string;
  scopes: string[];
  /** The HubSpot user who installed the app. */
  user: string | null;
}

/** What the portal says about itself (`/account-info/v3/details`); it does not show the Marketing Hub tier (spike run 1). */
export interface AccountDetails {
  portalId: string;
  timeZone: string | null;
  accountType: string | null;
}

/** A contact as the platform wants it. Names are only written where HubSpot has none. */
export interface ContactInput {
  email: string;
  firstname: string | null;
  lastname: string | null;
}

/** HubSpot's record for an upserted contact; `created`: HubSpot made it now (the upsert's `new`). */
export interface ContactResult {
  email: string;
  id: string;
  created: boolean;
}

/** One marketing event per occurrence (docs/hubspot.md, "Marketing events and attendance"). */
export interface MarketingEventInput {
  /** The account id. */
  externalAccountId: string;
  /** The occurrence id. */
  externalEventId: string;
  eventName: string;
  eventOrganizer: string;
  eventType: string;
  startDateTime: Date;
  endDateTime: Date;
  eventUrl: string | null;
  eventCancelled: boolean;
}

export type AttendanceState = "register" | "cancel" | "attend";

/** A HubSpot list (a segment in the UI). The platform's own are static: `processingType` MANUAL. */
export interface ContactList {
  listId: string;
  name: string;
  processingType: string;
  /** Members, where HubSpot says (searches do). */
  size?: number | null;
}

/** A contact read by record id, with the properties asked for. */
export interface ContactRecord {
  id: string;
  properties: Record<string, string | null>;
}

/** A subscription type (communication preferences v4). */
export interface SubscriptionType {
  id: string;
  name: string;
  active: boolean;
}

/** A contact's status for one subscription type. */
export type SubscriptionState = "SUBSCRIBED" | "UNSUBSCRIBED" | "NOT_SPECIFIED";

export interface SubscriptionWrite {
  email: string;
  subscriptionId: string;
  status: SubscriptionState;
}

/**
 * What says the client has taken a contact into use (docs/hubspot.md, "Cleaning up a contact"):
 * an owner, associations, form submissions, lists and marketing events.
 */
export interface ContactUsage {
  /** HubSpot has no such contact (deleted there). */
  missing: boolean;
  marketable: boolean;
  owner: boolean;
  associations: number;
  conversions: number;
  listIds: string[];
  /** Marketing events the contact takes part in, by external account and event id where HubSpot says. */
  marketingEvents: { externalAccountId: string | null; externalEventId: string | null }[];
}

export interface Workflow {
  id: string;
  name: string;
  enabled: boolean;
}

/** The explanation written with an unsubscribe in portals that ask for a legal basis. */
export const LEGAL_BASIS = {
  legalBasis: "LEGITIMATE_INTEREST_OTHER",
  legalBasisExplanation: "Event manager: temporary contact for an event invitation; not for other marketing",
} as const;

/** What HubSpot did with a membership change; `missing`: record ids it has no contact for. */
export interface MembershipChange {
  missing: string[];
}

/** The kinds of email the platform can send through HubSpot (docs/hubspot.md, "HubSpot sending"). */
export type EmailKind = "invitation" | "reminder" | "welcome";

/** How the API shows an email saved for the single-send API (spike run 10). */
export const SINGLE_SEND_TYPE = "MARKETING_SINGLE_SEND_API";

/** A marketing email as the connector reads it. */
export interface MarketingEmail {
  id: string;
  name: string;
  type: string | null;
  /** `AUTOMATED_DRAFT` until published, then `AUTOMATED` (single-send). */
  state: string | null;
  subject: string | null;
  subscriptionId: string | null;
  /** The content as HubSpot holds it (widgets, flex areas); placeholders are literal text in it. Null in listings. */
  content: unknown;
}

export interface EmailPatch {
  name?: string;
  subject?: string;
  content?: unknown;
}

export interface SingleSendInput {
  emailId: string;
  to: string;
  /** Our own id for the send: HubSpot ignores a repeat (`IDEMPOTENT_IGNORE`, spike run 14). */
  sendId: string;
  /** `{{ custom.<name> }}` in the email. HubSpot does not store them. */
  customProperties: Record<string, string>;
}

/** A single send's state. `status` COMPLETE or CANCELED when done; `sendResult` then says what happened. */
export interface SendStatus {
  statusId: string;
  status: string;
  sendResult: string | null;
}

/** Send results that mean the guest got (or already had) the email. */
export const SENT_RESULTS = ["SENT", "IDEMPOTENT_IGNORE"] as const;

/** A HubSpot answer that is not a success. `unauthorized`: the token is refused (uninstalled, revoked). */
export class HubSpotError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "HubSpotError";
  }
  get unauthorized() {
    return this.status === 401 || this.status === 403;
  }
  get retryable() {
    return this.status === 429 || this.status >= 500 || this.status === 0;
  }
}

/**
 * How HubSpot refreshes tokens and refuses them: the auth a connection session needs
 * (`integrations.withProvider` in the domain), shared by the API and the worker.
 */
export function hubspotAuth(client: Pick<HubSpotClient, "refresh">) {
  return {
    refresh: (refreshToken: string) => client.refresh(refreshToken),
    // HubSpot answers 400 to a refresh token it no longer accepts.
    refusedRefresh: (e: unknown) => e instanceof HubSpotError && (e.unauthorized || e.status === 400),
    refusedAccess: (e: unknown) => e instanceof HubSpotError && e.unauthorized,
  };
}

export interface HubSpotClient {
  /** The install URL an owner is sent to. */
  authorizeUrl(state: string, scopes: { required: readonly string[]; optional: readonly string[] }): string;
  exchangeCode(code: string): Promise<TokenSet>;
  /** A new access token. HubSpot keeps the refresh token, but returns it again. */
  refresh(refreshToken: string): Promise<TokenSet>;
  tokenInfo(accessToken: string): Promise<TokenInfo>;
  /** Uninstall from our side; an unknown token counts as revoked. */
  revoke(refreshToken: string): Promise<void>;
  /** The portal behind a token: the setup job checks that our token reaches the portal we connected. */
  accountDetails(accessToken: string): Promise<AccountDetails>;
  /** Upserts contacts by email (up to 100), filling in names only where HubSpot has none. */
  upsertContacts(accessToken: string, contacts: ContactInput[]): Promise<ContactResult[]>;
  /** Creates the marketing event, or updates it when `exists`; returns HubSpot's object id. */
  saveMarketingEvent(accessToken: string, event: MarketingEventInput, exists: boolean): Promise<{ objectId: string | null }>;
  /** Marks a marketing event cancelled (its occurrence was deleted); one HubSpot no longer has is fine. */
  cancelMarketingEvent(accessToken: string, externalAccountId: string, externalEventId: string): Promise<void>;
  /** Records attendance by email (up to 100); HubSpot processes it in the background (spike run 17). */
  recordAttendance(accessToken: string, externalAccountId: string, externalEventId: string, state: AttendanceState, emails: string[], at: Date): Promise<void>;
  /** The contact list with this exact name, or null. List names are unique in a portal. */
  findListByName(accessToken: string, name: string): Promise<ContactList | null>;
  /** Creates a static contact list. */
  createList(accessToken: string, name: string): Promise<ContactList>;
  /** Adds contacts by record id. A list HubSpot no longer has is a 404 HubSpotError. */
  addToList(accessToken: string, listId: string, recordIds: string[]): Promise<MembershipChange>;
  /** Removes contacts by record id. A list HubSpot no longer has is a 404 HubSpotError. */
  removeFromList(accessToken: string, listId: string, recordIds: string[]): Promise<MembershipChange>;
  /** Every member's record id. A list HubSpot no longer has is a 404 HubSpotError. */
  listMembers(accessToken: string, listId: string): Promise<string[]>;
  /** Contact lists (segments) whose name contains `query`, most recently changed first; at most 50. */
  searchLists(accessToken: string, query: string): Promise<ContactList[]>;
  /** One list by id, or null if HubSpot has none. */
  getList(accessToken: string, listId: string): Promise<ContactList | null>;
  /** Contacts by record id (up to 100) with these properties; ids HubSpot no longer has are left out. */
  readContacts(accessToken: string, ids: string[], properties: string[]): Promise<ContactRecord[]>;
  /** Deletes the list; one HubSpot no longer has is fine. A 400 means something (a sent email) still uses it. */
  deleteList(accessToken: string, listId: string): Promise<void>;
  /** The portal's subscription types. */
  subscriptionTypes(accessToken: string): Promise<SubscriptionType[]>;
  /** Each email's status per subscription type; types HubSpot does not list count as NOT_SPECIFIED. */
  subscriptionStatuses(accessToken: string, emails: string[]): Promise<Map<string, Map<string, SubscriptionState>>>;
  /** Sets statuses, with a legal basis where the portal asks for one. */
  setSubscriptionStatuses(accessToken: string, writes: SubscriptionWrite[]): Promise<void>;
  /** hs_marketable_status by contact id (up to 100); contacts HubSpot does not have are left out. */
  marketableStatuses(accessToken: string, contactIds: string[]): Promise<Map<string, boolean>>;
  /** What the cleanup checks before deleting a contact the platform created. */
  contactUsage(accessToken: string, contactId: string, email: string): Promise<ContactUsage>;
  /** Deletes a contact (HubSpot can restore it for 90 days); one HubSpot no longer has is fine. */
  deleteContact(accessToken: string, contactId: string): Promise<void>;
  /** The workflow, or null if HubSpot no longer has it. */
  getWorkflow(accessToken: string, flowId: string): Promise<Workflow | null>;
  /** Creates the enabled contact workflow that sets contacts enrolled from the list to non-marketing and takes them out of it. */
  createNonMarketingWorkflow(accessToken: string, name: string, listId: string): Promise<Workflow>;
  /** Turns a workflow on. */
  enableWorkflow(accessToken: string, flowId: string): Promise<void>;
  /** hs_marketable_status and contact id by email, for contacts HubSpot has (up to 100); creates nothing. */
  contactsByEmail(accessToken: string, emails: string[]): Promise<Map<string, { id: string; marketable: boolean }>>;
  /** The portal's marketing emails, without content. */
  listEmails(accessToken: string): Promise<MarketingEmail[]>;
  /** One email with its content, or null if HubSpot has none by that id. */
  getEmail(accessToken: string, emailId: string): Promise<MarketingEmail | null>;
  /** A copy of the email, as a draft; a clone of a single-send email stays one (spike run 10). Returns its id. */
  cloneEmail(accessToken: string, emailId: string, name: string): Promise<string>;
  updateEmail(accessToken: string, emailId: string, patch: EmailPatch): Promise<void>;
  /** Publishing a single-send email sends nothing; HubSpot accepts sends some seconds later (run 7). */
  publishEmail(accessToken: string, emailId: string): Promise<void>;
  /** Deletes an email; one HubSpot no longer has is fine. */
  deleteEmail(accessToken: string, emailId: string): Promise<void>;
  /** One email to one recipient. A draft is refused with a 400 ("draft state"). */
  singleSend(accessToken: string, input: SingleSendInput): Promise<SendStatus>;
  sendStatus(accessToken: string, statusId: string): Promise<SendStatus>;
}

const API = "https://api.hubapi.com";

interface RawList {
  listId: string | number;
  name: string;
  processingType?: string;
  objectTypeId?: string;
  size?: number;
  additionalProperties?: { hs_list_size?: string | number | null };
}
interface RawFlow {
  id?: string | number;
  name?: string;
  isEnabled?: boolean;
  [k: string]: unknown;
}
interface RawEmail {
  id: string | number;
  name?: string;
  type?: string;
  state?: string;
  subject?: string;
  subscriptionDetails?: { subscriptionId?: string | number | null };
  content?: unknown;
}
const toEmail = (e: RawEmail, withContent: boolean): MarketingEmail => ({
  id: String(e.id),
  name: e.name ?? "",
  type: e.type ?? null,
  state: e.state ?? null,
  subject: e.subject ?? null,
  subscriptionId: e.subscriptionDetails?.subscriptionId != null ? String(e.subscriptionDetails.subscriptionId) : null,
  content: withContent ? (e.content ?? null) : null,
});
const toStatus = (r: { statusId?: string | number; status?: string; sendResult?: string } | null, statusId = ""): SendStatus => ({
  statusId: r?.statusId !== undefined ? String(r.statusId) : statusId,
  status: r?.status ?? "PENDING",
  sendResult: r?.sendResult ?? null,
});
/** The single-send endpoint that worked in the spike (runs 12–14). */
const SINGLE_SEND_PATH = "/marketing/email-campaigns/2026-09/single-send";

const toList = (l: RawList): ContactList => ({
  listId: String(l.listId), name: l.name, processingType: l.processingType ?? "MANUAL",
  size: l.additionalProperties?.hs_list_size != null ? Number(l.additionalProperties.hs_list_size) : (l.size ?? null),
});

/** The real client: HubSpot's OAuth v1 endpoints and the APIs the connector uses. */
export class HttpHubSpot implements HubSpotClient {
  constructor(
    private readonly app: HubSpotAppConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  authorizeUrl(state: string, scopes: { required: readonly string[]; optional: readonly string[] }): string {
    const u = new URL("https://app.hubspot.com/oauth/authorize");
    u.searchParams.set("client_id", this.app.clientId);
    u.searchParams.set("redirect_uri", this.app.redirectUrl);
    u.searchParams.set("scope", scopes.required.join(" "));
    if (scopes.optional.length) u.searchParams.set("optional_scope", scopes.optional.join(" "));
    u.searchParams.set("state", state);
    return u.toString();
  }

  async exchangeCode(code: string): Promise<TokenSet> {
    return this.token({ grant_type: "authorization_code", redirect_uri: this.app.redirectUrl, code });
  }

  async refresh(refreshToken: string): Promise<TokenSet> {
    return this.token({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  async tokenInfo(accessToken: string): Promise<TokenInfo> {
    const body = (await this.call("GET", `/oauth/v1/access-tokens/${encodeURIComponent(accessToken)}`)) as { hub_id: number; scopes?: string[]; user?: string };
    return { portalId: String(body.hub_id), scopes: body.scopes ?? [], user: body.user ?? null };
  }

  async revoke(refreshToken: string): Promise<void> {
    try {
      await this.call("DELETE", `/oauth/v1/refresh-tokens/${encodeURIComponent(refreshToken)}`);
    } catch (e) {
      if (e instanceof HubSpotError && (e.status === 400 || e.status === 404)) return;
      throw e;
    }
  }

  async accountDetails(accessToken: string): Promise<AccountDetails> {
    const body = (await this.call("GET", "/account-info/v3/details", undefined, accessToken)) as { portalId: number; timeZone?: string; accountType?: string };
    return { portalId: String(body.portalId), timeZone: body.timeZone ?? null, accountType: body.accountType ?? null };
  }

  async upsertContacts(accessToken: string, contacts: ContactInput[]): Promise<ContactResult[]> {
    if (!contacts.length) return [];
    // Names are the client's once set: read what HubSpot has, and only write what is empty.
    const read = (await this.call("POST", "/crm/v3/objects/contacts/batch/read", { idProperty: "email", properties: ["email", "firstname", "lastname"], inputs: contacts.map((c) => ({ id: c.email })) }, accessToken)) as {
      results?: { properties?: Record<string, string | null> }[];
    } | null;
    const have = new Map((read?.results ?? []).map((r) => [(r.properties?.email ?? "").toLowerCase(), r.properties ?? {}]));
    const inputs = contacts.map((c) => {
      const existing = have.get(c.email.toLowerCase()) ?? {};
      const properties: Record<string, string> = { email: c.email };
      if (c.firstname && !existing.firstname) properties.firstname = c.firstname;
      if (c.lastname && !existing.lastname) properties.lastname = c.lastname;
      return { idProperty: "email", id: c.email, properties };
    });
    const body = (await this.call("POST", "/crm/v3/objects/contacts/batch/upsert", { inputs }, accessToken)) as { results?: { id: string; new?: boolean; properties?: Record<string, string | null> }[] } | null;
    return (body?.results ?? []).map((r) => ({ email: (r.properties?.email ?? "").toLowerCase(), id: String(r.id), created: r.new === true }));
  }

  async saveMarketingEvent(accessToken: string, event: MarketingEventInput, exists: boolean): Promise<{ objectId: string | null }> {
    const body = {
      eventName: event.eventName,
      eventOrganizer: event.eventOrganizer,
      eventType: event.eventType,
      startDateTime: event.startDateTime.toISOString(),
      endDateTime: event.endDateTime.toISOString(),
      eventCancelled: event.eventCancelled,
      ...(event.eventUrl ? { eventUrl: event.eventUrl } : {}),
    };
    const path = `/marketing/v3/marketing-events/events/${encodeURIComponent(event.externalEventId)}?externalAccountId=${encodeURIComponent(event.externalAccountId)}`;
    if (exists) {
      try {
        const r = (await this.call("PATCH", path, body, accessToken)) as { objectId?: string } | null;
        return { objectId: r?.objectId ?? null };
      } catch (e) {
        // Deleted in HubSpot: make it again.
        if (!(e instanceof HubSpotError && e.status === 404)) throw e;
      }
    }
    const r = (await this.call("POST", "/marketing/v3/marketing-events/events", { ...body, externalAccountId: event.externalAccountId, externalEventId: event.externalEventId }, accessToken)) as { objectId?: string } | null;
    return { objectId: r?.objectId ?? null };
  }

  async cancelMarketingEvent(accessToken: string, externalAccountId: string, externalEventId: string): Promise<void> {
    try {
      await this.call("POST", `/marketing/v3/marketing-events/events/${encodeURIComponent(externalEventId)}/cancel?externalAccountId=${encodeURIComponent(externalAccountId)}`, undefined, accessToken);
    } catch (e) {
      if (!(e instanceof HubSpotError && e.status === 404)) throw e;
    }
  }

  async recordAttendance(accessToken: string, externalAccountId: string, externalEventId: string, state: AttendanceState, emails: string[], at: Date): Promise<void> {
    if (!emails.length) return;
    await this.call(
      "POST",
      `/marketing/v3/marketing-events/attendance/${encodeURIComponent(externalEventId)}/${state}/email-create?externalAccountId=${encodeURIComponent(externalAccountId)}`,
      { inputs: emails.map((email) => ({ email, interactionDateTime: at.getTime() })) },
      accessToken,
    );
  }

  async findListByName(accessToken: string, name: string): Promise<ContactList | null> {
    try {
      const r = (await this.call("GET", `/crm/v3/lists/object-type-id/0-1/name/${encodeURIComponent(name)}`, undefined, accessToken)) as { list?: RawList } | null;
      return r?.list ? toList(r.list) : null;
    } catch (e) {
      if (e instanceof HubSpotError && e.status === 404) return null;
      throw e;
    }
  }

  async createList(accessToken: string, name: string): Promise<ContactList> {
    const r = (await this.call("POST", "/crm/v3/lists", { name, objectTypeId: "0-1", processingType: "MANUAL" }, accessToken)) as { list?: RawList } | null;
    if (!r?.list) throw new HubSpotError("HubSpot POST /crm/v3/lists: no list in the answer", 502);
    return toList(r.list);
  }

  async addToList(accessToken: string, listId: string, recordIds: string[]): Promise<MembershipChange> {
    if (!recordIds.length) return { missing: [] };
    const r = (await this.call("PUT", `/crm/v3/lists/${encodeURIComponent(listId)}/memberships/add`, recordIds, accessToken)) as { recordIdsMissing?: (string | number)[] } | null;
    return { missing: (r?.recordIdsMissing ?? []).map(String) };
  }

  async removeFromList(accessToken: string, listId: string, recordIds: string[]): Promise<MembershipChange> {
    if (!recordIds.length) return { missing: [] };
    const r = (await this.call("PUT", `/crm/v3/lists/${encodeURIComponent(listId)}/memberships/remove`, recordIds, accessToken)) as { recordIdsMissing?: (string | number)[] } | null;
    return { missing: (r?.recordIdsMissing ?? []).map(String) };
  }

  async listMembers(accessToken: string, listId: string): Promise<string[]> {
    const ids: string[] = [];
    let after: string | undefined;
    do {
      const q = `limit=250${after ? `&after=${encodeURIComponent(after)}` : ""}`;
      const r = (await this.call("GET", `/crm/v3/lists/${encodeURIComponent(listId)}/memberships?${q}`, undefined, accessToken)) as {
        results?: { recordId: string | number }[];
        paging?: { next?: { after?: string } };
      } | null;
      for (const m of r?.results ?? []) ids.push(String(m.recordId));
      after = r?.paging?.next?.after;
    } while (after);
    return ids;
  }

  async searchLists(accessToken: string, query: string): Promise<ContactList[]> {
    const r = (await this.call("POST", "/crm/v3/lists/search", { query, count: 50, offset: 0, additionalProperties: ["hs_list_size"] }, accessToken)) as { lists?: RawList[] } | null;
    return (r?.lists ?? []).filter((l) => (l.objectTypeId ?? "0-1") === "0-1").map(toList);
  }

  async getList(accessToken: string, listId: string): Promise<ContactList | null> {
    try {
      const r = (await this.call("GET", `/crm/v3/lists/${encodeURIComponent(listId)}?includeFilters=false`, undefined, accessToken)) as { list?: RawList } | null;
      return r?.list ? toList(r.list) : null;
    } catch (e) {
      if (e instanceof HubSpotError && e.status === 404) return null;
      throw e;
    }
  }

  async readContacts(accessToken: string, ids: string[], properties: string[]): Promise<ContactRecord[]> {
    if (!ids.length) return [];
    const r = (await this.call("POST", "/crm/v3/objects/contacts/batch/read", { properties, inputs: ids.map((id) => ({ id })) }, accessToken)) as {
      results?: { id: string | number; properties?: Record<string, string | null> }[];
    } | null;
    return (r?.results ?? []).map((c) => ({ id: String(c.id), properties: c.properties ?? {} }));
  }

  async deleteList(accessToken: string, listId: string): Promise<void> {
    try {
      await this.call("DELETE", `/crm/v3/lists/${encodeURIComponent(listId)}`, undefined, accessToken);
    } catch (e) {
      if (!(e instanceof HubSpotError && e.status === 404)) throw e;
    }
  }

  async subscriptionTypes(accessToken: string): Promise<SubscriptionType[]> {
    const r = (await this.call("GET", "/communication-preferences/v4/definitions", undefined, accessToken)) as { results?: { id: string | number; name: string; isActive?: boolean }[] } | null;
    return (r?.results ?? []).map((d) => ({ id: String(d.id), name: d.name, active: d.isActive !== false }));
  }

  async subscriptionStatuses(accessToken: string, emails: string[]): Promise<Map<string, Map<string, SubscriptionState>>> {
    const out = new Map<string, Map<string, SubscriptionState>>();
    if (!emails.length) return out;
    const r = (await this.call("POST", "/communication-preferences/v4/statuses/batch/read?channel=EMAIL", { inputs: emails }, accessToken)) as {
      results?: { subscriberIdString?: string; statuses?: { subscriptionId?: string | number; status?: string }[] }[];
    } | null;
    for (const e of emails) out.set(e.toLowerCase(), new Map());
    for (const res of r?.results ?? []) {
      const m = out.get((res.subscriberIdString ?? "").toLowerCase());
      if (!m) continue;
      for (const st of res.statuses ?? []) if (st.subscriptionId !== undefined && st.status) m.set(String(st.subscriptionId), st.status as SubscriptionState);
    }
    return out;
  }

  async setSubscriptionStatuses(accessToken: string, writes: SubscriptionWrite[]): Promise<void> {
    for (let i = 0; i < writes.length; i += 100) {
      const chunk = writes.slice(i, i + 100);
      const inputs = (legal: boolean) =>
        chunk.map((w) => ({ subscriberIdString: w.email, subscriptionId: Number(w.subscriptionId), statusState: w.status, channel: "EMAIL", ...(legal ? LEGAL_BASIS : {}) }));
      try {
        await this.call("POST", "/communication-preferences/v4/statuses/batch/write", { inputs: inputs(false) }, accessToken);
      } catch (e) {
        // Portals with data privacy settings on need a legal basis on every write.
        if (!(e instanceof HubSpotError && e.status === 400 && /legal/i.test(e.message))) throw e;
        await this.call("POST", "/communication-preferences/v4/statuses/batch/write", { inputs: inputs(true) }, accessToken);
      }
    }
  }

  async marketableStatuses(accessToken: string, contactIds: string[]): Promise<Map<string, boolean>> {
    if (!contactIds.length) return new Map();
    const r = (await this.call("POST", "/crm/v3/objects/contacts/batch/read", { properties: ["hs_marketable_status"], inputs: contactIds.map((id) => ({ id })) }, accessToken)) as {
      results?: { id: string; properties?: Record<string, string | null> }[];
    } | null;
    return new Map((r?.results ?? []).map((c) => [String(c.id), c.properties?.hs_marketable_status === "true"]));
  }

  async contactUsage(accessToken: string, contactId: string, email: string): Promise<ContactUsage> {
    let contact: { properties?: Record<string, string | null>; associations?: Record<string, { results?: unknown[] }> } | null;
    try {
      contact = (await this.call(
        "GET",
        `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}?properties=hubspot_owner_id,num_conversion_events,hs_marketable_status&associations=companies,deals,tickets`,
        undefined,
        accessToken,
      )) as typeof contact;
    } catch (e) {
      if (e instanceof HubSpotError && e.status === 404) return { missing: true, marketable: false, owner: false, associations: 0, conversions: 0, listIds: [], marketingEvents: [] };
      throw e;
    }
    const p = contact?.properties ?? {};
    const associations = Object.values(contact?.associations ?? {}).reduce((n, a) => n + (a.results?.length ?? 0), 0);
    const lists = (await this.call("GET", `/crm/v3/lists/records/0-1/${encodeURIComponent(contactId)}/memberships`, undefined, accessToken)) as { results?: { listId: string | number }[] } | null;
    const events = (await this.call("GET", `/marketing/v3/marketing-events/participations/contacts/${encodeURIComponent(email)}/breakdown`, undefined, accessToken)) as {
      results?: { associations?: { marketingEvent?: { externalAccountId?: string; externalEventId?: string } } }[];
    } | null;
    return {
      missing: false,
      marketable: p.hs_marketable_status === "true",
      owner: !!p.hubspot_owner_id,
      associations,
      conversions: Number(p.num_conversion_events ?? 0) || 0,
      listIds: (lists?.results ?? []).map((l) => String(l.listId)),
      marketingEvents: (events?.results ?? []).map((x) => ({
        externalAccountId: x.associations?.marketingEvent?.externalAccountId ?? null,
        externalEventId: x.associations?.marketingEvent?.externalEventId ?? null,
      })),
    };
  }

  async deleteContact(accessToken: string, contactId: string): Promise<void> {
    try {
      await this.call("DELETE", `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`, undefined, accessToken);
    } catch (e) {
      if (!(e instanceof HubSpotError && e.status === 404)) throw e;
    }
  }

  async getWorkflow(accessToken: string, flowId: string): Promise<Workflow | null> {
    try {
      const f = (await this.call("GET", `/automation/v4/flows/${encodeURIComponent(flowId)}`, undefined, accessToken)) as RawFlow | null;
      return f ? { id: String(f.id), name: String(f.name ?? ""), enabled: f.isEnabled === true } : null;
    } catch (e) {
      if (e instanceof HubSpotError && e.status === 404) return null;
      throw e;
    }
  }

  async createNonMarketingWorkflow(accessToken: string, name: string, listId: string): Promise<Workflow> {
    // Spike run 16: the action *Set marketing contact status* is actionTypeId 0-31.
    const body = {
      type: "CONTACT_FLOW", objectTypeId: "0-1", flowType: "WORKFLOW", isEnabled: true, name,
      startActionId: "1", nextAvailableActionId: "2",
      actions: [{ type: "SINGLE_CONNECTION", actionId: "1", actionTypeVersion: 0, actionTypeId: "0-31", fields: { marketableType: "NON_MARKETABLE" } }],
      enrollmentCriteria: {
        type: "LIST_BASED", shouldReEnroll: true, unEnrollObjectsNotMeetingCriteria: false, reEnrollmentTriggersFilterBranches: [],
        listFilterBranch: { filterBranchType: "OR", filters: [], filterBranches: [{ filterBranchType: "AND", filterBranches: [], filters: [{ filterType: "IN_LIST", listId, operator: "IN_LIST" }] }] },
      },
    };
    const f = (await this.call("POST", "/automation/v4/flows", body, accessToken)) as RawFlow | null;
    if (!f?.id) throw new HubSpotError("HubSpot POST /automation/v4/flows: no flow in the answer", 502);
    return { id: String(f.id), name, enabled: f.isEnabled === true };
  }

  async enableWorkflow(accessToken: string, flowId: string): Promise<void> {
    // v4 updates take the whole flow with its revision.
    const f = (await this.call("GET", `/automation/v4/flows/${encodeURIComponent(flowId)}`, undefined, accessToken)) as RawFlow | null;
    if (!f) throw new HubSpotError(`HubSpot GET /automation/v4/flows/${flowId}: empty answer`, 502);
    await this.call("PUT", `/automation/v4/flows/${encodeURIComponent(flowId)}`, { ...f, isEnabled: true }, accessToken);
  }

  async contactsByEmail(accessToken: string, emails: string[]): Promise<Map<string, { id: string; marketable: boolean }>> {
    if (!emails.length) return new Map();
    const r = (await this.call("POST", "/crm/v3/objects/contacts/batch/read", { idProperty: "email", properties: ["email", "hs_marketable_status"], inputs: emails.map((id) => ({ id })) }, accessToken)) as {
      results?: { id: string; properties?: Record<string, string | null> }[];
    } | null;
    return new Map((r?.results ?? []).map((c) => [(c.properties?.email ?? "").toLowerCase(), { id: String(c.id), marketable: c.properties?.hs_marketable_status === "true" }]));
  }

  async listEmails(accessToken: string): Promise<MarketingEmail[]> {
    const out: MarketingEmail[] = [];
    let after: string | undefined;
    do {
      const q = `limit=100&includeStats=false${after ? `&after=${encodeURIComponent(after)}` : ""}`;
      const r = (await this.call("GET", `/marketing/v3/emails?${q}`, undefined, accessToken)) as { results?: RawEmail[]; paging?: { next?: { after?: string } } } | null;
      for (const e of r?.results ?? []) out.push(toEmail(e, false));
      after = r?.paging?.next?.after;
    } while (after && out.length < 2000);
    return out;
  }

  async getEmail(accessToken: string, emailId: string): Promise<MarketingEmail | null> {
    try {
      const e = (await this.call("GET", `/marketing/v3/emails/${encodeURIComponent(emailId)}`, undefined, accessToken)) as RawEmail | null;
      return e ? toEmail(e, true) : null;
    } catch (e) {
      if (e instanceof HubSpotError && e.status === 404) return null;
      throw e;
    }
  }

  async cloneEmail(accessToken: string, emailId: string, name: string): Promise<string> {
    const r = (await this.call("POST", "/marketing/v3/emails/clone", { id: emailId, cloneName: name }, accessToken)) as { id?: string | number } | null;
    if (r?.id === undefined) throw new HubSpotError("HubSpot POST /marketing/v3/emails/clone: no email in the answer", 502);
    return String(r.id);
  }

  async updateEmail(accessToken: string, emailId: string, patch: EmailPatch): Promise<void> {
    await this.call("PATCH", `/marketing/v3/emails/${encodeURIComponent(emailId)}`, patch, accessToken);
  }

  async publishEmail(accessToken: string, emailId: string): Promise<void> {
    await this.call("POST", `/marketing/v3/emails/${encodeURIComponent(emailId)}/publish`, undefined, accessToken);
  }

  async deleteEmail(accessToken: string, emailId: string): Promise<void> {
    try {
      await this.call("DELETE", `/marketing/v3/emails/${encodeURIComponent(emailId)}`, undefined, accessToken);
    } catch (e) {
      if (!(e instanceof HubSpotError && e.status === 404)) throw e;
    }
  }

  async singleSend(accessToken: string, input: SingleSendInput): Promise<SendStatus> {
    const body = { emailId: Number(input.emailId), message: { to: input.to, sendId: input.sendId }, customProperties: input.customProperties };
    return toStatus((await this.call("POST", SINGLE_SEND_PATH, body, accessToken)) as Parameters<typeof toStatus>[0]);
  }

  async sendStatus(accessToken: string, statusId: string): Promise<SendStatus> {
    return toStatus((await this.call("GET", `/marketing/v3/email/send-statuses/${encodeURIComponent(statusId)}`, undefined, accessToken)) as Parameters<typeof toStatus>[0], statusId);
  }

  private async token(params: Record<string, string>): Promise<TokenSet> {
    const form = new URLSearchParams({ client_id: this.app.clientId, client_secret: this.app.clientSecret, ...params });
    const res = await this.send("POST", `${API}/oauth/v1/token`, { "content-type": "application/x-www-form-urlencoded" }, form.toString());
    const body = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
    return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: new Date(Date.now() + body.expires_in * 1000) };
  }

  private async call(method: string, path: string, body?: unknown, accessToken?: string): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await this.send(method, `${API}${path}`, headers, body === undefined ? undefined : JSON.stringify(body));
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  private async send(method: string, url: string, headers: Record<string, string>, body?: string): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchFn(url, { method, headers, body, signal: AbortSignal.timeout(15_000) });
    } catch (e) {
      throw new HubSpotError(`HubSpot did not answer: ${e instanceof Error ? e.message : String(e)}`, 0);
    }
    if (res.ok) return res;
    const text = await res.text().catch(() => "");
    let message = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { message?: string };
      if (j.message) message = j.message;
    } catch {
      // not JSON
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    throw new HubSpotError(`HubSpot ${method} ${new URL(url).pathname.replace(/\/(access|refresh)-tokens\/.*/, "/$1-tokens/…")}: ${res.status} ${message}`, res.status, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null);
  }
}
