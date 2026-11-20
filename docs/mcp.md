# MCP server – events through an agent

*20 November 2026. Issue #106. Decisions: [ADR 0016](adr/0016-mcp-in-core-api.md), [ADR 0007](adr/0007-api-contract.md).*

Staff can ask an agent (Claude, or any MCP client) to find events, explain how they are set up, and create and configure them. The agent acts as the signed-in staff member, with their role, through the core API's own operations. Companion skills tell the agent which questions to ask and how to review a change before it is saved.

## Connecting

The server is at **`/mcp` on the core API** (`http://localhost:3000/mcp` locally). It speaks Streamable HTTP, statelessly: every request is a `POST` with a bearer token.

| | |
|---|---|
| Token | The same staff access token the admin uses (Entra External ID; locally a dev token) |
| Account | `Account-Id` header, else `?accountId=<uuid>` on the URL, else the user's only account |
| Sign-in discovery | `401` with `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/mcp"` (RFC 9728), naming the staff IdP |

### Locally, with Claude Code

Mint a dev token for your user (the email you created the account with) and add the server:

```bash
TOKEN=$(node -e 'import("jose").then(async ({SignJWT})=>console.log(await new SignJWT({email:process.argv[1]}).setProtectedHeader({alg:"HS256"}).setIssuer("urn:event-manager:dev").setSubject(process.argv[1]).setExpirationTime("8h").sign(new TextEncoder().encode("local-dev-secret-change-me"))))' you@example.com)
```

```bash
claude mcp add --transport http event-manager http://localhost:3000/mcp --header "Authorization: Bearer $TOKEN"
```

Run it from `apps/api` (where `jose` is installed). Add `--header "Account-Id: <uuid>"` if you belong to several accounts. To use the companion skills as Claude Code skills as well as prompts, copy or link `apps/api/skills/*` into `.claude/skills/`.

### In Azure

MCP clients sign in through Entra External ID, which has no dynamic client registration: register the client (for example Claude) as an app in the external tenant with its redirect URI, grant it the API scope, and give the client its client ID. Set on the API:

| Setting | |
|---|---|
| `MCP_OAUTH_SCOPES` | The API scope clients ask for, e.g. `api://em-api-staging/access` |
| `PUBLIC_URL` | The API's public base URL, so the metadata names `https://…/mcp` behind the ingress |

The authorization server in the metadata is `OIDC_ISSUER`. The Bicep templates do not set the two settings yet; without them the metadata has no scopes and derives the URL from the request.

## Tools

Every tool except `whoami` and `get_event_configuration` is one `/v1` operation: its input is the route's parameters, query and body as one object, and it is validated, authorized and audited as that request. Results are the response body (`structuredContent`, and the same JSON as text).

| Tool | Operation | |
|---|---|---|
| `whoami` | | The user, their accounts, roles and permissions, and the active account |
| `get_account` | `getAccount` | Default timezone and locale, the account's locales |
| `list_events` | `listEvents` | Search by `q`, status, tag, location, time window |
| `get_event` | `getEvent` | |
| `get_event_configuration` | several | The event, its series, occurrences from `from` (default now, at most `occurrenceLimit`), offers and rules |
| `list_occurrences` · `list_series` · `list_offers` · `list_rules` | `listEvent…` | |
| `list_locations` · `list_tags` · `list_user_groups` · `list_vat_classes` | | Choices for the event's fields |
| `create_event` | `createEvent` | Always a draft |
| `update_event` | `updateEvent` | |
| `publish_event` · `unpublish_event` · `cancel_event` | | Change what the public sees |
| `create_series` · `update_series` | | `dryRun: true` previews the dates |
| `create_occurrence` · `update_occurrence` | | |
| `create_offer` · `update_offer` | | Ticket types |
| `create_rule` · `update_rule` | | `dryRun: true` previews the affected dates |
| `create_location` | `createLocation` | |

Conventions:

- **Ids** are named for what they are (`eventId`, `seriesId`, `occurrenceId`, `offerId`, `ruleId`), not `id`.
- **Changes take `version`**, the resource's version from the latest read, instead of `If-Match`. A stale version gives `version_conflict` with `details.currentVersion`.
- **Creates take an optional `idempotencyKey`**: a retried call with the same key and arguments returns the first result instead of a duplicate.
- Annotations: reads are `readOnlyHint`. Every update and status change is `destructiveHint` (it may overwrite, remove or hide something); only creates are additive.
- Browser clients on an origin in `CORS_ORIGINS` may call `/mcp`; `mcp-protocol-version` is an allowed header and `www-authenticate` is exposed.

Left out on purpose: deleting and archiving, price overrides per occurrence, bulk edits, members, API keys, sales channels, and everything about registrations, guests, reservations and sales. They can be added to the list in `apps/api/src/mcp/tools.ts`, one operation at a time.

### Errors

A failed call is a tool result with `isError: true`, so the agent can read it and act. The text gives the problem's title, its stable code and HTTP status, the validation errors by argument, the details, and what to do next; `structuredContent.error` has the same as data.

```text
Request validation failed (invalid_request, HTTP 400).
- defaultDurationMin: must be >= 1
Some arguments do not match the tool's input schema; fix them and call again.
```

```text
Event was changed by someone else (version_conflict, HTTP 412).
Details: {"currentVersion":4}
Someone changed it after you read it. Read it again, check with the human that the change still makes sense, and retry with the new version.
```

`forbidden` (the role does not allow it, or the user is not a member of the account), `not_found` (no such id in this account), `validation_failed` (allowed shape, refused value, with `details.field`) and `account_id_required` (several accounts, none chosen) carry hints too.

## Companion skills

`apps/api/skills/<name>/SKILL.md`, served as MCP **prompts** of the same name, and the server's `instructions` tell agents to use them:

| Skill | For |
|---|---|
| `create-event` | A new event: reads the account and existing events first, asks only for what is missing (title, how people get in, when, where, capacity, ticket types), explains admission modes in plain words, handles ambiguous dates and prices, previews series, creates a draft, and publishes only on an explicit yes |
| `configure-event` | Changing an event: finds it, reads its configuration, maps the request to the smallest change (event field, rule, single date, series, offer), previews rules and series, and handles version conflicts |
| `review-event` | The summary shown before any write: the event in the human's terms, before → after for changes, defaults applied, assumptions, open points, side effects, and a clear question |

## Examples

**Querying.** "What's on at the main building next week, and is the Tuesday tour full?" → `list_events` with `locationId`, `from`, `to`; `list_occurrences` for the tour; the answer reads `pool.available` and says where the capacity comes from (`effective.capacity.source`).

**Creating.** "Set up weekly guided tours on Tuesdays at 14 this spring, 25 people, free sign-up."

1. `get_account` (locales nb, en; Europe/Oslo), `list_events q=omvisning` (nothing similar), `list_locations`.
2. Missing: which spring dates, how long, which building. The agent asks: "I read 'this spring' as 2 March to 8 June 2027, is that right? How long is each tour, and does it start in the main building?"
3. Review: draft event "Omvisning / Guided tour", main building, 60 minutes, sign-up with 25 places, Tuesdays 14:00–15:00 from 2 March to 8 June (15 dates, Oslo time). Defaults: shown in listings, sign-up closes at the start, no waitlist, no reminder. Assumed: 60 minutes. Open: no image yet.
4. On yes: `create_event`, `create_series` with `dryRun: true` (15 dates), `create_series`, `get_event_configuration`, then "It's a draft. Publish now?"

**Configuring.** "Make the weekend tours in summer take 40, and members pay 100 for the Saturday concert."

- "Weekend tours in summer": a rule on the tour event with `weekdays: [6, 7]`, `dateFrom`/`dateTo` for the summer, effect `capacity: 40`; `create_rule` with `dryRun: true` shows how many dates match and change, which the agent reports before saving.
- "Members pay 100": ambiguous if the concert has several ticket types. The agent asks which, then `update_offer` with `groupPrices: [{ groupId: <members>, amount: 10000 }]` and the offer's `version`.

**Missing or inconsistent information.** "Add a concert on the 3rd, tickets 200." The agent asks the month and the start time, notices there is no VAT class chosen and lists the account's two, and asks whether "200" includes VAT. A free event with a price, or a drop-in event with a capacity, is pointed out rather than saved.

## Tests

`apps/api/test/mcp.test.ts` runs the official SDK client over HTTP against the app: the 401 and metadata, the catalogue and its schemas, prompts, account selection, creating and configuring an event (idempotency, validation errors, version conflicts, series and rule previews, the configuration tool, publishing), a read-only role refused on writes, and tenancy.
