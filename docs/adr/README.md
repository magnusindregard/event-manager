# Architecture decision records

Short records of significant decisions: context, decision, consequences. One file per decision, numbered in order. A decision is changed by a new ADR that supersedes the old one, not by editing history.

| # | Decision | Status |
|---|---|---|
| [0001](0001-modular-monolith.md) | Modular monolith with module-owned schemas | Accepted |
| [0002](0002-typescript.md) | TypeScript across backend, admin, validator and connectors | Accepted |
| [0003](0003-postgresql.md) | PostgreSQL as the authoritative store, including holds | Accepted |
| [0004](0004-multi-tenancy.md) | Shared database with row-level security | Accepted |
| [0005](0005-identity-and-access.md) | Four identity types; authentication in a managed IdP, authorization in our database | Accepted (IdP vendor open) |
| [0006](0006-admin-and-validator-apps.md) | Admin as a SPA on the public API; validator in React Native | Accepted |
| [0007](0007-api-contract.md) | REST + OpenAPI as the integration contract | Accepted |
| [0008](0008-events-and-webhooks.md) | Transactional outbox, webhooks and in-platform connectors | Accepted |
| [0009](0009-hosting.md) | Azure, Norway East | Proposed |
| [0010](0010-buy-not-build.md) | Buy IdP, email, waiting room and pass signing | Accepted |

Architecture diagrams: FigJam board "Event-Management".
