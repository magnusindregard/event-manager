using '../main.bicep'

param env = 'staging'
// Set from GitHub environment variables in the deploy workflow (az ... -p key=value overrides these).
param postgresAdminGroupObjectId = readEnvironmentVariable('PG_ADMIN_GROUP_ID', '00000000-0000-0000-0000-000000000000')
param postgresAdminGroupName = readEnvironmentVariable('PG_ADMIN_GROUP_NAME', 'em-postgres-admins')
param oidcIssuer = readEnvironmentVariable('OIDC_ISSUER', 'https://example.ciamlogin.com/tenant/v2.0')
param oidcAudience = readEnvironmentVariable('OIDC_AUDIENCE', 'api://event-manager-staging')
