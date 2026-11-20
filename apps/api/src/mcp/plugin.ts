import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ErrorCode, GetPromptRequestSchema, ListPromptsRequestSchema, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { tenancy } from "@event-manager/domain";
import { AuthError } from "../auth.js";
import { ArgumentError, bindTools, type Caller, errorResult, inject, requestFor, type ToolDefinition, type ToolResult, toolResult } from "./dispatch.js";
import { oauthProxy } from "./oauth.js";
import type { OperationRegistry } from "./operations.js";
import { loadSkills } from "./skills.js";
import { OPERATION_TOOLS } from "./tools.js";

// MCP server at /mcp (ADR 0007, ADR 0016, docs/mcp.md): Streamable HTTP, stateless, JSON
// responses. Staff sign in as for the admin; every tool call is a /v1 request made with their
// own token, so they can do through an agent exactly what they can do in the admin.

export interface McpOptions {
  operations: OperationRegistry;
  /**
   * The staff IdP's issuer, first entry (OIDC_ISSUER); empty: no sign-in for MCP clients. Clients
   * see this API as their authorization server, which passes sign-in through to it (oauth.ts).
   */
  authorizationServers: string[];
  /** Scopes a client asks for to call this API, e.g. api://em-api/access. */
  scopes: string[];
  /** Public base URL of this API; else derived from the request. */
  publicUrl?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INSTRUCTIONS = `Event manager: find, create and configure the account's events on behalf of the signed-in staff member, with their permissions.
- Before creating or configuring an event, get the prompt "create-event" or "configure-event" (also available as skills) and follow it.
- Read before you write: list_events to find events and avoid duplicates, get_event_configuration for an event's current set-up, get_account for locales and timezone.
- Never guess facts the human has not given or the data does not show. Ask, then summarise what you will do and get a yes before any write.
- Events are created as drafts. Publish, unpublish or cancel only when the human says so explicitly.
- Changes take the resource's \`version\` from your latest read. A version_conflict means someone else changed it: read it again and re-check with the human.
- Times: occurrences are UTC instants; series take local wall time in the event's timezone.`;

const WHOAMI: ToolDefinition = {
  name: "whoami",
  title: "Who am I",
  description: "The signed-in user, the accounts they belong to with their roles and permissions, and which account the tools act on. Call it first if you do not know the account, or after an account_id_required or forbidden error.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { title: "Who am I", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

const CONFIGURATION: ToolDefinition = {
  name: "get_event_configuration",
  title: "Get an event's configuration",
  description: "Everything that configures one event in one call: the event, its recurring series, its occurrences from `from` (default now), its offers (ticket types) and its rules. Use it before changing an event and to review an event with the human.",
  inputSchema: {
    type: "object",
    properties: {
      eventId: { type: "string", format: "uuid" },
      from: { type: "string", format: "date-time", description: "Occurrences ending after this; default now" },
      occurrenceLimit: { type: "integer", minimum: 1, maximum: 200, default: 50, description: "At most this many occurrences; use list_occurrences for more" },
    },
    required: ["eventId"],
    additionalProperties: false,
  },
  annotations: { title: "Get an event's configuration", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

export async function mcpPlugin(app: FastifyInstance, opts: McpOptions) {
  let bindings: ReturnType<typeof bindTools> | undefined;
  // Routes are all registered once the app is ready; bind on first use and fail loudly in tests.
  const tools = () => (bindings ??= bindTools(OPERATION_TOOLS, opts.operations));
  app.addHook("onReady", async () => {
    tools();
    loadSkills();
  });

  // Container Apps (and Front Door) end TLS and forward plain HTTP, so req.protocol is "http" for a
  // client that used https. Clients reject metadata whose resource differs from the URL they used,
  // so the scheme the proxy saw (X-Forwarded-Proto) wins. It only shapes this caller's metadata.
  const scheme = (req: FastifyRequest) => {
    const forwarded = req.headers["x-forwarded-proto"];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim().toLowerCase();
    return first === "https" || first === "http" ? first : req.protocol;
  };
  const baseUrl = (req: FastifyRequest) => (opts.publicUrl ?? `${scheme(req)}://${req.host}`).replace(/\/$/, "");
  const metadataUrl = (req: FastifyRequest) => `${baseUrl(req)}/.well-known/oauth-protected-resource/mcp`;

  const issuer = opts.authorizationServers[0];
  if (issuer) await app.register(oauthProxy, { issuer, scopes: opts.scopes, baseUrl });

  // RFC 9728: tells MCP clients where to sign in. Served under both well-known paths clients try.
  const metadata = async (req: FastifyRequest) => ({
    resource: `${baseUrl(req)}/mcp`,
    authorization_servers: issuer ? [baseUrl(req)] : [],
    scopes_supported: opts.scopes,
    bearer_methods_supported: ["header"],
    resource_name: "Event manager",
  });
  app.get("/.well-known/oauth-protected-resource/mcp", { schema: { hide: true } }, metadata);
  app.get("/.well-known/oauth-protected-resource", { schema: { hide: true } }, metadata);

  const authenticate = async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await app.authenticate(req);
    } catch (e) {
      if (e instanceof AuthError) reply.header("www-authenticate", `Bearer resource_metadata="${metadataUrl(req)}"${opts.scopes.length ? `, scope="${opts.scopes.join(" ")}"` : ""}`);
      throw e;
    }
  };

  /** Account-Id header, else ?accountId= on the MCP URL, else the user's only account. */
  const accountFor = async (req: FastifyRequest): Promise<{ accountId: string | null; accounts: tenancy.AccountSummary[] }> => {
    const accounts = await tenancy.myAccounts(app.db, req.identity!.userId);
    const asked = req.headers["account-id"] ?? (req.query as { accountId?: string }).accountId;
    if (typeof asked === "string" && UUID.test(asked)) return { accountId: asked.toLowerCase(), accounts };
    return { accountId: accounts.length === 1 ? accounts[0]!.accountId : null, accounts };
  };

  const handle = async (req: FastifyRequest, reply: FastifyReply) => {
    const { accountId, accounts } = await accountFor(req);
    const server = new Server({ name: "event-manager", title: "Event manager", version: "1.0.0" }, { capabilities: { tools: {}, prompts: {} }, instructions: INSTRUCTIONS });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [WHOAMI, CONFIGURATION, ...[...tools().values()].map((b) => b.definition)] }));

    server.setRequestHandler(CallToolRequestSchema, async (call): Promise<ToolResult> => {
      const name = call.params.name;
      const args = (call.params.arguments ?? {}) as Record<string, unknown>;
      if (name === WHOAMI.name) {
        const active = accounts.find((a) => a.accountId === accountId) ?? null;
        const body = {
          userId: req.identity!.userId, email: req.identity!.email.toLowerCase(), name: req.identity!.name,
          activeAccount: active, accounts,
          ...(active ? {} : { note: accountId ? "You are not a member of the selected account." : "No account selected: the user belongs to several. Add ?accountId=<id> to the MCP server URL, or send the Account-Id header." }),
        };
        return { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body };
      }
      if (!accountId) {
        return errorResult("account_id_required", `No account selected. The user belongs to ${accounts.length} accounts (${accounts.map((a) => `${a.name}: ${a.accountId}`).join(", ") || "none"}). Connect with ?accountId=<id> on the MCP server URL or the Account-Id header.`);
      }
      const caller: Caller = { authorization: req.headers.authorization!, accountId };
      if (name === CONFIGURATION.name) return configuration(app, caller, args);
      const binding = tools().get(name);
      if (!binding) throw new McpError(ErrorCode.InvalidParams, `Unknown tool ${name}`);
      try {
        return toolResult(await inject(app, caller, requestFor(binding, args)));
      } catch (e) {
        if (e instanceof ArgumentError) return errorResult("invalid_request", e.message);
        throw e;
      }
    });

    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: loadSkills().map((s) => ({ name: s.name, description: s.description })),
    }));
    server.setRequestHandler(GetPromptRequestSchema, async (r) => {
      const skill = loadSkills().find((s) => s.name === r.params.name);
      if (!skill) throw new McpError(ErrorCode.InvalidParams, `Unknown prompt ${r.params.name}`);
      return { description: skill.description, messages: [{ role: "user", content: { type: "text", text: skill.body } }] };
    });

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    // hijack() skips Fastify's reply, so headers set by hooks (CORS) are copied to the raw response;
    // the SDK's writeHead merges them with its own.
    for (const [name, value] of Object.entries(reply.getHeaders())) if (value !== undefined) reply.raw.setHeader(name, value);
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  };

  app.post("/mcp", { schema: { hide: true }, preHandler: authenticate }, handle);
  // Stateless: no server-initiated stream and no sessions to end.
  const notAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.status(405).header("allow", "POST").send({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this MCP server is stateless; use POST" }, id: null });
  app.get("/mcp", { schema: { hide: true } }, notAllowed);
  app.delete("/mcp", { schema: { hide: true } }, notAllowed);
}

/** get_event_configuration: the event and everything that configures it, read in parallel. */
async function configuration(app: FastifyInstance, caller: Caller, args: Record<string, unknown>): Promise<ToolResult> {
  const eventId = args.eventId;
  if (typeof eventId !== "string" || !UUID.test(eventId)) return errorResult("invalid_request", "eventId must be an event's UUID");
  const unknown = Object.keys(args).filter((k) => !["eventId", "from", "occurrenceLimit"].includes(k));
  if (unknown.length) return errorResult("invalid_request", `Unknown argument ${unknown.join(", ")}. get_event_configuration takes: eventId, from, occurrenceLimit`);
  const from = typeof args.from === "string" ? args.from : new Date().toISOString();
  const limit = Number.isInteger(args.occurrenceLimit) ? Math.min(200, Math.max(1, args.occurrenceLimit as number)) : 50;
  const id = encodeURIComponent(eventId);
  const get = (url: string) => inject(app, caller, { method: "GET", url });
  const event = await get(`/v1/events/${id}`);
  if (event.status >= 400) return toolResult(event);
  const [series, occurrences, offers, rules] = await Promise.all([
    get(`/v1/events/${id}/series`),
    get(`/v1/events/${id}/occurrences?${new URLSearchParams({ from, limit: String(limit) })}`),
    get(`/v1/events/${id}/offers`),
    get(`/v1/events/${id}/rules`),
  ]);
  for (const r of [series, occurrences, offers, rules]) if (r.status >= 400) return toolResult(r);
  const items = <T>(r: { body: unknown }) => (r.body as { items: T[] }).items;
  const occ = occurrences.body as { items: unknown[]; nextCursor: string | null };
  return toolResult({
    status: 200,
    body: {
      event: event.body,
      series: items(series),
      occurrences: { from, items: occ.items, more: occ.nextCursor !== null, nextCursor: occ.nextCursor },
      offers: items(offers),
      rules: items(rules),
    },
  });
}
