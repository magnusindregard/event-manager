# 0002 – TypeScript across the stack

**Status:** Accepted · 2026-11-12

## Context

The product has many TypeScript-shaped parts beyond the backend: admin SPA, validator app, Sanity plugin, Node-based connectors, MCP server and a TypeScript SDK. .NET was considered for its fit with Optimizely and Business Central projects.

## Decision

TypeScript for backend, admin, validator, connectors and SDK.

- **Runtime:** Node.js LTS.
- **HTTP framework:** Fastify (or NestJS on Fastify if we want more structure – decide in the first spike).
- **Data access:** Kysely or Drizzle. SQL stays explicit; no ORM that hides conditional updates, locking or transactions (see 0003).
- **Validation and types:** schemas defined once (Zod or TypeBox), used for runtime validation and to generate OpenAPI (see 0007).
- **Monorepo:** pnpm workspaces with Turborepo; shared packages for domain types, API client and UI components.
- **Testing:** Vitest; integration tests against a real Postgres (Testcontainers).

## Consequences

- One set of types shared by API, admin, validator and connectors.
- PHP (Magento) and C# (BC, Optimizely) clients come from generated SDKs, not hand-written code.
- CPU-heavy work (e.g. bulk occurrence generation, large rule re-resolution) must run in the worker, not in request handlers.
