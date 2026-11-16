# MVP implementation plan – event catalog on Azure

*13 November 2026, updated 16 November. Decisions recorded in ADRs 0011–0015. Milestone 1 (foundation) is implemented on `feat/m1-foundation`; milestone 2 (catalog) on `feat/m2-catalog`, with the staging stand-up still to do; milestone 3 (series) on `feat/m3-series`; milestone 4 (rules) on the same branch.*

## Context

The product is specced in `magnusindregard/event-manager` (`docs/adr/0001–0010`, `docs/mvp.md`, epics #1–#17). The MVP is a multi-tenant event catalog: staff plan events, locations, RRULE series and occurrence rules in an admin SPA; client websites and CMSes read a cached public API. Ticketing stays with the current vendor through an external link. Everything is the first slice of the full product, so module boundaries, RLS, outbox and API conventions must be real from day one. 

## Decisions locked for the MVP (record as ADRs in milestone 1)

| Topic | Decision | ADR |
|---|---|---|
| HTTP / data / schemas | Fastify + Kysely + TypeBox (Fastify's native type provider; `@fastify/swagger` → OpenAPI 3.1) | 0011 (resolves 0002 options) |
| Staff IdP | Microsoft Entra External ID (external tenant), OIDC federation to client Entra ID / Google; MSAL.js in admin, `jose` JWKS validation in API | 0012 (resolves 0005 open item) |
| Admin UI | shadcn/ui (Radix + Tailwind v4), TanStack Table v9, react-day-picker + `@date-fns/tz`, FullCalendar standard (MIT), rrule.js; permissive licences only | 0015 (supersedes 0013, resolves MVP Q6) |
| Hosting / IaC | 0009 → Accepted; **Bicep**; GitHub Actions with OIDC federated credentials to Azure | 0009 status + 0014 |
| Job queue | graphile-worker (LISTEN/NOTIFY, `jobKey` dedupe, built-in crontab for nightly horizon) | in 0011 |
| Migrations | Kysely `Migrator` with raw `sql` (RLS policies stay plain SQL); `kysely-codegen` for DB types | in 0011 |

We own the components (shadcn copies them in), so inline cell editing, bulk selection, the zoned date-time field and the locations tree are ours to build in milestone 2. TanStack Table also covers the phase-2 price grid (pinning, cell-range selection).

Assumed answers to MVP open questions (change if wrong): horizon 18 months as an account setting with that default; locales nb + en (the schema allows any BCP 47); Sanity plugin after the MVP; the public API always requires a publishable key; no account-level rules.

## Repository layout (per mvp.md)

```
apps/api          Fastify, /v1 (admin + future integrations)
apps/public-api   Fastify, /public/v1, read-only
apps/worker       graphile-worker: outbox dispatch, resolver, horizon, cache purge
apps/admin        Vite + React + shadcn/ui
packages/domain   modules: tenancy/, catalog/, rules/, outbox/ – each exports index.ts only
packages/db       Kysely instance, migrations, RLS helpers, codegen types, test fixtures
packages/schemas  TypeBox schemas shared by API + admin → OpenAPI
packages/sdk      generated TS client (openapi-typescript + openapi-fetch)
infra/            Bicep modules + per-env params
```

pnpm workspaces + Turborepo; ESLint with `eslint-plugin-boundaries` (or dependency-cruiser) to enforce: apps → module `index.ts` only, no module importing another module's internals or tables (ADR 0001). Vitest + Testcontainers Postgres 16.

## Cross-cutting design

**Tenancy / RLS (ADR 0004)**
- Roles: migrator (owns schemas), `em_app` (NOBYPASSRLS, not an owner), `em_definer` (owns the few `SECURITY DEFINER` functions that read across tenants). See ADR 0011.
- Every tenant table has `tenant_id uuid not null`, `ENABLE` + `FORCE ROW LEVEL SECURITY`, policy `tenant_id = current_setting('app.tenant_id')::uuid`.
- `packages/db` exposes `withTenant(tenantId, fn)`: opens a transaction, runs `select set_config('app.tenant_id', $1, true)`, passes the `Transaction` to `fn`. Request handlers only get DB access through this.
- Outbox dispatch needs no cross-tenant query: the outbox insert trigger enqueues a graphile-worker job carrying the tenant id, and the job runs `withTenant` (ADR 0011).
- Connection is resolved per tenant through `getDb(tenantId)` (one pool for now), so a tenant can move to its own DB later.
- **RLS test generator:** a test queries `information_schema.columns` for every table with `tenant_id`, seeds two tenants, and asserts tenant B sees 0 rows and cannot insert/update for A. New tables are covered automatically, which meets the "every table" acceptance scenario.

**Identity & authorization (ADR 0005)**
- `tenancy.user(id, idp_issuer, idp_subject, email, name)`, `tenancy.membership(user_id, tenant_id, role, scope_type, scope_id)`. Full role enum from 0005; only `owner` and `editor` are enabled in the MVP.
- Admin sends an Entra access token plus an `Account-Id` header. The API verifies the JWT, looks up the membership, and attaches `ctx = {userId, tenantId, role}`. Permissions live only in our DB.
- `tenancy.audit_log(tenant_id, actor_id, client_id, action, entity_type, entity_id, diff jsonb, at)`, written by a domain helper in the same transaction as the change.
- First-user bootstrap: a CLI command `pnpm admin create-account --owner-email` (run as a Container Apps Job).
- Invitation-only access (ADR 0012, revised after the sign-in test): inviting someone also provisions their Entra identity through Microsoft Graph, as a guest for work accounts or a local one-time-passcode account otherwise, with retries in the worker and an invitation email (Postmark). Until then, identities are created by hand.

**Outbox (ADR 0008)**
- `outbox.event(id, tenant_id, type, subject, data, created_at, dispatched_at)` in CloudEvents shape, types versioned (`occurrence.changed.v1`). Written by `emit(tx, event)` inside the domain transaction.
- The insert trigger enqueues `outbox.dispatch` in the same transaction. The worker fans the event out to internal handlers (resolver, cache purge). Handlers are idempotent on event id (`outbox.handled(handler, event_id)`).

**API conventions (ADR 0007)**
- RFC 9457 problem details with stable `code`; cursor pagination (`(start_utc,id)` keyset, opaque base64 cursor); `ETag` = `version`, `If-Match` required on PATCH/DELETE → 412; `Idempotency-Key` table for retriable POSTs (store response by key+tenant for 24h).
- OpenAPI emitted at build time from both apps → `packages/sdk` generated; contract check in CI with `oasdiff breaking` against `main`.

**Public API caching (important)**
- Azure Front Door does not vary its cache on request headers. The publishable key must therefore be passed as a query parameter (`?key=pk_…`), and Front Door's cache key must include the full query string. Otherwise one tenant's cached response could be served to another tenant.
- `Cache-Control: public, s-maxage=30, stale-while-revalidate=300` + ETag. Preview-token requests (`Authorization: Bearer prv_…`) return `private, no-store` and are bypassed via a Front Door rule.
- Cache purge in the MVP relies on the short TTL. A worker handler calling the Front Door purge API on `event.*` is a stretch goal (purges take minutes and are coarse).
- Rate limiting per key: in-memory token bucket per replica (no Redis in the MVP), plus a Front Door WAF rate-limit rule.

## Data model (packages/db migrations)

- `tenancy`: account (slug, default_timezone, default_locale, locales[], horizon_months), user, membership, audit_log, api_key (publishable/preview, hashed secret), tag_vocabulary, tag.
- `catalog`: location (kind venue|space, parent_id, name, address, geo `point`, archived_at); event (slug unique per tenant, status, timezone, default_location_id, default_duration_min, admission_mode enum `none|external`, external_url, external_refs jsonb, version); event_translation (event_id, locale, title, short_description, image_url, image_alt); event_tag; series (event_id, rrule, dtstart_local `timestamp`, duration_min, timezone, until/count, generated_until, exdates `timestamp[]`, version); occurrence (event_id, series_id null, recurrence_id_local `timestamp` null, start_utc, end_utc `timestamptz`, status, detached, location_override_id, external_url_override, tags_override, resolved_version, version). Unique `(series_id, recurrence_id_local)`. Occurrence IDs are UUIDv7 and never reused.
- `rules`: rule (event_id, name, priority, date_from, date_to, weekdays int[], start_time_from/to `time`, active, version); rule_effect (rule_id, effect_type, target_ref null, value jsonb); effective_value (occurrence_id, field, value jsonb, source enum `default|rule|override`, rule_id) PK `(occurrence_id, field)`.
- `outbox`: event, handled; graphile-worker owns its own `graphile_worker` schema.

## Domain logic (packages/domain)

- **Recurrence (`catalog/recurrence.ts`):** use `rrule` with `tzid`. Expand in local wall time (floating `dtstart_local`), convert each slot to UTC with `@date-fns/tz` (or Temporal polyfill) per occurrence, so 14:00 stays 14:00 across DST. Expand only within `[now-ish, generated_until]`.
- **Regeneration (`catalog/regenerate.ts`):** diff by `recurrence_id_local`. New slots → insert. Removed slots → delete non-detached occurrences, report detached ones as a conflict. Changed time → update non-detached; for detached, keep and flag `conflict=true` if its slot no longer matches. EXDATE slots are skipped. Returns `{created, updated, deleted, conflicts}` for the admin preview (run as a dry-run inside a rolled-back transaction).
- **Outlook edits:** this occurrence = set overrides + `detached`; cancel = status; delete = remove + add to `exdates`; this-and-following = set `UNTIL` on the old series at slot−1 and create a new series from that slot, moving later non-detached occurrences to it (re-keyed); entire series = update rule + regenerate; extra = one-off occurrence without series.
- **Horizon:** graphile-worker crontab job `extend-horizons` (nightly) per tenant for open-ended series → `generated_until = now + horizon_months`.
- **Rules (`rules/`):** effect-type registry `{ type, validate(value, targetRef), field }` with `location`, `tags`, `externalUrl`. `matches(rule, occurrence, eventTz)` checks date range, weekday and start-time window in event-local time. Resolver per occurrence per field: override → highest-priority active matching rule (tie → lower rule id, reported as an equal-priority conflict) → event default. Upsert into `effective_value`, then set `resolved_version = version`.
- **When the resolver runs:** single-occurrence and event edits resolve inline in the same transaction (cheap). Series regeneration and rule changes enqueue `resolve-event` with `jobKey=event:{id}` (coalesced). The public API only returns occurrences where `resolved_version = version`, so readers never see half-resolved values.
- **Rule preview:** a pure function over the event's occurrences giving counts, changed values and equal-priority conflicts. It also powers the bulk filter "save as rule".

## Admin (apps/admin)

Vite + React 19 + TypeScript, shadcn/ui + Tailwind v4 (tokens in `src/index.css`), TanStack Query + generated SDK, React Router, react-hook-form + TypeBox resolver, i18next (nb, en), date-fns `nb` locale for the calendar, MSAL. Screens: sign-in/account switcher; account settings (timezone, locales, tag vocabularies, API keys, users – owner only); locations tree (headless tree + sheet form); events list (`DataTable` server mode + filter bar); event editor (locale tabs, tags, defaults, external link, CMS refs, publish/unpublish/cancel, ETag conflict dialog); schedule tab (recurrence editor with rrule.js and a preview list from the dry-run; occurrence `DataTable` with row selection + FullCalendar week/month; source chips "default / rule: X / override", detached + conflict badges); occurrence filter component → bulk override / save as rule; rules tab with live preview; audit tab. Accessibility: eslint-plugin-jsx-a11y + axe in Playwright.

## Azure (infra/, Bicep, Norway East)

- Resource group per env (`staging`, `prod`). Local dev uses docker-compose Postgres.
- Log Analytics + Application Insights; app code uses `@azure/monitor-opentelemetry`.
- Azure Container Registry; Container Apps Environment (VNet-integrated); apps `api`, `public-api` (ingress internal to Front Door), `worker` (no ingress, min 1); Container Apps Job `migrate` + `admin-cli`.
- PostgreSQL Flexible Server 16, private access in the VNet, zone-redundant HA in prod only, geo-redundant backup; Entra auth for apps via user-assigned managed identity (no DB passwords).
- Key Vault (preview-token pepper, future tenant keys) with managed identity access.
- Admin SPA: Storage static website (or Static Web Apps) behind Front Door.
- Front Door Standard: routes `/v1/*` → api, `/public/v1/*` → public-api (caching on, full query string), `/*` → admin; WAF custom rules incl. rate limit. Move to Premium (managed rule sets, Private Link origins) before personal data arrives in phase 1.
- Entra External ID tenant + app registrations (admin SPA, API scope) are documented manual steps; Bicep does not cover External ID well.

**CI/CD (GitHub Actions):** PR → lint, typecheck, boundary lint, unit + Testcontainers integration tests, OpenAPI breaking-change check, `az bicep build`/what-if. Main → build images (tag = SHA) → push ACR → deploy staging (Bicep, run `migrate` job, update container app revisions, upload admin build) → smoke test → manual approval → prod.

## Milestones (map to mvp.md and epics)

1. **Foundation** (#1): clone repo, monorepo scaffold, ADRs 0011–0014, db package with roles/RLS/`withTenant`, RLS test generator, tenancy module (accounts, users, memberships, audit), Entra sign-in end to end, admin shell with i18n + account switcher, outbox + worker skeleton, Bicep (written, not deployed), CI/CD, OTel. *Exit:* staff signs in **locally with a real Entra External ID token**, edits account settings, sees the audit entry. Paid staging is deferred to save cost; the identity design is the risk that matters at this stage, and it can be tested for free (infra/README.md).
2. **Catalog** (#2, #10): locations, events + translations + tags, one-off occurrences, inline resolver (defaults/overrides only), `/v1` CRUD with ETags, public API (`/events`, `/events/{idOrSlug}`, `/occurrences`, `/locations`), publishable/preview keys, Front Door caching, SDK generation. **Entra provisioning** from the invite flow (ADR 0012), needed before any client staff sign in. **Lean staging** at the end: stand up Azure per the staging runbook, aiming for roughly $15–35/month (API apps scale to zero; the worker scales on queued jobs or runs in-process; free-tier or stop-when-idle Postgres), and verify the cache key separates tenants. *Exit:* acceptance "next 30 days in nb and en" with one-off occurrences, served through staging.
   *Status (16 November):* built and tested locally. The acceptance scenario runs as `apps/public-api/test/public.test.ts`. Still to do: the staging stand-up (`infra/README.md`, steps 0–10). Decisions taken while building:
   - Locations store `lat`/`lng` columns instead of a `point`; easier to validate and serialize.
   - Every reference between tenant tables is a composite foreign key on `(tenant_id, id)`, because foreign key checks bypass RLS.
   - API keys are `pk_<id>_<secret>` and `prv_<id>_<secret>`, with a SHA-256 hash of 32 random bytes. A pepper adds nothing for secrets with that much entropy, so there is none. Key lookups are cached for 60 s per replica, so revocation takes up to a minute.
   - Occurrence audit entries are recorded on the event (`entity_type = event`), so the event's audit tab shows its schedule changes.
   - Cancel and reinstate an occurrence with `PATCH {status}`; one-offs are deleted outright (series occurrences get EXDATE in milestone 3).
   - Staging runs the worker as a sidecar container of the `api` app (scales to zero with it), not in-process. Milestone 3's nightly horizon job needs a Container Apps cron job in staging.
   - Front Door Standard's base fee (~$35) is more than the rest of staging together, so it has a `DEPLOY_FRONT_DOOR` toggle.
3. **Series** (#3): recurrence module, regeneration + conflicts, Outlook edits, horizon cron, recurrence editor + dry-run preview, calendar view. *Exit:* tour, DST and 18-month acceptance scenarios pass as integration tests.
   *Status (16 November):* built and tested locally. The three acceptance scenarios run in `packages/domain/test/acceptance/series.test.ts`; DST and diff unit tests in `packages/domain/test/recurrence.test.ts`. Decisions taken while building:
   - Local wall times (`dtstart_local`, `recurrence_id_local`, `exdates`) are `timestamp` columns read and written as ISO strings (`YYYY-MM-DDTHH:mm:ss`); the pool's type parser stops node-pg from applying the process timezone.
   - Regeneration matches occurrences on the slot key first, then on local date and order within the day, so changing 14:00 to 15:00 moves each occurrence and keeps its ID instead of replacing it. EXDATEs are remapped the same way, so a deleted slot stays deleted.
   - Occurrences that start before now are history: regeneration never moves, deletes or creates them. A new series may still start in the past (imports).
   - A hand edit detaches only when time or overrides actually change; cancelling keeps the occurrence on the series. Conflicts are settled by editing, "keep as is" (`PATCH {conflict: false}`) or "reset to series" (`POST /occurrences/{id}/reattach`).
   - Deleting a series removes its upcoming non-detached occurrences; past and detached ones stay as one-offs.
   - Previews are `?dryRun=true` on the same endpoints (create, edit, split); the plan is computed purely, so nothing is rolled back.
   - Series changes resolve their occurrences inline (chunked, at most 10,000 slots per series) instead of a `resolve-event` job; milestone 4 moves resolution to the worker when rules make it expensive.
   - The horizon job finds due series through the `SECURITY DEFINER` function `catalog.series_due_for_extension` (ids only) and extends each under its tenant. Prod runs it from the worker's crontab (02:00 UTC); staging runs `dist/cli/extend-horizons.js` as the Container Apps cron job `caj-<name>-horizon`.
4. **Rules** (#5): rules schema, effect registry, resolver in worker, effective values in public API, occurrence filter, bulk override, rule editor with preview. *Exit:* rooftop/late-opening scenario passes, including occurrences added by extending the series.
   *Status (16 November):* built and tested locally. The acceptance scenario runs in `packages/domain/test/acceptance/rules.test.ts`; engine unit tests in `packages/domain/test/rules.test.ts`; the worker path in `apps/worker/test/resolver.test.ts`. Decisions taken while building:
   - The `rules` module holds the engine (effect registry, matching, resolution, preview) and the rule tables; `catalog/rules.ts` orchestrates rule changes (validation of referenced locations and tags, audit, outbox, resolution), so the dependency runs catalog → rules only.
   - Conditions match the occurrence's local start in the event's timezone. Dates are inclusive; the time window is `[from, to)` and wraps midnight when `from > to`; weekdays are ISO (1 = Monday).
   - Per field, the highest-priority active matching rule with an effect on that field wins; on equal priority the older rule (lower UUIDv7) wins and the tie is reported in the preview. The `tags` effect adds to and removes from the event's tags (`{ add, remove }`), so a "late opening" rule keeps the event's own tags.
   - Previews are `?dryRun=true` on create, edit and delete. They compare the rules before and after the change over every occurrence of the event, and report matched, changed, overridden (an override keeps a field the rule sets) and equal-priority conflicts.
   - Rule and event-default changes resolve inline for events with up to 2,000 occurrences. Larger events are resolved by the worker: the outbox event says `resolution: "queued"`, the resolver handler queues `rules.resolve_event` with a job key per event, so a burst of edits runs once. Until then the public API keeps serving the previous values. Occurrence and series edits still resolve inline, now with rules.
   - The resolver locks the occurrences it resolves (in id order), so a concurrent edit cannot be overwritten with stale values.
   - `effective_value.rule_id` has no foreign key: after a rule is deleted on a large event, the old values (with that rule id) stay until the worker resolves them.
   - Bulk override is `POST /v1/events/{id}/occurrences/bulk-update` with `[{id, version}]`: all or nothing (412 on any stale version), up to 1,000 occurrences, one audit entry. Overrides detach series occurrences, as a single edit does.
   - The occurrence filter runs in the admin over the loaded occurrences, with a copy of the engine's matcher (`apps/admin/src/lib/rules.ts`), so "save as rule" matches exactly what the filter shows; the server preview confirms the count. There is no server-side filter on `/v1` occurrences yet.
   - Effect input has no `targetRef` (no MVP type targets anything); responses carry `targetRef: null` so price and capacity per offer can add it without a breaking change.
   - Fixed in passing: the worker's crontab used the task name `series.extend_horizons`, which graphile-worker rejects (no dots in crontab task names), so the worker could not start with the default crontab. The task is now `series:extend_horizons`, and a test parses the crontab.
5. **Pilot:** prod environment, load real events for the pilot client (MUNCH Sanity "what's on" is the candidate), `.ics` + webhook delivery as stretch goals.
   *Status (16 November):* no pilot client yet, so this milestone put the product online for our own testing first: the `staging` environment runs lean in a personal Azure subscription, without Front Door (about $25/month), with the admin on the storage static website and CORS to the API. A `seed-demo` CLI loads a demo account. Prod, real events, `.ics` and webhooks wait for a client. Setup and use: `infra/README.md`, "Test environment (milestone 5)". Decisions taken:
   - One deploy script (`scripts/deploy-env.sh`) for the workflow and for hand deploys; the workflow only builds images and calls it.
   - Sign-in reuses the External ID apps from the local test, with the online admin added as a redirect URI.
   - Test databases are migrated by a non-superuser that creates the roles itself, like Azure's Entra administrator; the first deploy failed on exactly that difference.

## Verification

- `pnpm test`: unit tests for recurrence (DST cases with `Europe/Oslo` around the last Sunday in March and October), regeneration diff, rule matching/priority, resolver.
- Integration (Testcontainers): every acceptance scenario in mvp.md as a named test in `packages/domain/test/acceptance/`; RLS generator test over all tenant tables; outbox atomicity (rolled-back transaction leaves no event).
- API: `fastify.inject` tests for ETag 412, problem details, cursor pagination, the public API hiding drafts and unresolved occurrences, and the preview token returning `no-store`.
- E2E: Playwright against a local stack (docker-compose + a mocked OIDC issuer) covering sign-in, create event, series, rule preview, public API output; axe checks.
- Staging: smoke script calling `/public/v1/occurrences?key=…` through Front Door twice (expect cache HIT on second, distinct responses for two tenants' keys), worker health, App Insights traces linking api → worker.
