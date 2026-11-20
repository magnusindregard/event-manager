// Corrections to the OpenAPI documents @fastify/swagger generates, so the spec says what the API
// does (ADR 0007). The contract tests (packages/contract) check responses against these documents.

interface Operation {
  operationId?: string;
  parameters?: { in?: string; name?: string; required?: boolean }[];
  responses?: Record<string, { content?: Record<string, unknown> }>;
}
interface Document {
  paths?: Record<string, Record<string, unknown> | undefined>;
}

const operations = (doc: Document): Operation[] =>
  Object.values(doc.paths ?? {}).flatMap((item) => Object.values(item ?? {}).filter((op): op is Operation => typeof op === "object" && op !== null));

/**
 * Errors are sent as application/problem+json (RFC 9457), which @fastify/swagger cannot express
 * for a shared schema, and it inlines the Problem schema into every error response. Error
 * responses whose schema is Problem get one shared components.schemas.Problem, listed under
 * application/problem+json beside the generated application/json, so the change is additive
 * for generated clients.
 */
export function problemMediaType<T extends Document>(doc: T, problem: object): T {
  const inline = JSON.stringify(problem);
  const ref = { $ref: "#/components/schemas/Problem" };
  let used = false;
  for (const op of operations(doc)) {
    for (const [status, res] of Object.entries(op.responses ?? {})) {
      // Routes that produce CSV get their errors listed as text/csv too. That media type stays,
      // so the change is additive, but the problem types are what the API sends.
      const media = Object.values(res.content ?? {}) as { schema?: unknown }[];
      if (Number(status) < 400 || !media.length || media.some((m) => JSON.stringify(m.schema) !== inline)) continue;
      res.content = {
        ...Object.fromEntries(Object.keys(res.content!).map((type) => [type, { schema: ref }])),
        "application/json": { schema: ref },
        "application/problem+json": { schema: ref },
      };
      used = true;
    }
  }
  if (used) {
    const d = doc as Document & { components?: { schemas?: Record<string, unknown> } };
    d.components = { ...d.components, schemas: { ...d.components?.schemas, Problem: JSON.parse(inline) as unknown } };
  }
  return doc;
}

/**
 * Marks a header as required on the given operations. The routes keep it optional in their
 * validation schema so a missing header gets its own problem (428 idempotency_key_required)
 * rather than a generic 400.
 */
export function requireHeader<T extends Document>(doc: T, name: string, operationIds: ReadonlySet<string>): T {
  for (const op of operations(doc)) {
    if (!op.operationId || !operationIds.has(op.operationId)) continue;
    for (const p of op.parameters ?? []) if (p.in === "header" && p.name === name) p.required = true;
  }
  return doc;
}
