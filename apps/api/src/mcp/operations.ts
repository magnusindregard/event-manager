import type { FastifyInstance, RouteOptions } from "fastify";

// The MCP tools are curated /v1 operations (ADR 0016). This registry records every route's
// method, URL and schemas by operationId as the routes are added, so a tool's input schema is
// the route's own schema and a tool call is validated exactly like the HTTP request.

type JsonSchema = Record<string, unknown> & { properties?: Record<string, unknown>; required?: string[] };

export interface Operation {
  operationId: string;
  method: string;
  url: string;
  summary?: string;
  params?: JsonSchema;
  querystring?: JsonSchema;
  body?: JsonSchema;
  headers?: JsonSchema;
}

export type OperationRegistry = Map<string, Operation>;

/** TypeBox schemas carry symbol keys; a JSON round trip leaves the plain JSON Schema. */
const plain = (s: unknown): JsonSchema | undefined => (s ? (JSON.parse(JSON.stringify(s)) as JsonSchema) : undefined);

/** Call before the routes are registered: onRoute sees only routes added after it. */
export function collectOperations(app: FastifyInstance): OperationRegistry {
  const ops: OperationRegistry = new Map();
  app.addHook("onRoute", (route: RouteOptions) => {
    const schema = route.schema as (Record<string, unknown> & { operationId?: string; summary?: string }) | undefined;
    if (!schema?.operationId) return;
    for (const method of [route.method].flat()) {
      if (method === "HEAD") continue;
      ops.set(schema.operationId, {
        operationId: schema.operationId,
        method,
        url: route.url,
        summary: schema.summary,
        params: plain(schema.params),
        querystring: plain(schema.querystring),
        body: plain(schema.body),
        headers: plain(schema.headers),
      });
    }
  });
  return ops;
}
