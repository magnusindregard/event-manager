# MVP – event catalog

*Draft, 12 November 2026. Data model: "MVP data model" on the FigJam board. Decisions: [docs/adr](adr/README.md).*

## Goal

A multi-tenant event catalog that client staff use to plan events, recurring occurrences and locations, and that client websites and CMSes read from. It replaces the event-planning part of today's vendors first. Ticketing stays with the current vendor for now, linked per event or occurrence.

Everything is built as the first slice of the full product: same modules, same database, same API conventions. Nothing in the MVP should need rewriting when registration, capacity and ticketing arrive.

## Scope

### In

- **Tenancy and access:** accounts, staff login via the identity provider, roles, audit log.
- **Event catalog:** events with localized display fields, status, timezone, tags, default location and duration.
- **Locations:** venues containing spaces.
- **Series and occurrences:** RRULE-based series, one-off occurrences, Outlook-style edits.
- **Occurrence rules:** conditions plus generic effects (location, tags, external link in the MVP), resolved into effective values.
- **External admission link:** per event, overridable per occurrence, for clients keeping their current ticket vendor.
- **Admin interface** for all of the above.
- **Public read API** for client frontends and CMSes.
- **Database, outbox and worker**, built per ADRs 0003, 0004 and 0008.

### Out, and how the MVP prepares for it

| Out of scope | Prepared by |
|---|---|
| RSVP / registration | `admissionMode` enum already exists; `registration` added later as a value |
| Offers, prices | Rule effects have `targetRef` for per-offer effects; `price` becomes a new effect type |
| Capacity, holds | `capacity` becomes a new effect type; locations are already a venue → space hierarchy for pool scopes |
| Admissions, check-in | Occurrence IDs are stable and never reused, so admissions can reference them |
| Detaching occurrences after sales | `detached` already exists for manual edits; later also set when an occurrence has dependents |
| Webhooks to MA, connectors | Outbox writes domain events from day one; delivery is added on top |
| Rich content | Only display fields here; `externalRefs` links events to CMS documents |

## Data model

Module schemas: `tenancy`, `catalog`, `rules`, `outbox`.

### Event

- `slug` (unique per account), `status`: draft, published, cancelled, archived. Only published and cancelled events are visible in the public API, so frontends can show "cancelled".
- Localized display fields in `event_translation`: title, short description, image URL and alt text. Locales are configured per account (e.g. nb, en); reads fall back to the account's default locale.
- `timezone` (defaults to the account's), `defaultLocationId`, `defaultDurationMin`.
- `admissionMode`: `none` or `external` in the MVP. `externalUrl` holds the link to the current ticket vendor.
- `externalRefs`: JSON map, e.g. `{ "sanity": "event-123" }`.
- Tags from account-defined vocabularies (category, audience, language…).
- `version` for optimistic concurrency (ETags in the admin API).

### Location

- `kind`: venue or space; `parentId` makes spaces belong to a venue (MUNCH: building → floor/room).
- Name, address, geo point. Localized names can be added later in the same way as events.

### Series

- `rrule` (RFC 5545), `dtstartLocal` in local wall time, `durationMin`, `timezone`.
- Occurrences are **materialized** as rows. Open-ended series are generated to a horizon (`generatedUntil`, default 18 months ahead) and extended nightly by the worker.
- DST-safe: generation happens in local time, then converted to UTC.

### Occurrence

- `startUtc`, `endUtc` (`timestamptz`), `status`: scheduled or cancelled.
- `recurrenceIdLocal`: the original slot in the series, as in iCalendar RECURRENCE-ID. Regeneration matches existing occurrences on this key, so edits and cancellations survive changes to the rule.
- `detached`: set when an occurrence is edited by hand. Regeneration never moves or deletes a detached occurrence; it reports it as a conflict instead.
- Overrides: `locationOverrideId`, `externalUrlOverride`. Null means inherit.

Outlook semantics for series edits:

| Action | Effect |
|---|---|
| Edit this occurrence | Override fields, set `detached` |
| Cancel this occurrence | `status = cancelled`; kept, so frontends can show it |
| Delete this occurrence | Removed and its slot excluded from the series (EXDATE) |
| Edit this and following | Series split: old series gets UNTIL, new series starts at this slot |
| Edit entire series | Rule regenerated; detached occurrences kept and flagged if they no longer match |
| Add an extra occurrence | One-off occurrence on the event, no series |

### Occurrence rules

- Conditions: name, priority, date range, weekdays, start-time window in event-local time, active flag.
- Effects are **generic**: `rule_effect(effectType, targetRef, value)`, validated by an effect-type handler. MVP effect types:
  - `location` – e.g. "after 18:00 in summer → Rooftop"
  - `tags` – e.g. "Wednesdays → late opening"
  - `externalUrl` – e.g. a different ticket link for evening slots
- Later effect types (`capacity`, `price` with `targetRef` = offer) plug into the same registry, resolver and UI.

### Resolution and effective values

Per occurrence and per field: **occurrence override → highest-priority matching rule → event default**.

The worker materializes the result into `effective_value(occurrenceId, field, value, source, ruleId)` whenever an event, series, occurrence or rule changes. The public API reads only effective values, never evaluates rules. The admin shows the source of every value ("default", "rule: Summer evening", "override").

### Outbox

Every change writes domain events in the same transaction: `event.published`, `event.changed`, `event.cancelled`, `occurrence.created`, `occurrence.changed`, `occurrence.cancelled`, `location.changed`. In the MVP they are consumed internally (resolver, cache purge); webhook delivery is a stretch goal.

## Admin interface

React SPA on the core API (ADR 0006). Norwegian and English UI.

- **Sign-in and account:** SSO through the IdP; account settings for timezone, locales and tag vocabularies.
- **Roles in the MVP:** owner (users and settings) and editor (all content). The role model is the full one from ADR 0005, with only two roles enabled.
- **Locations:** venue and space tree; create, edit, archive.
- **Events:** list with search and filters (status, tag, location, date); editor with localized fields, tags, defaults, external link, CMS reference; publish, unpublish, cancel.
- **Schedule** for an event:
  - Recurrence editor (rrule.js): repeat pattern, end by date or count, with preview of the generated dates.
  - Occurrence list and calendar view, with per-occurrence edit, cancel, delete, and an indicator for detached and overridden values.
  - Occurrence filter (date range, weekdays, time window, location, status) with bulk actions: "override these" or "save as rule".
  - Rule editor with live preview: number of matched occurrences, values that would change, conflicts with equal-priority rules.
- **Audit log** per event: who changed what, when.

## Public read API

`/public/v1`, read-only, cached at the edge (ADR 0007).

| Endpoint | Use |
|---|---|
| `GET /occurrences?from&to&event&location&tag&status&locale&cursor` | Calendars and "what's on" listings; each item embeds an event summary |
| `GET /events?from&to&location&tag&locale&cursor` | Event listings |
| `GET /events/{idOrSlug}?occurrencesFrom&occurrencesTo&locale` | Event page with its occurrences in a window |
| `GET /locations` | Venue and space tree |
| `GET /events/{idOrSlug}.ics` | Calendar subscription (stretch) |

- **Auth:** a publishable key per account identifies the tenant and sets rate limits. A secret preview token lets CMS previews read draft events.
- **Times** as UTC ISO 8601 plus the event's IANA timezone; consumers format display times.
- **Localization:** `locale` parameter, falling back to the account default; the response states which locale was used.
- **Stable shape for expansion:** every occurrence has an `admission` object, today `{ "mode": "external", "url": "…" }` or `{ "mode": "none" }`. Later modes and an `availability` object are added without changing existing fields.
- **Caching:** `Cache-Control` with short `s-maxage`, ETags; purge on outbox events.
- **OpenAPI** spec published; TypeScript SDK generated.

## Architecture for the MVP

Per the ADRs, scaled down:

```
apps/
  api/          core API (/v1) – admin and future integrations
  public-api/   /public/v1 – separate entrypoint, same codebase
  worker/       outbox, rule resolution, series horizon, cache purge
  admin/        React SPA
packages/
  domain/       module code: tenancy, catalog, rules
  db/           migrations, RLS policies, query builder setup
  schemas/      shared request/response schemas → OpenAPI
  sdk/          generated TypeScript client
```

- One Postgres database, module schemas, row-level security from day one.
- No Redis in the MVP; edge caching covers the public API.
- Deployed to Azure Norway East (ADR 0009, still proposed).

## Milestones

1. **Foundation:** monorepo, CI, migrations, RLS, IdP sign-in, accounts and roles, audit log, deploy pipeline.
2. **Catalog:** locations, events with one-off occurrences, admin editors, public API for events and occurrences.
3. **Series:** recurrence generation and horizon, Outlook-style edits, regeneration with conflict reporting, recurrence editor.
4. **Rules:** rule engine with the three MVP effect types, resolver and effective values, filter, bulk edit and rule editor with preview.
5. **Pilot:** one client's website or CMS reading from the public API (MUNCH's Sanity-based "what's on" calendar is a natural candidate), with real events loaded.

## Acceptance scenarios

- A guided tour every Monday, Wednesday and Friday at 14:00 for 8 weeks; one occurrence cancelled, one moved to another space. Changing the series to 15:00 moves all other occurrences and leaves the moved one in place, flagged.
- A rule "1 June–31 August, start ≥ 18:00 → location: Rooftop, tag: late opening" applies to all matching occurrences, including ones added later by extending the series.
- An open-ended weekly series always has occurrences 18 months ahead.
- A series crossing the DST change keeps its local start time.
- A client website lists the next 30 days of occurrences in Norwegian and English, with each occurrence's effective location and ticket link.
- A second tenant cannot see any data from the first, verified by tests on every table.

## Open questions

1. Series horizon: is 18 months right, or should it be configurable per account?
2. Locales: are nb and en enough to start, or do we need nn or others?
3. Pilot client, and whether a Sanity plugin is part of the MVP or the step after.
4. Should the public API be fully open (no key) for clients that want that, with rate limits only?
5. Should rules also be allowed at account level (across events), e.g. "all events in Gallery 3 during renovation → Gallery 4"?
6. **Admin UI component library.** *Resolved: MUI + MUI X Community, see [ADR 0013](adr/0013-admin-ui-library.md).* The admin should be built on a well-defined, expansive component library rather than assembled from separate components, so that later modules (offers, price grid, capacity, registration forms, check-in dashboards) reuse the same building blocks. To decide before milestone 1:
   - **Candidates:** MUI with MUI X, Ant Design, Mantine, Fluent UI v9, React Aria Components / React Spectrum. shadcn/ui is an option only if we accept owning the components ourselves.
   - **Must cover:** data grid with inline editing and bulk selection (price grid, occurrence lists); date, time and date-range pickers that handle timezones; calendar view; tree view (venues and spaces); form building blocks with validation; dialogs, drawers, notifications.
   - **Criteria:** WCAG 2.1 AA, Norwegian (nb) localization, TypeScript types, theming, long-term maintenance and release cadence, and which features sit behind commercial licences.
   - This also settles the grid choice left open in ADR 0006 (AG Grid or TanStack Table). If the library has a grid that covers the price grid, use it.
   - Record the decision as a new ADR.
