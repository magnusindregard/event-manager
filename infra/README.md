# Infrastructure (Azure, Norway East)

Bicep for one environment per resource group (ADR 0009, 0014). `main.bicep` creates:

| Resource | Purpose |
|---|---|
| VNet (`apps`, `postgres` subnets) + private DNS | Postgres has no public endpoint |
| PostgreSQL Flexible Server 16 | Entra auth only, no passwords; zone-redundant HA and geo backup in prod |
| User-assigned identities `id-em-<env>-app`, `id-em-<env>-migrator` | App runtime (member of `em_app`) and migrations (Postgres Entra admin) |
| Container Registry, Key Vault, Log Analytics, Application Insights | |
| Container Apps: `api`, `public`, `worker`; job `migrate` | One image per app, tagged with the git SHA |
| Storage account | Admin SPA (static website) |
| Front Door Standard + WAF | `/v1/*` → api (no cache), `/public/v1/*` → public-api (cached, key in query string), `/*` → admin |

## One-time setup per environment

1. **Resource group:** `az group create -n rg-em-staging -l norwayeast`.
2. **Deploy identity for GitHub:** an Entra app registration with federated credentials for `repo:<owner>/event-manager:environment:staging` (and `prod`). Grant it on the resource group:
   - `Contributor` and `Role Based Access Control Administrator` (Bicep creates role assignments)
   - `Storage Blob Data Contributor` (admin upload)
3. **Postgres admin group:** an Entra group for humans who administer the database.
4. **Entra External ID:** create the external tenant, then two app registrations:
   - **API**: expose a scope (e.g. `api://event-manager-staging/access`). Add `email` as an optional claim on access tokens.
   - **Admin SPA**: SPA platform, redirect URI `https://<front door host>/`, API permission on the scope above.
   - Per client: add their Entra ID or Google Workspace as an OIDC identity provider in the user flow.
5. **GitHub environment variables** (`staging`, `prod`; prod with required reviewers):
   `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `RESOURCE_GROUP`, `ACR_NAME`,
   `PG_ADMIN_GROUP_ID`, `PG_ADMIN_GROUP_NAME`, `OIDC_ISSUER`, `OIDC_AUDIENCE`,
   `ENTRA_ADMIN_CLIENT_ID`, `ENTRA_AUTHORITY`, `ENTRA_API_SCOPE`.
6. **First deploy** (registry and data tier before any image exists):
   ```bash
   az deployment group create -g rg-em-staging -f infra/main.bicep -p infra/env/staging.bicepparam -p deployApps=false
   ```
   Put the registry name from the output in `ACR_NAME`. After that, run the Deploy workflow.
7. **First account:** run the API image as a one-off job with the app identity:
   `node dist/cli/create-account.js --slug <slug> --name "<name>" --owner-email <email>`.

## Known gaps (tracked for phase 1)

- Container Apps ingress is public behind Front Door Standard. Before personal data arrives, move to Front Door Premium with Private Link origins (or validate `X-Azure-FDID`).
- WAF has custom rules only; managed rule sets need Premium.
- Front Door cache purge on outbox events is not wired; the public API relies on a short `s-maxage`.
