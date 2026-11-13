# 0011 – Backend stack: Fastify, Kysely, TypeBox, graphile-worker

**Status:** Accepted · 2026-11-13 · Settles the options left open in [0002](0002-typescript.md) and [0008](0008-events-and-webhooks.md)

## Decision

- **HTTP:** Fastify 5 without NestJS. Module boundaries are enforced by lint rules (0001), so a DI framework adds little.
- **Schemas:** TypeBox (`typebox` 1.x) in `packages/schemas`. Fastify validates with them natively (`@fastify/type-provider-typebox`), and `@fastify/swagger` generates OpenAPI 3.1 from the same definitions. The TypeScript SDK is generated from that document with `openapi-typescript` + `openapi-fetch`.
- **Data access:** Kysely. SQL stays explicit, and transactions are first-class, which `withTenant` relies on to set `app.tenant_id` per transaction (0004).
- **Migrations:** Kysely `Migrator` with migrations written as raw SQL, so RLS policies, roles and functions are plain Postgres. Types are hand-written in `packages/db/src/types.ts` until `kysely-codegen` runs in CI.
- **Queue:** graphile-worker. The outbox insert trigger enqueues an `outbox.dispatch` job in the same transaction, carrying the tenant id. This replaces a cross-tenant "claim batch" query: the dispatcher runs under RLS like everything else, and there is no polling.
- **Runtime:** Node.js 22 LTS. graphile-worker is pinned to 0.17.x and Testcontainers to 11.x until local and CI Node reach ≥ 22.18 (both newer lines need it).

## Database roles

| Role | Used by | Notes |
|---|---|---|
| migrator (server admin) | migrations | Owns all schemas |
| `em_app` | api, public-api, worker | NOLOGIN group; cannot bypass RLS; login principals (managed identities) are members |
| `em_definer` | owner of `SECURITY DEFINER` functions | Reads across tenants only inside `tenancy.login`, `tenancy.my_accounts` and `tenancy.resolve_api_key`, through explicit `TO em_definer` policies, because Azure does not grant `BYPASSRLS` |

Every tenant table uses `ENABLE` + `FORCE ROW LEVEL SECURITY` through `platform.enable_tenant_rls()`. `packages/db/test/rls.test.ts` finds every table with `tenant_id` in the catalog and fails if one lacks RLS or a cross-tenant fixture.

## Consequences

- One schema definition drives validation, OpenAPI, the SDK and the admin's types.
- Schemas are inlined rather than `$ref`-named, so the OpenAPI document has few named components. Revisit when the SDK for PHP and C# is generated.
- Moving to Azure Service Bus later only replaces the trigger's `add_job` call and the worker's task runner.
