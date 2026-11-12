# 0008 – Transactional outbox, webhooks and connectors

**Status:** Accepted · 2026-11-12

## Decision

### Domain events

- Written to an outbox table in the same transaction as the change that caused them. No event without a commit, no commit without an event.
- CloudEvents format, versioned event types (`registration.confirmed.v1`, `admission.issued.v1`, `occurrence.cancelled.v1`, …).
- Dispatched by the worker. Queue: Postgres-backed (pg-boss or graphile-worker) to start; Azure Service Bus only when volume requires it.

### Webhooks

- Per-tenant subscriptions filtered by event type.
- HMAC-signed payloads, timestamped to prevent replay.
- Retries with exponential backoff; dead-letter after a limit; manual replay from admin.
- Delivery log visible to the tenant.

### Connectors

Two kinds:

- **Outbound sync, run in the platform** (HubSpot, Mailchimp, transactional email, wallet passes): workers subscribed to domain events, configured per tenant, credentials encrypted with Key Vault. Same retry and dead-letter handling as webhooks.
- **Commerce and content, run in the client's system** (Adobe Commerce module, Sanity plugin, POS adapters): packages we ship and maintain that call our API through the generated SDKs.

Clients with their own integration platform (Logic Apps, Make and similar) use webhooks plus the API directly.

## Consequences

- Connectors never call core modules directly; they only see events and the public API. Adding a connector does not touch the core.
- At-least-once delivery: every consumer, including our own connectors, must be idempotent on event id.
