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
    }
    template: {
      containers: [{
        name: 'api'
        image: '${registryServer}/event-manager/api:${imageTag}'
        resources: { cpu: json('0.5'), memory: '1Gi' }
        env: concat(runtimeEnv, [
          { name: 'PORT', value: '3000' }
          { name: 'OIDC_ISSUER', value: oidcIssuer }
          { name: 'OIDC_AUDIENCE', value: oidcAudience }
        ])
        probes: probesFor(3000)
      }]
      scale: { minReplicas: 1, maxReplicas: prod ? 6 : 2, rules: [{ name: 'http', http: { metadata: { concurrentRequests: '50' } } }] }
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
      scale: { minReplicas: 1, maxReplicas: prod ? 10 : 2, rules: [{ name: 'http', http: { metadata: { concurrentRequests: '100' } } }] }
    }
  }
}

resource worker 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'ca-${name}-worker'
  location: location
  tags: tags
  identity: identity
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: { registries: registries }
    template: {
      containers: [{
        name: 'worker'
        image: '${registryServer}/event-manager/worker:${imageTag}'
        resources: { cpu: json('0.5'), memory: '1Gi' }
        env: runtimeEnv
      }]
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

output apiFqdn string = api.properties.configuration.ingress.fqdn
output publicApiFqdn string = publicApi.properties.configuration.ingress.fqdn
output migrateJobName string = migrate.name
