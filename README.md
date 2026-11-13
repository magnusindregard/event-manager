# Event manager

Event management, registration (RSVP) and ticketing platform: events and recurring occurrences, capacity and holds, admissions with QR check-in, and integrations with clients' existing ecom, POS, CMS and marketing automation.

- Roadmap: epics in [issues](https://github.com/magnusindregard/event-manager/issues?q=label%3Aepic)
- MVP scope: [docs/mvp.md](docs/mvp.md)
- Architecture decisions: [docs/adr](docs/adr/README.md)
- Implementation plan: [docs/implementation-plan.md](docs/implementation-plan.md)
- Azure setup: [infra/README.md](infra/README.md)

## Local development

Requires Node 22 (`.nvmrc`), pnpm 10 and Docker.

```bash
pnpm install
cp .env.example .env
pnpm db:up            # Postgres 16 with local roles (docker compose)
pnpm db:migrate
pnpm create-account --slug demo --name "Demo Museum" --owner-email you@example.com
pnpm dev              # api :3000, worker, admin :5173 (sign in with the email above)
```

Locally the admin signs dev tokens (`VITE_AUTH_MODE=dev`); in Azure it uses Entra External ID.

| Command | |
|---|---|
| `pnpm test` | Unit and integration tests (Testcontainers starts Postgres; Docker must run) |
| `pnpm lint` / `pnpm typecheck` | ESLint incl. module boundaries (ADR 0001) / TypeScript |
| `pnpm --filter @event-manager/sdk generate` | Regenerate OpenAPI and the TypeScript SDK after API changes |

## Layout

```
apps/api          core API (/v1), Fastify
apps/public-api   /public/v1, read-only (milestone 2)
apps/worker       graphile-worker: outbox dispatch, later resolver and series horizon
apps/admin        React + MUI admin
packages/db       Kysely, migrations, roles and RLS, withTenant
packages/domain   modules: tenancy, outbox (catalog and rules follow)
packages/schemas  TypeBox schemas → OpenAPI
packages/sdk      generated TypeScript client
infra/            Bicep
```
