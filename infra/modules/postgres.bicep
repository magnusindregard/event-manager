param name string
param location string
param tags object
param prod bool
param subnetId string
param privateDnsZoneId string
@description('Entra administrators: [{ objectId, name, type: Group|ServicePrincipal|User }]')
param admins array

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: 'psql-${name}'
  location: location
  tags: tags
  sku: prod ? { name: 'Standard_D2ds_v5', tier: 'GeneralPurpose' } : { name: 'Standard_B1ms', tier: 'Burstable' }
  properties: {
    version: '16'
    storage: { storageSizeGB: prod ? 128 : 32, autoGrow: 'Enabled' }
    backup: { backupRetentionDays: prod ? 35 : 7, geoRedundantBackup: prod ? 'Enabled' : 'Disabled' }
    highAvailability: { mode: prod ? 'ZoneRedundant' : 'Disabled' }
    network: { delegatedSubnetResourceId: subnetId, privateDnsZoneArmResourceId: privateDnsZoneId, publicNetworkAccess: 'Disabled' }
    // No passwords: apps and migrations use managed identities (ADR 0014).
    authConfig: { activeDirectoryAuth: 'Enabled', passwordAuth: 'Disabled', tenantId: subscription().tenantId }
  }
}

@batchSize(1)
resource administrators 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2024-08-01' = [for a in admins: {
  parent: server
  name: a.objectId
  properties: { principalName: a.name, principalType: a.type, tenantId: subscription().tenantId }
}]

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: server
  name: 'event_manager'
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
  dependsOn: [administrators]
}

output fqdn string = server.properties.fullyQualifiedDomainName
output databaseName string = database.name
