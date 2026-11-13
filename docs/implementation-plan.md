# MVP implementation plan – event catalog on Azure

*13 November 2026. Decisions recorded in ADRs 0011–0014. Milestone 1 (foundation) is implemented on `feat/m1-foundation`.*

## Context

The product is specced in `magnusindregard/event-manager` (`docs/adr/0001–0010`, `docs/mvp.md`, epics #1–#17). The MVP is a multi-tenant event catalog: staff plan events, locations, RRULE series and occurrence rules in an admin SPA; client websites and CMSes read a cached public API. Ticketing stays with the current vendor through an external link. Everything is the first slice of the full product, so module boundaries, RLS, outbox and API conventions must be real from day one. 

## Decisions locked for the MVP (record as ADRs in milestone 1)

| Topic | Decision | ADR |
|---|---|---|
| HTTP / data / schemas | Fastify + Kysely + TypeBox (Fastify's native type provider; `@fastify/swagger` → OpenAPI 3.1) | 0011 (resolves 0002 options) |
| Staff IdP | Microsoft Entra External ID (external tenant), OIDC federation to client Entra ID / Google; MSAL.js in admin, `jose` JWKS validation in API | 0012 (resolves 0005 open item) |
| Admin UI | MUI core + MUI X **Community (MIT only)**, FullCalendar standard (MIT), rrule.js; no commercial licences | 0013 (resolves MVP Q6) |
| Hosting / IaC | 0009 → Accepted; **Bicep**; GitHub Actions with OIDC federated credentials to Azure | 0009 status + 0014 |
| Job queue | graphile-worker (LISTEN/NOTIFY, `jobKey` dedupe, built-in crontab for nightly horizon) | in 0011 |
| Migrations | Kysely `Migrator` with raw `sql` (RLS policies stay plain SQL); `kysely-codegen` for DB types | in 0011 |

MUI free limits accepted: no DateRangePicker (two pickers), single grid filter (the custom occurrence filter replaces it), no pinning/tree-data. The phase-2 price grid revisits this (AG Grid Community or TanStack Table as free options).

Assumed answers to MVP open questions (change if wrong): horizon 18 months as an account setting with that default; locales nb + en (the schema allows any BCP 47); Sanity plugin after the MVP; the public API always requires a publishable key; no account-level rules.

## Repository layout (per mvp.md)

```
apps/api          Fastify, /v1 (admin + future integrations)
apps/public-api   Fastify, /public/v1, read-only
apps/worker       graphile-worker: outbox dispatch, resolver, horizon, cache purge
apps/admin        Vite + React + MUI
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

Vite + React 18 + TypeScript, MUI + MUI X Community, TanStack Query + generated SDK, React Router, react-hook-form + TypeBox resolver, i18next (nb, en) with MUI `nbNO` locale packs, MSAL React. Screens: sign-in/account switcher; account settings (timezone, locales, tag vocabularies, API keys, users – owner only); locations tree (RichTreeView + drawer form); events list (DataGrid server mode + filter bar); event editor (locale tabs, tags, defaults, external link, CMS refs, publish/unpublish/cancel, ETag conflict dialog); schedule tab (recurrence editor with rrule.js and a preview list from the dry-run; occurrence DataGrid with checkbox selection + FullCalendar week/month; source chips "default / rule: X / override", detached + conflict badges); occurrence filter component → bulk override / save as rule; rules tab with live preview; audit tab. Accessibility: eslint-plugin-jsx-a11y + axe in Playwright.

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

1. **Foundation** (#1): clone repo, monorepo scaffold, ADRs 0011–0014, db package with roles/RLS/`withTenant`, RLS test generator, tenancy module (accounts, users, memberships, audit), Entra sign-in end to end, admin shell with i18n + account switcher, outbox + worker skeleton, Bicep for staging, CI/CD, OTel. *Exit:* staff signs in on staging, edits account settings, sees the audit entry.
2. **Catalog** (#2, #10): locations, events + translations + tags, one-off occurrences, inline resolver (defaults/overrides only), `/v1` CRUD with ETags, public API (`/events`, `/events/{idOrSlug}`, `/occurrences`, `/locations`), publishable/preview keys, Front Door caching, SDK generation. *Exit:* acceptance "next 30 days in nb and en" with one-off occurrences.
3. **Series** (#3): recurrence module, regeneration + conflicts, Outlook edits, horizon cron, recurrence editor + dry-run preview, calendar view. *Exit:* tour, DST and 18-month acceptance scenarios pass as integration tests.
4. **Rules** (#5): rules schema, effect registry, resolver in worker, effective values in public API, occurrence filter, bulk override, rule editor with preview. *Exit:* rooftop/late-opening scenario passes, including occurrences added by extending the series.
5. **Pilot:** prod environment, load real events for the pilot client (MUNCH Sanity "what's on" is the candidate), `.ics` + webhook delivery as stretch goals.

## Verification

- `pnpm test`: unit tests for recurrence (DST cases with `Europe/Oslo` around the last Sunday in March and October), regeneration diff, rule matching/priority, resolver.
- Integration (Testcontainers): every acceptance scenario in mvp.md as a named test in `packages/domain/test/acceptance/`; RLS generator test over all tenant tables; outbox atomicity (rolled-back transaction leaves no event).
- API: `fastify.inject` tests for ETag 412, problem details, cursor pagination, the public API hiding drafts and unresolved occurrences, and the preview token returning `no-store`.
- E2E: Playwright against a local stack (docker-compose + a mocked OIDC issuer) covering sign-in, create event, series, rule preview, public API output; axe checks.
- Staging: smoke script calling `/public/v1/occurrences?key=…` through Front Door twice (expect cache HIT on second, distinct responses for two tenants' keys), worker health, App Insights traces linking api → worker.
