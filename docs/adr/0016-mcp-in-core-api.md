# 0016 – MCP server inside the core API, as curated /v1 operations

**Status:** Accepted · 2026-11-20 · Refines 0007 (`/mcp`); replaces the separate MCP app in 0001 and 0009

## Context

ADR 0007 planned `/mcp`, "a curated set of API operations as tools, using the caller's own credentials and scopes". ADR 0001 called it a thin client of the API and ADR 0009 a separate Container App. The first tools (issue #106) let staff find, create and configure events through an agent, so they must authenticate, authorize, validate and audit exactly like the admin.

## Decision

- The MCP server is a Fastify plugin in the **core API** (`apps/api/src/mcp`), at `POST /mcp`: Streamable HTTP, **stateless**, JSON responses, using the official TypeScript SDK (MIT).
- Each tool is **one /v1 operation**, chosen in a curated list. Its input schema is built from the route's own params, query and body schemas (by operationId), and a call is an **in-process request** (`app.inject`) to that route with the caller's bearer token and account. There is no second implementation of any rule, permission or validation.
- Authentication is the staff token (ADR 0005, 0012). `/mcp` answers 401 with `WWW-Authenticate` pointing to RFC 9728 protected resource metadata, which names the staff IdP as the authorization server.
- The account is the `Account-Id` header, else `?accountId=` on the MCP URL (for clients that cannot set headers), else the user's only account.
- Companion skills are Markdown files in `apps/api/skills`, served as MCP prompts and usable directly as Claude Code skills.

## Consequences

- No extra app, image or network hop; the MCP surface cannot drift from /v1, and contract changes reach tools automatically.
- MCP load shares the core API's scaling. If it needs its own, the plugin can move to its own app by replacing `app.inject` with HTTP calls to `/v1`, keeping the same tool catalogue.
- Integrations with client credentials (ADR 0005) can use `/mcp` once the core API accepts them; nothing in the MCP layer is staff-specific apart from `whoami`.
- Entra External ID has no dynamic client registration, so MCP clients need a registered client ID (docs/mcp.md).
