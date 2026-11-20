import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

// Sign-in pass-through for MCP clients (docs/mcp.md, "Sign-in through Entra").
//
// MCP clients send `resource=<MCP server URL>` (RFC 8707) to the authorization server. Entra
// External ID refuses a resource that does not match the requested scope (AADSTS9010010), and
// its discovery document does not advertise PKCE, which MCP clients require. So the API acts as
// the authorization server clients see: it publishes Entra's endpoints as its own, and its
// authorize and token endpoints drop `resource` before handing the request to Entra unchanged
// otherwise. Users sign in on Entra's page; Entra issues the tokens; nothing is stored or logged.

export interface OAuthProxyOptions {
  /** The staff IdP's issuer (OIDC_ISSUER). */
  issuer: string;
  /** Scopes MCP clients ask for (MCP_OAUTH_SCOPES). */
  scopes: string[];
  /** This API's public base URL for the request, without a trailing slash. */
  baseUrl: (req: FastifyRequest) => string;
}

interface Upstream {
  authorization_endpoint: string;
  token_endpoint: string;
}

const TIMEOUT_MS = 15_000;
const FORM = "application/x-www-form-urlencoded";

export async function oauthProxy(app: FastifyInstance, opts: OAuthProxyOptions) {
  // Entra's endpoints, from its discovery document; fetched on first use, and again after a failure.
  let upstream: Promise<Upstream> | undefined;
  const endpoints = () =>
    (upstream ??= (async () => {
      const url = `${opts.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
      const doc = (await res.json()) as Partial<Upstream>;
      if (!doc.authorization_endpoint || !doc.token_endpoint) throw new Error("OIDC discovery: endpoints missing");
      return { authorization_endpoint: doc.authorization_endpoint, token_endpoint: doc.token_endpoint };
    })().catch((e: unknown) => {
      upstream = undefined;
      throw e;
    }));

  const unavailable = (reply: FastifyReply, req: FastifyRequest, e: unknown) => {
    req.log.error({ err: e }, "MCP sign-in: identity provider unreachable");
    return reply.status(502).header("cache-control", "no-store").send({ error: "temporarily_unavailable", error_description: "The identity provider could not be reached. Try again." });
  };

  // Scopes as sent, plus offline_access so Entra issues a refresh token (else staff sign in hourly).
  const withOfflineAccess = (scope: string | null) => {
    const set = new Set((scope ?? "").split(/\s+/).filter(Boolean));
    if (set.size === 0) return scope;
    set.add("offline_access");
    return [...set].join(" ");
  };

  // RFC 8414 metadata. Clients look for it under both well-known names.
  const metadata = async (req: FastifyRequest) => {
    const base = opts.baseUrl(req);
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
      scopes_supported: [...opts.scopes, "offline_access"],
    };
  };
  app.get("/.well-known/oauth-authorization-server", { schema: { hide: true } }, metadata);
  app.get("/.well-known/openid-configuration", { schema: { hide: true } }, metadata);

  // Authorize: the same query minus `resource`, redirected to Entra. Entra checks everything else.
  app.get("/oauth/authorize", { schema: { hide: true } }, async (req, reply) => {
    let target: string;
    try {
      target = (await endpoints()).authorization_endpoint;
    } catch (e) {
      return unavailable(reply, req, e);
    }
    const query = new URLSearchParams(req.url.includes("?") ? req.url.slice(req.url.indexOf("?") + 1) : "");
    query.delete("resource");
    const scope = withOfflineAccess(query.get("scope"));
    if (scope) query.set("scope", scope);
    return reply.redirect(`${target}?${query}`, 302);
  });

  // Token: the same form minus `resource`, posted to Entra; Entra's answer is passed back as is.
  app.register(async (token) => {
    token.addContentTypeParser(FORM, { parseAs: "string", bodyLimit: 64 * 1024 }, (_req, body, done) => done(null, body));
    token.post("/oauth/token", { schema: { hide: true } }, async (req, reply) => {
      if (!String(req.headers["content-type"] ?? "").startsWith(FORM)) {
        return reply.status(400).header("cache-control", "no-store").send({ error: "invalid_request", error_description: `Content-Type must be ${FORM}` });
      }
      let target: string;
      try {
        target = (await endpoints()).token_endpoint;
      } catch (e) {
        return unavailable(reply, req, e);
      }
      const form = new URLSearchParams(typeof req.body === "string" ? req.body : "");
      form.delete("resource");
      if (form.get("grant_type") === "refresh_token" && form.has("scope")) form.set("scope", withOfflineAccess(form.get("scope"))!);
      const headers: Record<string, string> = { "content-type": FORM, accept: "application/json" };
      if (typeof req.headers.authorization === "string") headers.authorization = req.headers.authorization;
      let res: Response;
      try {
        res = await fetch(target, { method: "POST", headers, body: form.toString(), signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch (e) {
        return unavailable(reply, req, e);
      }
      return reply
        .status(res.status)
        .header("content-type", res.headers.get("content-type") ?? "application/json")
        .header("cache-control", "no-store")
        .header("pragma", "no-cache")
        .send(await res.text());
    });
  });
}
