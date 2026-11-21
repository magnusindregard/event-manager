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

export interface ContactPropertySpec {
  name: string;
  label: string;
  description: string;
  groupName: string;
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
  /** Creates the contact property group unless it exists. */
  ensureContactPropertyGroup(accessToken: string, name: string, label: string): Promise<void>;
  /** Creates the contact property unless it exists. */
  ensureContactProperty(accessToken: string, spec: ContactPropertySpec): Promise<void>;
}

const API = "https://api.hubapi.com";

/** The real client: HubSpot's OAuth v1 endpoints and CRM v3 properties API. */
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

  async ensureContactPropertyGroup(accessToken: string, name: string, label: string): Promise<void> {
    await this.createUnlessExists(accessToken, "/crm/v3/properties/contacts/groups", { name, label, displayOrder: -1 });
  }

  async ensureContactProperty(accessToken: string, spec: ContactPropertySpec): Promise<void> {
    await this.createUnlessExists(accessToken, "/crm/v3/properties/contacts", {
      name: spec.name,
      label: spec.label,
      description: spec.description,
      groupName: spec.groupName,
      type: "string",
      fieldType: "text",
      formField: false,
    });
  }

  private async createUnlessExists(accessToken: string, path: string, body: unknown) {
    try {
      await this.call("POST", path, body, accessToken);
    } catch (e) {
      if (e instanceof HubSpotError && e.status === 409) return;
      throw e;
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
