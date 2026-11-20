# Event manager

Event management, registration (RSVP) and ticketing platform: events and recurring occurrences, capacity and holds, admissions with QR check-in, and integrations with clients' existing ecom, POS, CMS and marketing automation.

- Roadmap: epics in [issues](https://github.com/magnusindregard/event-manager/issues?q=label%3Aepic)
- MVP scope: [docs/mvp.md](docs/mvp.md)
- Registration (guest invitations and RSVP), in progress: [docs/registration.md](docs/registration.md)
- Ticketing (offers, prices, sales channels and reservations), in progress: [docs/ticketing.md](docs/ticketing.md)
- Backlog (unscheduled features): [docs/backlog.md](docs/backlog.md)
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
pnpm dev              # api :3000, public-api :3001, attendee :3020, worker, admin :5173 (sign in with the email above)
```

Locally the admin signs dev tokens (`VITE_AUTH_MODE=dev`); in Azure it uses Entra External ID.
The worker uses a fake identity directory and mailer unless `IDENTITY_DIRECTORY=graph` and `MAILER=postmark`
are set (`apps/worker/src/config.ts`), so local invitations never create Entra users or send email.

Try the public API: create a publishable key in the admin (*Settings* → *API keys*), then

```bash
curl "http://localhost:3001/public/v1/occurrences?key=pk_…&locale=en"
```

| Public endpoint | |
|---|---|
| `GET /public/v1/occurrences` | Occurrences in start order with event, effective location, tags, `admission` (external link, or the hosted registration page) and `availability` for registration events. Filters: `from`, `to`, `event`, `location`, `tag`, `status`, `locale`, `cursor` |
| `GET /public/v1/events` | Published and cancelled events |
| `GET /public/v1/events/{idOrSlug}` | One event with its occurrences in a window |
| `GET /public/v1/locations` | Venues with their spaces |

The publishable key goes in `?key=` (the edge cache keys on the query string); a preview key goes in
`Authorization: Bearer prv_…`, also returns drafts and is never cached. `createPublicClient` in
`@event-manager/sdk` does this for you.

| Command | |
|---|---|
| `pnpm test` | Unit and integration tests (Testcontainers starts Postgres; Docker must run) |
| `pnpm lint` / `pnpm typecheck` | ESLint incl. module boundaries (ADR 0001) / TypeScript |
| `pnpm --filter @event-manager/sdk generate` | Regenerate OpenAPI and the TypeScript SDK after API changes |

## Layout

```
apps/api          core API (/v1), Fastify
apps/public-api   /public/v1, read-only, edge-cached
apps/attendee     hosted attendee pages (/r, /i, /m, /t) and the attendee API (/attendee/v1)
apps/worker       graphile-worker: outbox dispatch, invitation provisioning, rule resolution, series horizon, registration emails, retention, reservation sweeper
apps/admin        React + shadcn/ui admin
packages/db       Kysely, migrations, roles and RLS, withTenant
packages/domain   modules: tenancy, catalog, rules, inventory, offers, registration, sales, admission, outbox
packages/schemas  TypeBox schemas → OpenAPI
packages/sdk      generated TypeScript client
infra/            Bicep
```
