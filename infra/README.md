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

## Now: local sign-in with Entra External ID (no Azure resources, $0)

Until staging exists (see the staging runbook below), the
identity design is tested against real Entra tokens from the local stack. This needs only the External ID
tenant; nothing in Azure is created and nothing is billed.

1. **Get an Entra account to create the tenant with.** Any of these works:
   - an existing work account where you may create tenants;
   - the External ID free trial at <https://aka.ms/ciam-free-trial> (no subscription needed for the trial;
     link a subscription later to keep the tenant, which stays free up to 50 000 monthly active users);
   - a new Azure account (staging runbook, step 0.2).
2. **Create the external tenant and its app registrations:** follow staging runbook step 4, with two changes:
   skip linking a subscription if you are on the trial, and name the apps `em-api-local` / `em-admin-local`
   (scope `api://em-api-local/access`). The admin's redirect URI is `http://localhost:5173`.
3. **Point the local stack at it** in `.env` (keep `AUTH_DEV_SECRET`, so dev sign-in still works too):
   ```bash
   OIDC_ISSUER=https://<external-tenant-id>.ciamlogin.com/<external-tenant-id>/v2.0
   OIDC_AUDIENCE=<em-api-local client ID>
   VITE_AUTH_MODE=msal
   VITE_ENTRA_CLIENT_ID=<em-admin-local client ID>
   VITE_ENTRA_AUTHORITY=https://<prefix>.ciamlogin.com/<external-tenant-id>/
   VITE_ENTRA_API_SCOPE=api://em-api-local/access
   ```
4. **Create a user to sign in with.** In the external tenant: *Users* → *All users* → *New user* →
   *Create new user*, sign-in method **Email**, with a password. Use an address that is not already in the
   tenant (see the pitfalls below).
5. **Invite that email and sign in:**
   ```bash
   pnpm db:up && pnpm db:migrate
   pnpm create-account --slug entra-test --name "Entra test" --owner-email <that email>
   pnpm dev
   ```
   Open <http://localhost:5173>, sign in, change a setting, and check the audit log.
   This is the milestone 1 exit check until staging exists. It passed on 16 November 2026.

**What this proves:** the access token's issuer and audience match what the API expects, the `email` claim
reaches the API (otherwise invitations never match; see ADR 0012), and MSAL works with a `ciamlogin.com`
authority. If sign-in fails, the error appears on the sign-in screen and in the API log.

### Entra pitfalls (found while setting this up)

| Symptom | Cause | Fix |
|---|---|---|
| `endpoints_resolution_error` on the admin's sign-in screen | Authority without the tenant ID. MSAL accepts the tenant's issuer (`https://<tenant-id>.ciamlogin.com/<tenant-id>/v2.0`) only when the authority path has the same ID; a bare host or `<prefix>.onmicrosoft.com` fails | `VITE_ENTRA_AUTHORITY=https://<prefix>.ciamlogin.com/<tenant-id>/` (the admin now refuses other forms with a clear message) |
| `AADSTS50020 … does not exist in tenant` | A **work account** (e.g. a company's Entra ID) is sent to its home tenant, then refused because it is unknown in the external tenant | Invite it as an external (guest) user in the external tenant, or federate that company's Entra tenant. Client staff will hit this; see ADR 0012 |
| "Denne kontoen finnes ikke … `<aadSelfSignup>`opprett en ny`</aadSelfSignup>`" with no working link | Self-service sign-up is not offered, even with the app in a sign-up/sign-in user flow; `prompt=create` is ignored too. **Cause not yet found** | Create users directly (step 4). The product is invitation-only, so public sign-up is not needed |
| The account that created the tenant cannot sign in to the app | It is stored as an admin identity (e.g. a Microsoft account, `…#EXT#@…`), not a customer account with email sign-in | Create a separate customer user (step 4) with a different email |

## Staging runbook (end of milestone 2)

The Deploy workflow is manual-only until this is done; re-add its `push` trigger afterwards.

### What staging costs

Lean by design (`docs/implementation-plan.md`, milestone 2). Rough monthly figures in Norway East, before traffic:

| Resource | Staging setting | ≈ USD/month |
|---|---|---|
| Container Apps `api` (with the worker as a sidecar), `public` | Consumption, scale to zero | 0–5 (free grant covers light use) |
| PostgreSQL Flexible Server | Burstable B1ms, 32 GB, no HA; stop it when idle | 15 running, ~4 stopped (storage only) |
| Container Registry | Basic | 5 |
| Log Analytics + App Insights | 30-day retention | 0–3 |
| Key Vault, VNet, private DNS, storage (admin SPA) | | ~1 |
| **Front Door Standard** | base fee, `DEPLOY_FRONT_DOOR` | **35** |

So staging is about $25 without Front Door and $60 with it. Front Door is what the cache test needs, so the
default is on. Between cache tests, set the GitHub variable `DEPLOY_FRONT_DOOR=false` and redeploy. The
apps stay reachable on their Container Apps hosts (the Bicep outputs `apiHost` and `publicApiHost`).

Stop Postgres when nobody is testing. Azure starts it again by itself after 7 days:

```bash
az postgres flexible-server stop -g rg-em-staging -n psql-em-staging
az postgres flexible-server start -g rg-em-staging -n psql-em-staging
```

In staging the worker runs as a second container in the `api` app, so it sleeps with the API. Jobs queued
by a request (outbox dispatch, invitation provisioning) run while that request keeps the replica awake,
which lasts a few minutes. Scheduled jobs (series horizon, milestone 3) need a Container Apps cron job there.

Steps 0–5 are done by a person: they need a browser, a payment method and admin consent screens.
Steps 6–9 can be handed over (to a colleague or Claude). Values marked **→** are what the hand-over needs.

### 0. Starting from nothing

**0.1 Decide who owns the Azure tenant.** This is hard to change later: moving a subscription to
another tenant breaks managed identities, role assignments and Key Vault access.

- **A new tenant for the product** (recommended if the product will be run by its own company or team):
  signing up in 0.2 creates it, named `<something>.onmicrosoft.com`.
- **A subscription in an existing organisation's tenant** (e.g. your employer's): ask its Azure admin for a
  subscription with you as *Owner*, plus permission to create app registrations and groups. Then skip to 0.3.

**0.2 Create the Azure account** at <https://azure.microsoft.com/free>:

1. Sign in with, or create, a Microsoft account. Verify a phone number and a card.
2. This creates an Entra tenant where you are *Global Administrator*, and a *Free Trial* subscription
   (credit for 30 days) where you are *Owner*.
3. **Upgrade to pay-as-you-go right away** (Portal → *Subscriptions* → your subscription → *Upgrade*). Trials
   stop resources when the credit or spending limit is reached, and restrict quotas such as PostgreSQL by region.
4. Sign-in uses MFA by default; keep it. Later, add a second admin so you are not the only way in.

**0.3 Set a budget alert** (Portal → *Cost Management* → *Budgets* → *Add*): monthly, scope the subscription,
for example 150 USD, with email alerts at 80 % and 100 %. Staging is expected to cost roughly 100 USD a month.
Front Door's base fee and Postgres make up most of that.

**0.4 Install and sign in to the tools** (macOS):

```bash
brew install azure-cli
az login                      # opens the browser; pick the subscription from 0.2
az account show --query "{subscription:id, tenant:tenantId, user:user.name}"
gh auth status                # GitHub CLI, used in step 5
```

No Homebrew? Use <https://shell.azure.com> (Cloud Shell, already signed in) or the CLI container:
`docker run -it --rm -v "$PWD:/repo" -w /repo mcr.microsoft.com/azure-cli`.

**0.5 Register resource providers and check region capacity.** New subscriptions start with most providers
unregistered, and may not be allowed to create PostgreSQL in every region.

```bash
for p in Microsoft.App Microsoft.DBforPostgreSQL Microsoft.Cdn Microsoft.ContainerRegistry Microsoft.KeyVault \
         Microsoft.OperationalInsights Microsoft.Insights Microsoft.Network Microsoft.ManagedIdentity Microsoft.Storage; do
  az provider register --namespace $p --wait
done
az postgres flexible-server list-skus -l norwayeast -o table | head   # empty or an error = restricted
```

If PostgreSQL is restricted in Norway East: Portal → *Help + support* → *Create a support request* →
*Service and subscription limits (quotas)* → *Azure Database for PostgreSQL Flexible Server* → request
access to Norway East. Answers usually take from a few hours to two days, so do this first.

### 1. Resource group

```bash
az group create -n rg-em-staging -l norwayeast
```

**→** subscription ID and tenant ID (from 0.4).

### 2. GitHub deploy identity (OIDC, no secrets)

Steps 1–3 run in the workforce tenant from 0.2, which is the one `az login` signed in to.

```bash
APP_ID=$(az ad app create --display-name em-github-staging --query appId -o tsv)
az ad sp create --id $APP_ID
az ad app federated-credential create --id $APP_ID --parameters '{
  "name": "github-staging",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:magnusindregard/event-manager:environment:staging",
  "audiences": ["api://AzureADTokenExchange"]
}'
RG_ID=$(az group show -n rg-em-staging --query id -o tsv)
for role in "Contributor" "Role Based Access Control Administrator" "Storage Blob Data Contributor"; do
  az role assignment create --assignee $APP_ID --role "$role" --scope $RG_ID
done
```

`Role Based Access Control Administrator` is needed because the Bicep grants the app identities AcrPull and Key Vault access.
Restrict it with a condition to those two roles if your policies require it.

**→** `APP_ID` (deploy identity client ID).

### 3. Postgres admin group

```bash
az ad group create --display-name em-postgres-admins --mail-nickname em-postgres-admins --query id -o tsv
az ad group member add --group em-postgres-admins --member-id $(az ad signed-in-user show --query id -o tsv)
```

**→** group object ID and name.

### 4. Entra External ID (portal)

Staff sign in through a **second, separate tenant** of the "external" type (ADR 0012). The tenant from 0.2
(the "workforce" tenant) holds the Azure resources; the external tenant only holds sign-in configuration.

1. **Create the external tenant.** Go to <https://entra.microsoft.com> → *Entra ID* → *Overview* → *Manage tenants*
   → *Create* → *External*. Pick location *Europe*, a name (e.g. `Event manager staff`) and a domain prefix
   (e.g. `emstaff`; it becomes `emstaff.ciamlogin.com`). Link it to the subscription and resource group
   `rg-em-staging` for billing (not needed on the free trial). The first 50 000 monthly active users are free.
2. **Switch to it.** Top-right *Settings* (gear) → *Directories + subscriptions* → switch to the new tenant.
   Steps 3–5 happen there.
3. **App registration for the API:** *App registrations* → *New registration* → name `em-api-staging`,
   *Accounts in this organizational directory only*, no redirect URI. Then:
   - *Expose an API* → *Add* Application ID URI `api://em-api-staging` → *Add a scope* `access`
     (admins and users can consent; any display text).
   - *Manifest* → set `"requestedAccessTokenVersion": 2` → *Save*.
   - *Token configuration* → *Add optional claim* → token type **Access** → `email` → *Add*.
4. **App registration for the admin:** *New registration* → name `em-admin-staging`, same account type,
   redirect URI platform **Single-page application** with `http://localhost:5173`. Then:
   - *API permissions* → *Add a permission* → *APIs my organization uses* → `em-api-staging` → `access`
     → *Add* → *Grant admin consent*.
5. **User flow:** *External Identities* → *User flows* → *New user flow* → name `signin`, identity provider
   *Email with password* (or *Email one-time passcode*) → *Create*. Open it → *Applications* → *Add application*
   → add `em-admin-staging`. Self-service sign-up did not appear in our tenant even so (see *Entra pitfalls*);
   users can always be created directly, and access requires an invitation stored in our database.
   Each client's own Entra ID or Google Workspace is added here as an identity provider later.

**→** external tenant ID (external tenant → *Overview*), domain prefix (`<prefix>.ciamlogin.com`), and the
*Application (client) ID* from the overview page of `em-api-staging` and of `em-admin-staging`.

With v2 access tokens, the API checks:
`OIDC_ISSUER = https://<tenant-id>.ciamlogin.com/<tenant-id>/v2.0` and `OIDC_AUDIENCE = <API client ID>` (the GUID, not the `api://` URI).

### 4b. Graph app for invitation provisioning (portal, external tenant)

The worker creates each invitee's identity in the external tenant (ADR 0012). In the **external tenant**:

1. *App registrations* → *New registration* → `em-provisioning-staging`, this directory only, no redirect URI.
2. *API permissions* → *Add* → *Microsoft Graph* → *Application permissions* → `User.Invite.All` and
   `User.ReadWrite.All` → *Grant admin consent*.
3. *Certificates & secrets* → *Federated credentials* → *Add* → scenario *Other issuer*:
   issuer `https://login.microsoftonline.com/<workforce tenant ID>/v2.0`, subject identifier = the
   **object ID** of the managed identity `id-em-staging-app` (exists after step 6), audience
   `api://AzureADTokenExchange`. No client secret is created.
4. *External Identities* → *External collaboration settings*: guest invitations must be allowed for apps.

**→** the app's *Application (client) ID*, and the tenant's `<prefix>.onmicrosoft.com` domain (*Overview*).

Locally you can test against the same app with a client secret instead (`IDENTITY_DIRECTORY=graph`,
`GRAPH_CLIENT_SECRET=…` in `.env`). Delete that secret afterwards.

### 4c. Postmark (invitation email)

Create a Postmark server, verify the sender domain, and copy its *Server API token*. After step 6, store it:

```bash
az keyvault secret set --vault-name <kv-em-staging-…> -n postmark-token --value '<token>'
```

The deploying identity needs *Key Vault Secrets Officer* for this one command. Without `MAIL_FROM`, the
worker logs emails instead of sending them.

### 5. GitHub environment `staging`

```bash
gh api -X PUT repos/magnusindregard/event-manager/environments/staging
for kv in AZURE_CLIENT_ID=<APP_ID> AZURE_TENANT_ID=<tenant> AZURE_SUBSCRIPTION_ID=<sub> RESOURCE_GROUP=rg-em-staging \
          PG_ADMIN_GROUP_ID=<group id> PG_ADMIN_GROUP_NAME=em-postgres-admins \
          OIDC_ISSUER=https://<ext-tenant>.ciamlogin.com/<ext-tenant>/v2.0 OIDC_AUDIENCE=<API client ID> \
          ENTRA_ADMIN_CLIENT_ID=<admin client ID> ENTRA_AUTHORITY=https://<prefix>.ciamlogin.com/<ext-tenant>/ \
          ENTRA_API_SCOPE=api://em-api-staging/access \
          GRAPH_TENANT_ID=<ext-tenant> GRAPH_CLIENT_ID=<provisioning app ID> GRAPH_TENANT_DOMAIN=<prefix>.onmicrosoft.com \
          MAIL_FROM=no-reply@<verified domain> DEPLOY_FRONT_DOOR=true; do
  gh variable set "${kv%%=*}" --env staging --body "${kv#*=}" -R magnusindregard/event-manager
done
```

### 6. Bootstrap deploy (registry and data tier, no apps yet)

```bash
PG_ADMIN_GROUP_ID=<group id> PG_ADMIN_GROUP_NAME=em-postgres-admins OIDC_ISSUER=<issuer> OIDC_AUDIENCE=<API client ID> \
  az deployment group create -g rg-em-staging -f infra/main.bicep -p infra/env/staging.bicepparam \
  -p deployApps=false --query properties.outputs.registryServer.value -o tsv
gh variable set ACR_NAME --env staging --body "<registry name without .azurecr.io>" -R magnusindregard/event-manager
```

### 7. First full deploy

Run the *Deploy* workflow (Actions → *Deploy* → *Run workflow*; then re-add its `push` trigger so merges deploy). It builds images, deploys Bicep with the apps, runs the
`migrate` job (which also registers the app identity in Postgres), uploads the admin and smoke-tests
`/v1/me` → 401 through Front Door. Then add `https://<front door host>/` as a redirect URI on **em-admin-staging**.

### 8. First account

The API image contains the bootstrap CLI and the app identity's database login:

```bash
curl -s https://<front door host>/v1/openapi.json >/dev/null   # wake a replica (staging scales to zero)
az containerapp exec -g rg-em-staging -n ca-em-staging-api \
  --command "node dist/cli/create-account.js --slug <slug> --name <name> --owner-email <email>"
```

Then set `ADMIN_URL=https://<front door host>/` as a GitHub variable (the link in invitation emails) and
redeploy once.

### 9. Exit check for milestone 1

Sign in at `https://<front door host>/` with the invited email, change a setting, and see it in the audit log.

### 10. Exit check for milestone 2

1. Sign in, create a venue and a space, and create and publish an event with nb and en titles, a ticket link
   and two one-off occurrences in the next 30 days. Move one of them to the space.
2. Create a second account (step 8), publish an event there too, and create a publishable key in each
   account (*Settings* → *API keys*), plus a preview key in the first.
3. Run the cache check through Front Door:
   ```bash
   scripts/smoke-public.sh <front door host> <pk_ of account 1> <pk_ of account 2> <prv_ of account 1>
   ```
   It expects a cache HIT on the second request for each key, different bodies per tenant, and no caching
   for the preview token.
4. Read the next 30 days in both languages and check each occurrence's location and ticket link:
   ```bash
   curl -s "https://<host>/public/v1/occurrences?key=<pk_…>&locale=en&to=$(date -u -v+30d +%FT%TZ)" | jq '.items[] | {start: .startUtc, title: .event.title, location: .location.name, admission}'
   ```
5. Invite a colleague in *Users*. The row shows "Sign-in ready" once the worker has provisioned them, and
   they receive the invitation email.

### Prod

Same steps with `prod` names, plus required reviewers on the GitHub `prod` environment, `STAGING_ACR_NAME` set,
and AcrPull on the staging registry for the prod deploy identity. Prod deploys are manual: run *Deploy*
with "promote to prod" and the SHA that staging runs.

## Known gaps (tracked for phase 1)

- Container Apps ingress is public behind Front Door Standard. Before personal data arrives, move to Front Door Premium with Private Link origins (or validate `X-Azure-FDID`).
- WAF has custom rules only; managed rule sets need Premium.
- Front Door cache purge on outbox events is not wired; the public API relies on a short `s-maxage`.
