import type { FastifyInstance } from "fastify";
import type { Operation, OperationRegistry } from "./operations.js";
import type { OperationTool } from "./tools.js";

// Turns a curated operation into an MCP tool, and a tool call into an injected /v1 request.

type JsonSchema = Record<string, unknown> & { properties?: Record<string, unknown>; required?: string[]; default?: unknown };

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties: false };
  annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Where each argument of a tool goes in the HTTP request. */
interface Binding {
  tool: OperationTool;
  op: Operation;
  definition: ToolDefinition;
  path: Map<string, string>; // argument → :param
  query: Set<string>;
  body: Set<string>;
  hasBody: boolean;
  hasIdempotencyKey: boolean;
}

export function bindTools(tools: OperationTool[], ops: OperationRegistry): Map<string, Binding> {
  const bindings = new Map<string, Binding>();
  for (const tool of tools) {
    const op = ops.get(tool.operationId);
    if (!op) throw new Error(`MCP tool ${tool.name}: no route with operationId ${tool.operationId}`);
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    const add = (name: string, schema: unknown, isRequired: boolean) => {
      if (name in properties) throw new Error(`MCP tool ${tool.name}: argument ${name} is defined twice`);
      properties[name] = schema;
      if (isRequired) required.push(name);
    };
    const path = new Map<string, string>();
    for (const [param, schema] of Object.entries(op.params?.properties ?? {})) {
      const arg = param === "id" && tool.id ? tool.id : param;
      path.set(arg, param);
      add(arg, schema, true);
    }
    const query = new Set<string>();
    for (const [name, schema] of Object.entries(op.querystring?.properties ?? {})) {
      query.add(name);
      // A query field with a default is filled in by the route; the agent may leave it out.
      add(name, schema, (op.querystring?.required ?? []).includes(name) && (schema as JsonSchema).default === undefined);
    }
    const body = new Set<string>();
    if (op.body && op.body.type !== "object") throw new Error(`MCP tool ${tool.name}: the body must be an object`);
    for (const [name, schema] of Object.entries(op.body?.properties ?? {})) {
      body.add(name);
      add(name, schema, (op.body?.required ?? []).includes(name));
    }
    if (tool.ifMatch) {
      add("version", { type: "integer", minimum: 1, description: "The `version` from your latest read of it. Refused with the current version if it has changed since" }, true);
    }
    const hasIdempotencyKey = Boolean(op.headers?.properties?.["idempotency-key"]);
    if (hasIdempotencyKey) {
      add("idempotencyKey", { type: "string", minLength: 1, maxLength: 255, description: "Any unique string. A retry with the same key and arguments returns the first result instead of creating a duplicate (24 hours)" }, false);
    }
    const definition: ToolDefinition = {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false },
      annotations: {
        title: tool.title,
        readOnlyHint: tool.kind === "read",
        destructiveHint: tool.kind === "write" && Boolean(tool.destructive),
        idempotentHint: tool.kind === "read" || Boolean(tool.idempotent),
        openWorldHint: false,
      },
    };
    bindings.set(tool.name, { tool, op, definition, path, query, body, hasBody: Boolean(op.body), hasIdempotencyKey });
  }
  return bindings;
}

export interface Caller {
  authorization: string;
  accountId: string;
}

export interface Response {
  status: number;
  body: unknown;
}

/** Sends the request through the app itself, so it is authenticated, authorized and validated as any /v1 call. */
export async function inject(app: FastifyInstance, caller: Caller, req: { method: string; url: string; headers?: Record<string, string>; body?: unknown }): Promise<Response> {
  const res = await app.inject({
    method: req.method as "GET",
    url: req.url,
    headers: { authorization: caller.authorization, "account-id": caller.accountId, ...req.headers },
    ...(req.body !== undefined ? { payload: req.body as object } : {}),
  });
  return { status: res.statusCode, body: res.body ? (res.json() as unknown) : undefined };
}

export class ArgumentError extends Error {}

export function requestFor(b: Binding, args: Record<string, unknown>) {
  const unknown = Object.keys(args).filter((k) => !(k in (b.definition.inputSchema.properties ?? {})));
  if (unknown.length) throw new ArgumentError(`Unknown argument${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}. ${b.tool.name} takes: ${Object.keys(b.definition.inputSchema.properties).join(", ")}`);
  let url = b.op.url;
  for (const [arg, param] of b.path) {
    const v = args[arg];
    if (typeof v !== "string" || !v) throw new ArgumentError(`${arg} is required`);
    url = url.replace(`:${param}`, encodeURIComponent(v));
  }
  const qs = new URLSearchParams();
  for (const name of b.query) {
    const v = args[name];
    if (v === undefined || v === null) continue;
    for (const item of [v].flat()) qs.append(name, String(item));
  }
  if (qs.size) url += `?${qs}`;
  const headers: Record<string, string> = {};
  if (b.tool.ifMatch) {
    if (!Number.isInteger(args.version)) throw new ArgumentError(`version is required: the resource's \`version\` from your latest read of it`);
    headers["if-match"] = `"${args.version as number}"`;
  }
  if (b.hasIdempotencyKey && typeof args.idempotencyKey === "string") headers["idempotency-key"] = args.idempotencyKey;
  let body: Record<string, unknown> | undefined;
  if (b.hasBody) {
    body = {};
    for (const name of b.body) if (args[name] !== undefined) body[name] = args[name];
  }
  return { method: b.op.method, url, headers, body };
}

interface ProblemBody {
  code?: string;
  title?: string;
  detail?: string;
  details?: Record<string, unknown>;
  errors?: { path: string; message: string }[];
}

/** What the agent should do next, per stable reason code. */
const HINTS: Record<string, string> = {
  version_conflict: "Someone changed it after you read it. Read it again, check with the human that the change still makes sense, and retry with the new version.",
  forbidden: "The signed-in user's role in this account does not allow this. Tell the human; an account owner can change their role in the admin.",
  not_found: "Nothing with that id in this account. Look it up again with the matching list tool; ids from another account do not work here.",
  invalid_request: "Some arguments do not match the tool's input schema; fix them and call again.",
  validation_failed: "The arguments are well-formed but not allowed as given. `details` names the field; explain the constraint to the human if the fix needs their decision.",
  precondition_required: "Pass the resource's current `version`.",
  idempotency_key_reused: "This idempotencyKey was used for different arguments. Use a new key for a new request.",
  unauthenticated: "The sign-in has expired or is invalid. Ask the human to reconnect the MCP server.",
  account_id_required: "No account is selected. Use whoami to list the accounts and ask the human which one.",
};

/** Maps a /v1 response to a tool result; errors keep the problem's code and details. */
export function toolResult(res: Response): ToolResult {
  if (res.status < 400) {
    const body = res.body === undefined || res.body === null ? { ok: true } : res.body;
    const structured = typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : { result: body };
    return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured };
  }
  const p = (res.body ?? {}) as ProblemBody;
  const code = p.code ?? `http_${res.status}`;
  const lines = [`${p.title ?? "Request failed"} (${code}, HTTP ${res.status}).`];
  if (p.detail) lines.push(p.detail);
  // Validation paths name the HTTP part (/body/translations); the agent knows only arguments.
  for (const e of p.errors ?? []) lines.push(`- ${e.path.replace(/^\/?(body|querystring|params|headers)\/?/, "").replace(/^\//, "").replaceAll("/", ".") || "(arguments)"}: ${e.message}`);
  if (p.details && Object.keys(p.details).length) lines.push(`Details: ${JSON.stringify(p.details)}`);
  if (HINTS[code]) lines.push(HINTS[code]);
  return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: { error: { status: res.status, code, title: p.title, detail: p.detail, details: p.details, errors: p.errors } }, isError: true };
}

export function errorResult(code: string, message: string): ToolResult {
  return { content: [{ type: "text", text: `${message}${HINTS[code] ? `\n${HINTS[code]}` : ""}` }], structuredContent: { error: { code, title: message } }, isError: true };
}
