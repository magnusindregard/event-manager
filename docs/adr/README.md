# Architecture decision records

Short records of significant decisions: context, decision, consequences. One file per decision, numbered in order. A decision is changed by a new ADR that supersedes the old one, not by editing history.

| # | Decision | Status |
|---|---|---|
| [0001](0001-modular-monolith.md) | Modular monolith with module-owned schemas | Accepted |
| [0002](0002-typescript.md) | TypeScript across backend, admin, validator and connectors | Accepted |
| [0003](0003-postgresql.md) | PostgreSQL as the authoritative store, including holds | Accepted |
| [0004](0004-multi-tenancy.md) | Shared database with row-level security | Accepted |
| [0005](0005-identity-and-access.md) | Four identity types; authentication in a managed IdP, authorization in our database | Accepted (IdP: see 0012) |
| [0006](0006-admin-and-validator-apps.md) | Admin as a SPA on the public API; validator in React Native | Accepted |
| [0007](0007-api-contract.md) | REST + OpenAPI as the integration contract | Accepted |
| [0008](0008-events-and-webhooks.md) | Transactional outbox, webhooks and in-platform connectors | Accepted |
| [0009](0009-hosting.md) | Azure, Norway East | Accepted (see 0014) |
| [0010](0010-buy-not-build.md) | Buy IdP, email, waiting room and pass signing | Accepted |
| [0011](0011-backend-stack.md) | Fastify, Kysely, TypeBox, graphile-worker; database roles | Accepted |
| [0012](0012-identity-provider.md) | Staff IdP: Microsoft Entra External ID | Accepted |
| [0013](0013-admin-ui-library.md) | Admin UI: MUI + MUI X Community, no commercial licences | Accepted |
| [0014](0014-infrastructure-as-code.md) | Bicep, deployed from GitHub Actions | Accepted |

Architecture diagrams: FigJam board "Event-Management".
