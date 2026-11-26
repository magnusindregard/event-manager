using '../main.bicep'

param env = 'prod'
// Set from GitHub environment variables in the deploy workflow (az ... -p key=value overrides these).
param postgresAdminGroupObjectId = readEnvironmentVariable('PG_ADMIN_GROUP_ID', '00000000-0000-0000-0000-000000000000')
param postgresAdminGroupName = readEnvironmentVariable('PG_ADMIN_GROUP_NAME', 'em-postgres-admins')
param oidcIssuer = readEnvironmentVariable('OIDC_ISSUER', 'https://example.ciamlogin.com/tenant/v2.0')
param oidcAudience = readEnvironmentVariable('OIDC_AUDIENCE', 'api://event-manager-prod')
param deployFrontDoor = bool(readEnvironmentVariable('DEPLOY_FRONT_DOOR', 'true'))
param graphTenantId = readEnvironmentVariable('GRAPH_TENANT_ID', '')
param graphClientId = readEnvironmentVariable('GRAPH_CLIENT_ID', '')
param graphTenantDomain = readEnvironmentVariable('GRAPH_TENANT_DOMAIN', '')
param mailFrom = readEnvironmentVariable('MAIL_FROM', '')
param postmarkWebhook = bool(readEnvironmentVariable('POSTMARK_WEBHOOK', 'false'))
param sensitiveDataKeys = bool(readEnvironmentVariable('SENSITIVE_ANSWERS', 'false'))
param vippsPayments = bool(readEnvironmentVariable('VIPPS_PAYMENTS', 'false'))
param adminUrl = readEnvironmentVariable('ADMIN_URL', '')
// MCP server (docs/mcp.md): the same API scope the admin asks for; the API's public URL defaults to ADMIN_URL behind Front Door.
param mcpScopes = readEnvironmentVariable('ENTRA_API_SCOPE', '')
param apiPublicUrl = readEnvironmentVariable('API_PUBLIC_URL', '')
