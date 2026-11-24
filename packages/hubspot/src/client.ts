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
}

/** What HubSpot did with a membership change; `missing`: record ids it has no contact for. */
export interface MembershipChange {
  missing: string[];
}

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
  /** Deletes the list; one HubSpot no longer has is fine. A 400 means something (a sent email) still uses it. */
  deleteList(accessToken: string, listId: string): Promise<void>;
}

const API = "https://api.hubapi.com";

interface RawList {
  listId: string | number;
  name: string;
  processingType?: string;
}
const toList = (l: RawList): ContactList => ({ listId: String(l.listId), name: l.name, processingType: l.processingType ?? "MANUAL" });

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

  async deleteList(accessToken: string, listId: string): Promise<void> {
    try {
      await this.call("DELETE", `/crm/v3/lists/${encodeURIComponent(listId)}`, undefined, accessToken);
    } catch (e) {
      if (!(e instanceof HubSpotError && e.status === 404)) throw e;
    }
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
