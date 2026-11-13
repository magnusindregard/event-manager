# 0014 – Infrastructure as code: Bicep, deployed from GitHub Actions

**Status:** Accepted · 2026-11-13 · Accepts [0009](0009-hosting.md) and settles its IaC choice

## Decision

- **Bicep** under `infra/`, one `main.bicep` with modules and a `.bicepparam` per environment (`staging`, `prod`), in Azure Norway East.
- **GitHub Actions** deploys with OIDC federated credentials (no stored Azure secrets): build images → Azure Container Registry → `az deployment group create` → run the `migrate` Container Apps Job → roll out new revisions → upload the admin build.
- Apps reach Postgres through Entra authentication with one user-assigned managed identity. There are no database passwords in Azure.
- Front Door Standard in the MVP. Move to Premium (managed WAF rule sets, Private Link origins) before personal data arrives in phase 1.

## Why Bicep over Terraform

Hosting is Azure-only (0009), Bicep has no state file to secure, and new Container Apps and Front Door features land in Bicep first. Things Bicep cannot manage well (the Entra External ID tenant and its app registrations) are documented as manual steps in `infra/README.md`.

## Consequences

- Moving to another cloud would mean rewriting the infrastructure, not the application (0009 keeps the app portable).
