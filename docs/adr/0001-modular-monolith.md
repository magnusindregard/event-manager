# 0001 – Modular monolith with module-owned schemas

**Status:** Accepted · 2026-11-12

## Context

The domain splits into bounded contexts: catalog, occurrence rules, inventory, offers and pricing, registration, admission, integration. Several operations must change data in more than one context atomically. The clearest case: creating a hold resolves a price (pricing), reserves capacity (inventory) and writes a line snapshot. Across separate services this would need sagas and compensation logic, on exactly the path where correctness matters most.

## Decision

Build one deployable core API, structured as modules that mirror the bounded contexts.

- Each module owns a Postgres schema. No module reads or writes another module's tables; it calls the other module's public interface.
- Cross-module operations that must be atomic run in one database transaction, coordinated by the calling module.
- Module boundaries are enforced in code (lint rules on imports).

Deployed separately from the start, because they scale differently:

- **Validation API** – spikes when doors open, must stay up when admin is busy.
- **Public read and availability API** – high read volume, cache-friendly.
- **Worker** – outbox dispatch, webhooks, connectors, retention jobs.
- **MCP server** – a thin client of the public API.

These share the codebase and database; they are deployment units, not independent services.

## Consequences

- Simple local development, one migration pipeline, transactional consistency.
- A module can be extracted later if it needs to be, because its schema and interface are already separate.
- Discipline required: the boundary rules must be enforced in CI, or the monolith turns into a tangle.
