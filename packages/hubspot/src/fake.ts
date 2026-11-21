import { randomBytes } from "node:crypto";
import { type ContactPropertySpec, type HubSpotClient, HubSpotError, type TokenInfo, type TokenSet } from "./client.js";

interface FakePortal {
  portalId: string;
  scopes: string[];
  groups: Map<string, string>;
  properties: Map<string, ContactPropertySpec>;
}

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
    const portal = this.portals.get(portalId) ?? { portalId, scopes, groups: new Map(), properties: new Map() };
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

  async ensureContactPropertyGroup(accessToken: string, name: string, label: string): Promise<void> {
    this.calls.push(`ensureContactPropertyGroup:${name}`);
    const portal = this.portalFor(accessToken);
    if (!portal.groups.has(name)) portal.groups.set(name, label);
  }

  async ensureContactProperty(accessToken: string, spec: ContactPropertySpec): Promise<void> {
    this.calls.push(`ensureContactProperty:${spec.name}`);
    const portal = this.portalFor(accessToken);
    if (!portal.groups.has(spec.groupName)) throw new HubSpotError(`HubSpot POST /crm/v3/properties/contacts: 400 group ${spec.groupName} does not exist`, 400);
    if (!portal.properties.has(spec.name)) portal.properties.set(spec.name, spec);
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
    if (!this.portals.has(portalId)) this.portals.set(portalId, { portalId, scopes: [], groups: new Map(), properties: new Map() });
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
