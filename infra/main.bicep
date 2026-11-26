// Event manager – Azure, Norway East (ADR 0009, 0014).
// Deploy:  az deployment group create -g rg-em-<env> -f infra/main.bicep -p infra/env/<env>.bicepparam -p imageTag=<sha>
targetScope = 'resourceGroup'

@allowed(['staging', 'prod'])
param env string
param location string = 'norwayeast'
@description('Container image tag (git SHA). Ignored when deployApps is false.')
param imageTag string = 'bootstrap'
@description('Image tag of the migrate job; defaults to imageTag. scripts/deploy-env.sh sets it to the new tag while the apps stay on the old one.')
param migrateImageTag string = imageTag
@description('First run: false creates the registry and data tier before any image exists.')
param deployApps bool = true
@description('Entra group whose members administer PostgreSQL (humans).')
param postgresAdminGroupObjectId string
param postgresAdminGroupName string
@description('Entra External ID issuer for staff tokens, e.g. https://<tenant-id>.ciamlogin.com/<tenant-id>/v2.0')
param oidcIssuer string
@description('Application ID URI or client ID of the API app registration.')
param oidcAudience string
@description('Front Door Standard costs about $35/month before traffic. Staging can turn it off between cache tests; the apps stay reachable on their Container Apps hosts.')
param deployFrontDoor bool = true
@description('Invitation provisioning through Microsoft Graph (ADR 0012). Empty graphClientId keeps the fake directory.')
param graphTenantId string = ''
param graphClientId string = ''
param graphTenantDomain string = ''
@description('Sender for invitation emails (Postmark). Needs Key Vault secret "postmark-token". Empty keeps the fake mailer.')
param mailFrom string = ''
@description('Postmark delivery webhook on the API (/webhooks/postmark). Needs Key Vault secret "postmark-webhook-auth" holding "user:password".')
param postmarkWebhook bool = false
@description('Master keys for sensitive registration answers. Needs Key Vault secret "sensitive-data-keys" holding "id:base64-32-bytes".')
param sensitiveDataKeys bool = false
@description('Client id of our HubSpot app (docs/hubspot.md). Needs Key Vault secret "hubspot-client-secret" and sensitiveDataKeys. Empty: connecting HubSpot is off.')
param hubspotClientId string = ''
@description('Hosted checkout with Vipps MobilePay (docs/checkout.md). Needs sensitiveDataKeys.')
param vippsPayments bool = false
@description('Admin URL in invitation emails. Defaults to where the admin is served (Front Door, or the storage static website without it).')
param adminUrl string = ''
@description('API scope MCP clients ask for at sign-in (docs/mcp.md), e.g. api://em-api-staging/access. Empty: none advertised.')
param mcpScopes string = ''
@description('Public base URL of the core API, named in the MCP sign-in metadata. Defaults to the admin URL behind Front Door (same host); without Front Door the API derives it from the request.')
param apiPublicUrl string = ''
@description('Postgres Entra admin principal type. Group is the runbook default; User lets one person administer a test environment where creating groups is not allowed.')
@allowed(['Group', 'User'])
param postgresAdminType string = 'Group'

var prod = env == 'prod'
var name = 'em-${env}'
var tags = { app: 'event-manager', env: env }

module network 'modules/network.bicep' = {
  name: 'network'
  params: { name: name, location: location, tags: tags }
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${name}'
  location: location
  tags: tags
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: prod ? 90 : 30 }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-${name}'
  location: location
  tags: tags
  kind: 'web'
  properties: { Application_Type: 'web', WorkspaceResourceId: logs.id }
}

// Runtime identity for api, public-api and worker (member of em_app in Postgres).
resource appIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${name}-app'
  location: location
  tags: tags
}

// Migration identity: Postgres Entra administrator, used only by the migrate job.
resource migratorIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${name}-migrator'
  location: location
  tags: tags
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: replace('cr${name}${uniqueString(resourceGroup().id)}', '-', '')
  location: location
  tags: tags
  sku: { name: prod ? 'Standard' : 'Basic' }
  properties: { adminUserEnabled: false }
}

var acrPull = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
resource appAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, appIdentity.id, acrPull)
  scope: registry
  properties: { roleDefinitionId: acrPull, principalId: appIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}
resource migratorAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, migratorIdentity.id, acrPull)
  scope: registry
  properties: { roleDefinitionId: acrPull, principalId: migratorIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: take('kv-${name}-${uniqueString(resourceGroup().id)}', 24)
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enablePurgeProtection: true
    softDeleteRetentionInDays: 90
  }
}

var kvSecretsUser = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
resource appVaultAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, appIdentity.id, kvSecretsUser)
  scope: vault
  properties: { roleDefinitionId: kvSecretsUser, principalId: appIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}

module postgres 'modules/postgres.bicep' = {
  name: 'postgres'
  params: {
    name: name
    location: location
    tags: tags
    prod: prod
    subnetId: network.outputs.postgresSubnetId
    privateDnsZoneId: network.outputs.postgresDnsZoneId
    admins: [
      { objectId: postgresAdminGroupObjectId, name: postgresAdminGroupName, type: postgresAdminType }
      { objectId: migratorIdentity.properties.principalId, name: migratorIdentity.name, type: 'ServicePrincipal' }
    ]
  }
}

// Admin SPA. Static website hosting is switched on by the deploy workflow (data-plane setting).
resource adminStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: take(replace('st${name}admin${uniqueString(resourceGroup().id)}', '-', ''), 24)
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: prod ? 'Standard_ZRS' : 'Standard_LRS' }
  properties: { minimumTlsVersion: 'TLS1_2', allowBlobPublicAccess: false, supportsHttpsTrafficOnly: true }
}

// Without Front Door the admin is served from the storage static website, on another origin
// than the API, so the API allows it through CORS and the admin calls the API's own host.
var adminWebOrigin = replace(adminStorage.properties.primaryEndpoints.web, '.net/', '.net')
var adminOrigin = deployFrontDoor ? '' : adminWebOrigin

module apps 'modules/apps.bicep' = if (deployApps) {
  name: 'apps'
  params: {
    name: name
    location: location
    tags: tags
    prod: prod
    imageTag: imageTag
    migrateImageTag: migrateImageTag
    registryServer: registry.properties.loginServer
    subnetId: network.outputs.appsSubnetId
    logAnalyticsCustomerId: logs.properties.customerId
    logAnalyticsKey: logs.listKeys().primarySharedKey
    appInsightsConnectionString: appInsights.properties.ConnectionString
    appIdentityId: appIdentity.id
    appIdentityClientId: appIdentity.properties.clientId
    appIdentityName: appIdentity.name
    migratorIdentityId: migratorIdentity.id
    migratorIdentityClientId: migratorIdentity.properties.clientId
    migratorIdentityName: migratorIdentity.name
    postgresHost: postgres.outputs.fqdn
    databaseName: postgres.outputs.databaseName
    oidcIssuer: oidcIssuer
    oidcAudience: oidcAudience
    graphTenantId: graphTenantId
    graphClientId: graphClientId
    graphTenantDomain: graphTenantDomain
    keyVaultUri: vault.properties.vaultUri
    mailFrom: mailFrom
    postmarkWebhook: postmarkWebhook
    sensitiveDataKeys: sensitiveDataKeys
    hubspotClientId: hubspotClientId
    vippsPayments: vippsPayments
    adminUrl: !empty(adminUrl) ? adminUrl : (deployFrontDoor ? '' : '${adminWebOrigin}/')
    corsOrigins: adminOrigin
    mcpScopes: mcpScopes
    publicUrl: !empty(apiPublicUrl) ? apiPublicUrl : (deployFrontDoor ? adminUrl : '')
  }
  dependsOn: [appAcrPull, migratorAcrPull, appVaultAccess]
}

module edge 'modules/frontdoor.bicep' = if (deployApps && deployFrontDoor) {
  name: 'frontdoor'
  params: {
    name: name
    tags: tags
    apiHost: apps!.outputs.apiFqdn
    publicApiHost: apps!.outputs.publicApiFqdn
    adminHost: replace(replace(adminStorage.properties.primaryEndpoints.web, 'https://', ''), '/', '')
  }
}

output registryServer string = registry.properties.loginServer
output adminStorageAccount string = adminStorage.name
@description('Where staff open the admin.')
output adminOrigin string = deployApps && deployFrontDoor ? 'https://${edge!.outputs.endpointHost}' : adminWebOrigin
output frontDoorHost string = deployApps && deployFrontDoor ? edge!.outputs.endpointHost : ''
output apiHost string = deployApps ? apps!.outputs.apiFqdn : ''
output publicApiHost string = deployApps ? apps!.outputs.publicApiFqdn : ''
output attendeeHost string = deployApps ? apps!.outputs.attendeeFqdn : ''
output migrateJobName string = deployApps ? apps!.outputs.migrateJobName : ''
output appInsightsConnectionString string = appInsights.properties.ConnectionString
