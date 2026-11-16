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
param adminUrl = readEnvironmentVariable('ADMIN_URL', '')
