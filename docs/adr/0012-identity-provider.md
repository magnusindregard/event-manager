# 0012 – Staff identity provider: Microsoft Entra External ID

**Status:** Accepted · 2026-11-13 · Settles the IdP vendor left open in [0005](0005-identity-and-access.md)

## Decision

- Staff sign in through an **Entra External ID** (external tenant) app registration. Client organisations federate their own Entra ID or Google Workspace to it (OIDC federation).
- The admin uses MSAL.js (authorization code + PKCE). The API verifies access tokens against the tenant's JWKS (`jose`), checking issuer and audience.
- Identity is `(issuer, subject)`. Email comes from the `email` optional claim and is used once: to accept a pending invitation on first sign-in (`tenancy.login`).
- Authorization stays in our database (0005). The admin sends `Account-Id`, and the API looks up the user's roles in that account under RLS. "No such account" and "not a member" give the same 403.
- Local development and tests use HS256 tokens signed with `AUTH_DEV_SECRET`. The API refuses to start with that secret when `NODE_ENV=production`.

## Why

Azure-native, EU data residency, priced per monthly active user (staff counts are small), and federation to the clients' existing Entra ID tenants. Auth0 Organizations has a better per-organisation SSO model and stays the fallback if federation setup per client becomes a burden.

## Risks

- Per-client federation is configured manually in the External ID tenant; it is not in Bicep.
- Invitation matching trusts the federated IdP's email. Only federate IdPs that verify email. If this does not hold, require an invitation link token instead.
