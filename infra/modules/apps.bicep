param name string
param location string
param tags object
param prod bool
param imageTag string
param registryServer string
param subnetId string
param logAnalyticsCustomerId string
@secure()
param logAnalyticsKey string
param appInsightsConnectionString string
param appIdentityId string
param appIdentityClientId string
param appIdentityName string
param migratorIdentityId string
param migratorIdentityClientId string
param migratorIdentityName string
param postgresHost string
param databaseName string
param oidcIssuer string
param oidcAudience string
@description('Staging: run the worker as a sidecar of the api app, so it scales to zero with it. Prod: its own always-on app.')
param workerAsSidecar bool = !prod
@description('Invitation provisioning (ADR 0012). Empty graphClientId keeps the fake directory (no Entra identities are created).')
param graphTenantId string = ''
param graphClientId string = ''
param graphTenantDomain string = ''
@description('Postmark token in Key Vault as secret "postmark-token". Empty mailFrom keeps the fake mailer.')
param keyVaultUri string = ''
param mailFrom string = ''
@description('Where invitees sign in, e.g. https://<front door host>/')
param adminUrl string = ''
@description('Comma-separated origins allowed to call the core API from a browser. Empty behind Front Door (same origin).')
param corsOrigins string = ''

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-${name}'
  location: location
  tags: tags
  properties: {
    vnetConfiguration: { infrastructureSubnetId: subnetId, internal: false }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    zoneRedundant: prod
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: { customerId: logAnalyticsCustomerId, sharedKey: logAnalyticsKey }
    }
  }
}

// The runtime principal name in Postgres is the managed identity's name (pgaadauth).
var runtimeEnv = [
  { name: 'NODE_ENV', value: 'production' }
  { name: 'DATABASE_URL', value: 'postgres://${appIdentityName}@${postgresHost}:5432/${databaseName}' }
  { name: 'DATABASE_AUTH', value: 'entra' }
  { name: 'AZURE_CLIENT_ID', value: appIdentityClientId }
  { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
]
var identity = { type: 'UserAssigned', userAssignedIdentities: { '${appIdentityId}': {} } }
var registries = [{ server: registryServer, identity: appIdentityId }]
func probesFor(port int) array => [
  { type: 'Liveness', httpGet: { path: '/healthz', port: port }, periodSeconds: 10 }
  { type: 'Readiness', httpGet: { path: '/readyz', port: port }, periodSeconds: 10 }
]

resource api 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'ca-${name}-api'
  location: location
  tags: tags
  identity: identity
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      // Reached through Front Door. TODO before personal data (phase 1): Front Door Premium + Private Link.
      ingress: { external: true, targetPort: 3000, transport: 'http' }
      registries: registries
      secrets: workerAsSidecar ? workerSecrets : []
    }
    template: {
      containers: concat([{
        name: 'api'
        image: '${registryServer}/event-manager/api:${imageTag}'
        resources: { cpu: json('0.5'), memory: '1Gi' }
        env: concat(runtimeEnv, [
          { name: 'PORT', value: '3000' }
          { name: 'OIDC_ISSUER', value: oidcIssuer }
          { name: 'OIDC_AUDIENCE', value: oidcAudience }
        ], empty(corsOrigins) ? [] : [{ name: 'CORS_ORIGINS', value: corsOrigins }])
        probes: probesFor(3000)
      }], workerAsSidecar ? [workerContainer] : [])
      // Staging scales to zero (cold start of a few seconds) to keep cost down.
      scale: { minReplicas: prod ? 1 : 0, maxReplicas: prod ? 6 : 2, rules: [{ name: 'http', http: { metadata: { concurrentRequests: '50' } } }] }
    }
  }
}

resource publicApi 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'ca-${name}-public'
  location: location
  tags: tags
  identity: identity
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      ingress: { external: true, targetPort: 3001, transport: 'http' }
      registries: registries
    }
    template: {
      containers: [{
        name: 'public-api'
        image: '${registryServer}/event-manager/public-api:${imageTag}'
        resources: { cpu: json('0.5'), memory: '1Gi' }
        env: concat(runtimeEnv, [{ name: 'PORT', value: '3001' }])
        probes: probesFor(3001)
      }]
      scale: { minReplicas: prod ? 1 : 0, maxReplicas: prod ? 10 : 2, rules: [{ name: 'http', http: { metadata: { concurrentRequests: '100' } } }] }
    }
  }
}

var mailEnabled = !empty(mailFrom) && !empty(keyVaultUri)
var workerSecrets = mailEnabled ? [{ name: 'postmark-token', keyVaultUrl: '${keyVaultUri}secrets/postmark-token', identity: appIdentityId }] : []
var workerContainer = {
  name: 'worker'
  image: '${registryServer}/event-manager/worker:${imageTag}'
  resources: { cpu: json('0.5'), memory: '1Gi' }
  env: concat(runtimeEnv, [
    { name: 'ADMIN_URL', value: adminUrl }
  ], empty(graphClientId) ? [] : [
    { name: 'IDENTITY_DIRECTORY', value: 'graph' }
    { name: 'GRAPH_TENANT_ID', value: graphTenantId }
    { name: 'GRAPH_CLIENT_ID', value: graphClientId }
    { name: 'GRAPH_TENANT_DOMAIN', value: graphTenantDomain }
  ], mailEnabled ? [
    { name: 'MAILER', value: 'postmark' }
    { name: 'MAIL_FROM', value: mailFrom }
    { name: 'POSTMARK_TOKEN', secretRef: 'postmark-token' }
  ] : [])
}

// Prod: always one replica, since graphile-worker listens for new jobs (LISTEN/NOTIFY).
// Staging: the worker runs inside the api app instead (see api above), and handles jobs while
// a request keeps the api awake, so the nightly horizon job runs as a Container Apps cron job (below).
resource worker 'Microsoft.App/containerApps@2024-03-01' = if (!workerAsSidecar) {
  name: 'ca-${name}-worker'
  location: location
  tags: tags
  identity: identity
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: { registries: registries, secrets: workerSecrets }
    template: {
      containers: [workerContainer]
      scale: { minReplicas: 1, maxReplicas: prod ? 3 : 1 }
    }
  }
}

// Started by the deploy workflow before new revisions roll out.
resource migrate 'Microsoft.App/jobs@2024-03-01' = {
  name: 'caj-${name}-migrate'
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${migratorIdentityId}': {} } }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 900
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: [{ server: registryServer, identity: migratorIdentityId }]
    }
    template: {
      containers: [{
        name: 'migrate'
        image: '${registryServer}/event-manager/db:${imageTag}'
        resources: { cpu: json('0.25'), memory: '0.5Gi' }
        env: [
          { name: 'MIGRATOR_DATABASE_URL', value: 'postgres://${migratorIdentityName}@${postgresHost}:5432/${databaseName}' }
          { name: 'DATABASE_AUTH', value: 'entra' }
          { name: 'AZURE_CLIENT_ID', value: migratorIdentityClientId }
          { name: 'APP_DB_PRINCIPAL', value: appIdentityName }
        ]
      }]
    }
  }
}

// Staging only: the series horizon (docs/mvp.md, 18 months ahead) without an always-on worker.
// In prod the worker's own crontab runs the same job. Extending is idempotent, so overlap is harmless.
resource horizon 'Microsoft.App/jobs@2024-03-01' = if (workerAsSidecar) {
  name: 'caj-${name}-horizon'
  location: location
  tags: tags
  identity: identity
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 1800
      replicaRetryLimit: 1
      scheduleTriggerConfig: { cronExpression: '0 2 * * *', parallelism: 1, replicaCompletionCount: 1 }
      registries: registries
    }
    template: {
      containers: [{
        name: 'horizon'
        image: '${registryServer}/event-manager/worker:${imageTag}'
        command: ['node', 'dist/cli/extend-horizons.js']
        resources: { cpu: json('0.25'), memory: '0.5Gi' }
        env: runtimeEnv
      }]
    }
  }
}

output apiFqdn string = api.properties.configuration.ingress.fqdn
output publicApiFqdn string = publicApi.properties.configuration.ingress.fqdn
output migrateJobName string = migrate.name
