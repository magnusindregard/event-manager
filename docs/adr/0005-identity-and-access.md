# 0005 – Identity and access

**Status:** Accepted · 2026-11-12 (IdP vendor still to be chosen)

## Context

Four very different parties authenticate: client staff, integrations, validator devices and attendees. Forcing them into one mechanism either weakens security or makes attendee flows painful.

## Decision

| Who | Mechanism |
|---|---|
| Client staff (admin UI) | OIDC via a managed IdP with an organization concept, federating to each client's Entra ID or Google Workspace for SSO |
| Integrations (ecom, POS, connectors, gates) | OAuth2 client credentials per tenant, with scopes per channel and capability, e.g. `events:read`, `holds:write`, `validate` |
| Validator devices | Enrollment by scanning a setup QR from admin; issues a device-bound credential tied to one checkpoint profile, revocable from admin |
| Attendees | No accounts. Signed, single-purpose tokens in RSVP links and ticket URLs |

- **Authentication** in the IdP. **Authorization** in our database: roles and their scope (tenant, venue, event). Changing IdP must not touch permissions.
- Starter roles: owner, event manager, box office, door staff, finance (read-only). Scoping per venue.
- All admin and integration actions are written to the audit log with actor and client id.
- Consumer accounts are out of scope; the client's ecom owns its customers.

## Open

IdP vendor. Candidates: Entra External ID, Auth0 (Organizations), WorkOS; Zitadel or Keycloak if self-hosting or EU-only hosting becomes a requirement. Criteria: per-tenant enterprise SSO, how SSO connections are priced as tenants grow, EU data residency, machine-to-machine token pricing.

## Consequences

- Each identity type can evolve independently (e.g. adding passkeys for staff).
- Our database is the source of truth for "who may do what", which keeps audit and support simple.
