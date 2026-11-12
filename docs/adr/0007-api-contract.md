# 0007 – REST + OpenAPI as the integration contract

**Status:** Accepted · 2026-11-12

## Decision

- REST over HTTPS, JSON. OpenAPI 3.1 generated from the same schemas used for runtime validation (see 0002), published per version.
- URL versioning (`/v1`). Additive changes within a version; breaking changes only in a new version with an overlap period.
- **Idempotency keys** required on every write that a client may retry (holds, confirm, cancel, refund, registrations).
- ETags for optimistic concurrency on admin edits.
- Cursor-based pagination; consistent error format (RFC 9457 problem details) with stable reason codes, which also serve gate integrations.
- Generated SDKs: TypeScript, PHP (Magento), C# (Business Central, Optimizely).
- **Surfaces:**
  - `/v1` – core API (admin, integrations).
  - `/public` – read-only events, occurrences, offers and availability; cached at the edge for seconds.
  - `/validate` – validate and redeem, deployed separately.
  - `/mcp` – MCP server exposing a curated set of API operations as tools, using the caller's own credentials and scopes.

## Consequences

- The commerce integration contract (epic #13) is defined and tested against the OpenAPI spec.
- Contract tests in CI fail on unintended breaking changes.
