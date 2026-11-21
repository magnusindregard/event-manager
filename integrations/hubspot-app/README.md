# HubSpot app

Our own HubSpot app (ADR 0017, [docs/hubspot.md](../../docs/hubspot.md)): a developer platform
project app with OAuth and **private distribution** (installable in up to 10 portals without
marketplace review). Built and deployed with the HubSpot CLI:

```bash
npm install -g @hubspot/cli
hs account auth          # the developer account that owns the app
hs project upload        # from this folder
```

After the first upload, copy the app's client id and secret from the developer account:

- client id → GitHub variable `HUBSPOT_CLIENT_ID` on the environment,
- client secret → Key Vault secret `hubspot-client-secret` (infra/README.md, "HubSpot app").

**Keep the scopes in step** with `REQUIRED_SCOPES` and `OPTIONAL_SCOPES` in
`packages/hubspot/src/index.ts`: the install URL asks for those, and HubSpot refuses an install
that asks for a scope the app does not declare. **Redirect URLs** are the admin's callback page
(`<admin>/integrations/hubspot/callback`) for each environment; add production's before it goes live.

Not yet checked against a real developer account (milestone 0, the spike): the config schema
for platform version 2025.2 and the exact scope names.
