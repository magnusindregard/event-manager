import { randomBytes } from "node:crypto";
import {
  type AccountDetails,
  type AttendanceState,
  type ContactInput,
  type ContactList,
  type ContactUsage,
  type ContactResult,
  type HubSpotClient,
  HubSpotError,
  type MarketingEventInput,
  type MembershipChange,
  type SubscriptionState,
  type SubscriptionType,
  type SubscriptionWrite,
  type TokenInfo,
  type TokenSet,
  type Workflow,
} from "./client.js";

interface FakePortal {
  portalId: string;
  scopes: string[];
  /** Contacts by lower-case email. `marketable`, `owner`, `associations`, `conversions`: what the cleanup checks. */
  contacts: Map<string, FakeContact>;
  /** Marketing events by external event id. */
  events: Map<string, MarketingEventInput & { objectId: string }>;
  /** Attendance records, in the order recorded. */
  attendance: { externalEventId: string; state: AttendanceState; email: string }[];
  /** Contact lists by list id, with member record ids. */
  lists: Map<string, ContactList & { members: Set<string> }>;
  subscriptionTypes: SubscriptionType[];
  /** Status by lower-case email and type id; NOT_SPECIFIED where not set. */
  subscriptions: Map<string, Map<string, SubscriptionState>>;
  workflows: Map<string, Workflow & { listId: string }>;
}

export interface FakeContact {
  id: string;
  email: string;
  firstname: string | null;
  lastname: string | null;
  marketable?: boolean;
  owner?: boolean;
  associations?: number;
  conversions?: number;
}

const emptyPortal = (portalId: string, scopes: string[]): FakePortal => ({ portalId, scopes, contacts: new Map(), events: new Map(), attendance: [], lists: new Map(), subscriptionTypes: [], subscriptions: new Map(), workflows: new Map() });

/**
 * HubSpot in memory, for tests and local stacks. `approve` stands in for the owner approving
 * the install in HubSpot: it returns the code the admin's callback page receives.
 *
 * With `local` (HUBSPOT=fake on a local stack) the install is approved at once: the install URL
 * goes straight to the admin's callback page with a code. The API and the worker are separate
 * processes with separate fakes, so in this mode every token is accepted and belongs to the
 * one local portal.
 */
export class FakeHubSpot implements HubSpotClient {
  readonly portals = new Map<string, FakePortal>();
  readonly calls: string[] = [];
  private readonly codes = new Map<string, string>();
  private readonly refreshTokens = new Map<string, string>();
  private readonly accessTokens = new Map<string, { portalId: string; expiresAt: Date }>();
  /** Lifetime of access tokens handed out from now on. */
  accessTokenSeconds = 1800;

  constructor(
    private readonly log?: (line: string) => void,
    private readonly local?: { redirectUrl: string; portalId: string },
  ) {}

  authorizeUrl(state: string, scopes: { required: readonly string[]; optional: readonly string[] }): string {
    if (this.local) {
      const u = new URL(this.local.redirectUrl);
      u.searchParams.set("code", this.approve(this.local.portalId, [...scopes.required]));
      u.searchParams.set("state", state);
      return u.toString();
    }
    const u = new URL("https://app.hubspot.test/oauth/authorize");
    u.searchParams.set("scope", scopes.required.join(" "));
    u.searchParams.set("optional_scope", scopes.optional.join(" "));
    u.searchParams.set("state", state);
    return u.toString();
  }

  /** The owner approves in portal `portalId`; returns the authorization code. */
  approve(portalId: string, scopes: string[]): string {
    const portal = this.portals.get(portalId) ?? emptyPortal(portalId, scopes);
    portal.scopes = scopes;
    this.portals.set(portalId, portal);
    const code = `code-${randomBytes(6).toString("hex")}`;
    this.codes.set(code, portalId);
    return code;
  }

  /** The portal uninstalls the app: every token stops working. */
  uninstall(portalId: string) {
    for (const [t, p] of this.refreshTokens) if (p === portalId) this.refreshTokens.delete(t);
    for (const [t, a] of this.accessTokens) if (a.portalId === portalId) this.accessTokens.delete(t);
  }

  /** Makes every access token for the portal expire now, so the next use refreshes. */
  expireAccessTokens(portalId: string) {
    for (const a of this.accessTokens.values()) if (a.portalId === portalId) a.expiresAt = new Date(0);
  }

  async exchangeCode(code: string): Promise<TokenSet> {
    this.calls.push("exchangeCode");
    const portalId = this.codes.get(code);
    if (!portalId) throw new HubSpotError("HubSpot POST /oauth/v1/token: 400 invalid code", 400);
    this.codes.delete(code);
    const refreshToken = `rt-${randomBytes(8).toString("hex")}`;
    this.refreshTokens.set(refreshToken, portalId);
    return { ...this.issue(portalId), refreshToken };
  }

  async refresh(refreshToken: string): Promise<TokenSet> {
    this.calls.push("refresh");
    const portalId = this.refreshTokens.get(refreshToken) ?? this.localPortal()?.portalId;
    if (!portalId) throw new HubSpotError("HubSpot POST /oauth/v1/token: 400 BAD_REFRESH_TOKEN", 400);
    return { ...this.issue(portalId), refreshToken };
  }

  async tokenInfo(accessToken: string): Promise<TokenInfo> {
    this.calls.push("tokenInfo");
    const portal = this.portalFor(accessToken);
    return { portalId: portal.portalId, scopes: [...portal.scopes], user: "admin@portal.test" };
  }

  async revoke(refreshToken: string): Promise<void> {
    this.calls.push("revoke");
    this.refreshTokens.delete(refreshToken);
  }

  async accountDetails(accessToken: string): Promise<AccountDetails> {
    this.calls.push("accountDetails");
    const portal = this.portalFor(accessToken);
    return { portalId: portal.portalId, timeZone: "Europe/Oslo", accountType: "STANDARD" };
  }

  private nextId = 1000;

  async upsertContacts(accessToken: string, contacts: ContactInput[]): Promise<ContactResult[]> {
    this.calls.push(`upsertContacts:${contacts.length}`);
    const portal = this.portalFor(accessToken);
    return contacts.map((c) => {
      const key = c.email.toLowerCase();
      const existing = portal.contacts.get(key);
      if (existing) {
        existing.firstname ??= c.firstname;
        existing.lastname ??= c.lastname;
        return { email: key, id: existing.id, created: false };
      }
      const id = String(this.nextId++);
      portal.contacts.set(key, { id, email: c.email, firstname: c.firstname, lastname: c.lastname });
      return { email: key, id, created: true };
    });
  }

  async saveMarketingEvent(accessToken: string, event: MarketingEventInput, exists: boolean): Promise<{ objectId: string | null }> {
    this.calls.push(`saveMarketingEvent:${exists ? "update" : "create"}:${event.externalEventId}`);
    const portal = this.portalFor(accessToken);
    const objectId = portal.events.get(event.externalEventId)?.objectId ?? String(this.nextId++);
    portal.events.set(event.externalEventId, { ...event, objectId });
    return { objectId };
  }

  async cancelMarketingEvent(accessToken: string, _externalAccountId: string, externalEventId: string): Promise<void> {
    this.calls.push(`cancelMarketingEvent:${externalEventId}`);
    const e = this.portalFor(accessToken).events.get(externalEventId);
    if (e) e.eventCancelled = true;
  }

  async recordAttendance(accessToken: string, _externalAccountId: string, externalEventId: string, state: AttendanceState, emails: string[]): Promise<void> {
    this.calls.push(`recordAttendance:${state}:${emails.length}`);
    const portal = this.portalFor(accessToken);
    if (!portal.events.has(externalEventId)) throw new HubSpotError(`HubSpot POST attendance: 404 no marketing event ${externalEventId}`, 404);
    for (const email of emails) portal.attendance.push({ externalEventId, state, email: email.toLowerCase() });
  }

  /** Lists that a sent email uses: HubSpot refuses to delete them. */
  readonly listsInUse = new Set<string>();

  async findListByName(accessToken: string, name: string): Promise<ContactList | null> {
    this.calls.push(`findListByName:${name}`);
    const l = [...this.portalFor(accessToken).lists.values()].find((x) => x.name === name);
    return l ? { listId: l.listId, name: l.name, processingType: l.processingType } : null;
  }

  async createList(accessToken: string, name: string): Promise<ContactList> {
    this.calls.push(`createList:${name}`);
    const portal = this.portalFor(accessToken);
    if ([...portal.lists.values()].some((l) => l.name === name)) throw new HubSpotError(`HubSpot POST /crm/v3/lists: 400 a list named ${name} exists`, 400);
    const list = { listId: String(this.nextId++), name, processingType: "MANUAL" };
    portal.lists.set(list.listId, { ...list, members: new Set() });
    return list;
  }

  async addToList(accessToken: string, listId: string, recordIds: string[]): Promise<MembershipChange> {
    this.calls.push(`addToList:${listId}:${recordIds.length}`);
    const portal = this.portalFor(accessToken);
    const list = this.list(portal, listId);
    const known = new Set([...portal.contacts.values()].map((c) => c.id));
    const missing = recordIds.filter((id) => !known.has(id));
    for (const id of recordIds) if (known.has(id)) list.members.add(id);
    return { missing };
  }

  async removeFromList(accessToken: string, listId: string, recordIds: string[]): Promise<MembershipChange> {
    this.calls.push(`removeFromList:${listId}:${recordIds.length}`);
    const list = this.list(this.portalFor(accessToken), listId);
    for (const id of recordIds) list.members.delete(id);
    return { missing: [] };
  }

  async listMembers(accessToken: string, listId: string): Promise<string[]> {
    this.calls.push(`listMembers:${listId}`);
    return [...this.list(this.portalFor(accessToken), listId).members];
  }

  async deleteList(accessToken: string, listId: string): Promise<void> {
    this.calls.push(`deleteList:${listId}`);
    if (this.listsInUse.has(listId)) throw new HubSpotError(`HubSpot DELETE /crm/v3/lists/${listId}: 400 blocked for deletion due to references`, 400);
    this.portalFor(accessToken).lists.delete(listId);
  }

  async subscriptionTypes(accessToken: string): Promise<SubscriptionType[]> {
    this.calls.push("subscriptionTypes");
    return this.portalFor(accessToken).subscriptionTypes.map((t) => ({ ...t }));
  }

  async subscriptionStatuses(accessToken: string, emails: string[]): Promise<Map<string, Map<string, SubscriptionState>>> {
    this.calls.push(`subscriptionStatuses:${emails.length}`);
    const portal = this.portalFor(accessToken);
    return new Map(emails.map((e) => [e.toLowerCase(), new Map(portal.subscriptions.get(e.toLowerCase()) ?? [])]));
  }

  async setSubscriptionStatuses(accessToken: string, writes: SubscriptionWrite[]): Promise<void> {
    this.calls.push(`setSubscriptionStatuses:${writes.length}`);
    const portal = this.portalFor(accessToken);
    for (const w of writes) {
      const key = w.email.toLowerCase();
      const m = portal.subscriptions.get(key) ?? new Map<string, SubscriptionState>();
      // An app cannot subscribe someone who unsubscribed (spike run 15).
      if (w.status === "SUBSCRIBED" && m.get(w.subscriptionId) === "UNSUBSCRIBED" && !this.allowResubscribe) {
        throw new HubSpotError("HubSpot POST /communication-preferences/v4/statuses/batch/write: 400 cannot resubscribe", 400);
      }
      m.set(w.subscriptionId, w.status);
      portal.subscriptions.set(key, m);
    }
  }
  /** Lets setSubscriptionStatuses set SUBSCRIBED over UNSUBSCRIBED (HubSpot does not). */
  allowResubscribe = false;

  async marketableStatuses(accessToken: string, contactIds: string[]): Promise<Map<string, boolean>> {
    this.calls.push(`marketableStatuses:${contactIds.length}`);
    const byId = new Map([...this.portalFor(accessToken).contacts.values()].map((c) => [c.id, c]));
    return new Map(contactIds.filter((id) => byId.has(id)).map((id) => [id, byId.get(id)!.marketable === true]));
  }

  async contactUsage(accessToken: string, contactId: string, email: string): Promise<ContactUsage> {
    this.calls.push(`contactUsage:${contactId}`);
    const portal = this.portalFor(accessToken);
    const c = [...portal.contacts.values()].find((x) => x.id === contactId);
    if (!c) return { missing: true, marketable: false, owner: false, associations: 0, conversions: 0, listIds: [], marketingEvents: [] };
    const key = email.toLowerCase();
    const events = [...new Set(portal.attendance.filter((a) => a.email === key).map((a) => a.externalEventId))];
    return {
      missing: false,
      marketable: c.marketable === true,
      owner: c.owner === true,
      associations: c.associations ?? 0,
      conversions: c.conversions ?? 0,
      listIds: [...portal.lists.values()].filter((l) => l.members.has(contactId)).map((l) => l.listId),
      marketingEvents: events.map((id) => ({ externalAccountId: portal.events.get(id)?.externalAccountId ?? this.foreignEvents.get(id) ?? null, externalEventId: id })),
    };
  }
  /** Marketing events of the client's own, by external event id, with their external account id. */
  readonly foreignEvents = new Map<string, string>();

  async deleteContact(accessToken: string, contactId: string): Promise<void> {
    this.calls.push(`deleteContact:${contactId}`);
    const portal = this.portalFor(accessToken);
    for (const [k, c] of portal.contacts) if (c.id === contactId) portal.contacts.delete(k);
    for (const l of portal.lists.values()) l.members.delete(contactId);
  }

  async getWorkflow(accessToken: string, flowId: string): Promise<Workflow | null> {
    this.calls.push(`getWorkflow:${flowId}`);
    const f = this.portalFor(accessToken).workflows.get(flowId);
    return f ? { id: f.id, name: f.name, enabled: f.enabled } : null;
  }

  async createNonMarketingWorkflow(accessToken: string, name: string, listId: string): Promise<Workflow> {
    this.calls.push(`createNonMarketingWorkflow:${listId}`);
    const f = { id: String(this.nextId++), name, enabled: true, listId };
    this.portalFor(accessToken).workflows.set(f.id, f);
    return { id: f.id, name, enabled: true };
  }

  async enableWorkflow(accessToken: string, flowId: string): Promise<void> {
    this.calls.push(`enableWorkflow:${flowId}`);
    const f = this.portalFor(accessToken).workflows.get(flowId);
    if (!f) throw new HubSpotError(`HubSpot /automation/v4/flows/${flowId}: 404`, 404);
    f.enabled = true;
  }

  /**
   * Stands in for HubSpot running the non-marketing workflow: contacts in its list are set to
   * non-marketing and taken out of the list. Returns how many it set.
   */
  runWorkflows(portalId: string): number {
    const portal = this.portals.get(portalId)!;
    let n = 0;
    for (const f of portal.workflows.values()) {
      if (!f.enabled) continue;
      const list = portal.lists.get(f.listId);
      if (!list) continue;
      for (const id of list.members) {
        const c = [...portal.contacts.values()].find((x) => x.id === id);
        if (c) c.marketable = false;
        n++;
      }
      list.members.clear();
    }
    return n;
  }

  private list(portal: FakePortal, listId: string) {
    const l = portal.lists.get(listId);
    if (!l) throw new HubSpotError(`HubSpot /crm/v3/lists/${listId}: 404 list not found`, 404);
    return l;
  }

  private issue(portalId: string): Omit<TokenSet, "refreshToken"> {
    const accessToken = `at-${randomBytes(8).toString("hex")}`;
    const expiresAt = new Date(Date.now() + this.accessTokenSeconds * 1000);
    this.accessTokens.set(accessToken, { portalId, expiresAt });
    this.log?.(`hubspot (fake): token for portal ${portalId}`);
    return { accessToken, expiresAt };
  }

  private localPortal(): FakePortal | null {
    if (!this.local) return null;
    const { portalId } = this.local;
    if (!this.portals.has(portalId)) this.portals.set(portalId, emptyPortal(portalId, []));
    return this.portals.get(portalId)!;
  }

  private portalFor(accessToken: string): FakePortal {
    const local = this.localPortal();
    if (local) return local;
    const a = this.accessTokens.get(accessToken);
    if (!a || a.expiresAt <= new Date()) throw new HubSpotError("HubSpot: 401 expired or unknown token", 401);
    return this.portals.get(a.portalId)!;
  }
}
