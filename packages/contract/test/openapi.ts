import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

// Checks traffic against an OpenAPI 3.1 document (ADR 0007). `contractFetch` is a fetch that
// sends each request to a Fastify app with inject and fails when the request, or the response's
// status, media type or body, is not what the spec says.

export type Spec = {
  paths: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, unknown>; securitySchemes?: Record<string, unknown> };
};
export interface Operation {
  operationId?: string;
  description?: string;
  security?: Record<string, string[]>[];
  parameters?: { in: string; name: string; required?: boolean; schema?: unknown }[];
  requestBody?: { required?: boolean; content?: Record<string, { schema?: unknown }> };
  responses: Record<string, { content?: Record<string, { schema?: unknown }> }>;
}

export interface Exchange {
  operationId: string;
  method: string;
  path: string;
  status: number;
  body: unknown;
}

const METHODS = ["get", "put", "post", "patch", "delete"];

export function operations(spec: Spec): { method: string; path: string; op: Operation }[] {
  return Object.entries(spec.paths).flatMap(([path, item]) =>
    Object.entries(item).filter(([m]) => METHODS.includes(m)).map(([method, op]) => ({ method, path, op })));
}

export class ContractViolation extends Error {}

/** The part of a Fastify app the checks use. */
export interface Injectable {
  inject(opts: { method: string; url: string; headers: Record<string, string>; payload?: string }): Promise<{
    statusCode: number; headers: Record<string, string | string[] | number | undefined>; body: string; json(): unknown;
  }>;
}

export function contract(spec: Spec) {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats.default(ajv);
  const cache = new Map<unknown, ValidateFunction>();

  /** Inlines local $refs (#/components/schemas/…), so each schema compiles on its own. */
  const resolve = (s: unknown): unknown => {
    if (Array.isArray(s)) return s.map(resolve);
    if (!s || typeof s !== "object") return s;
    const ref = (s as { $ref?: string }).$ref;
    if (ref?.startsWith("#/components/schemas/")) return resolve(spec.components?.schemas?.[ref.slice(21)]);
    return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, resolve(v)]));
  };
  const check = (schema: unknown, value: unknown, where: string) => {
    let fn = cache.get(schema);
    if (!fn) cache.set(schema, (fn = ajv.compile(resolve(schema) as object)));
    if (!fn(value)) throw new ContractViolation(`${where}: ${ajv.errorsText(fn.errors, { dataVar: "body" })}\n${JSON.stringify(value, null, 2).slice(0, 2000)}`);
  };

  const templates = operations(spec).map(({ method, path, op }) => ({
    method, path, op,
    re: new RegExp(`^${path.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[^}]+\}/g, "([^/]+)")}$`),
  }));
  const find = (method: string, path: string) => {
    // Literal segments win over parameters, as in the router (/v1/x/bulk before /v1/x/{id}).
    const hits = templates.filter((t) => t.method === method && t.re.test(path));
    hits.sort((a, b) => (a.path.match(/\{/g)?.length ?? 0) - (b.path.match(/\{/g)?.length ?? 0));
    return hits[0];
  };

  function checkRequest(op: Operation, where: string, headers: Headers, query: URLSearchParams, body: unknown) {
    for (const p of op.parameters ?? []) {
      const value = p.in === "header" ? headers.get(p.name) : p.in === "query" ? query.get(p.name) : undefined;
      if (p.required && p.in !== "path" && value === null) throw new ContractViolation(`${where}: missing required ${p.in} parameter ${p.name}`);
    }
    const media = op.requestBody?.content?.["application/json"];
    if (body === undefined) {
      if (op.requestBody?.required) throw new ContractViolation(`${where}: the request body is required`);
    } else if (!media) {
      throw new ContractViolation(`${where}: the operation takes no JSON body`);
    } else {
      check(media.schema, body, `${where} request`);
    }
  }

  function checkResponse(op: Operation, where: string, status: number, contentType: string | undefined, body: unknown) {
    const res = op.responses[String(status)] ?? op.responses[`${String(status)[0]}XX`] ?? op.responses.default;
    if (!res) throw new ContractViolation(`${where}: status ${status} is not in the spec (${Object.keys(op.responses).join(", ")})\n${JSON.stringify(body)}`);
    if (body === undefined) return;
    const type = contentType?.split(";")[0]?.trim() ?? "";
    const media = res.content?.[type];
    if (!media) throw new ContractViolation(`${where}: ${status} ${type} is not in the spec (${Object.keys(res.content ?? {}).join(", ") || "no content"})`);
    check(media.schema, body, `${where} ${status}`);
  }

  const exchanges: Exchange[] = [];

  /**
   * A fetch for openapi-fetch and hand-written calls. `strict: false` skips the request checks,
   * for tests that send what the spec forbids on purpose; responses are always checked.
   */
  function contractFetch(app: Injectable, opts: { strict?: boolean } = {}) {
    return async (input: Request | string, init?: RequestInit): Promise<Response> => {
      const req = typeof input === "string" ? new Request(input, init) : input;
      const url = new URL(req.url);
      const method = req.method.toLowerCase();
      const hit = find(method, url.pathname);
      if (!hit) throw new ContractViolation(`${req.method} ${url.pathname} is not in the spec`);
      const where = `${hit.op.operationId ?? `${method} ${hit.path}`}`;
      const text = await req.text();
      const body = text ? (JSON.parse(text) as unknown) : undefined;
      if (opts.strict !== false) checkRequest(hit.op, where, req.headers, url.searchParams, body);

      const headers = Object.fromEntries(req.headers.entries());
      const res = await app.inject({ method: req.method, url: url.pathname + url.search, headers, ...(text ? { payload: text } : {}) });
      const resBody = res.body ? res.json() : undefined;
      checkResponse(hit.op, where, res.statusCode, res.headers["content-type"] as string | undefined, resBody);
      exchanges.push({ operationId: where, method, path: url.pathname, status: res.statusCode, body: resBody });

      const out = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out.set(k, Array.isArray(v) ? v.join(", ") : String(v));
      return new Response(res.statusCode === 204 || res.statusCode === 304 ? null : res.body, { status: res.statusCode, headers: out });
    };
  }

  return { contractFetch, exchanges };
}
