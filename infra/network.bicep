// Production hardening (optional): VNet, private endpoints with private DNS for PostgreSQL, Key Vault, Blob and
// Document Intelligence. Container Apps environment is injected into the infrastructure subnet.
param prefix string
param location string
param postgresId string
param keyVaultId string
param storageId string
param docIntelId string

resource vnet 'Microsoft.Network/virtualNetworks@2024-01-01' = {
  name: '${prefix}-vnet'
  location: location
  properties: {
    addressSpace: { addressPrefixes: ['10.40.0.0/16'] }
    subnets: [
      {
        name: 'apps'
        properties: {
          addressPrefix: '10.40.0.0/23'
          delegations: [{ name: 'aca', properties: { serviceName: 'Microsoft.App/environments' } }]
        }
      }
      {
        name: 'private-endpoints'
        properties: { addressPrefix: '10.40.2.0/24', privateEndpointNetworkPolicies: 'Disabled' }
      }
    ]
  }
}

var endpoints = [
  { name: 'pg', id: postgresId, group: 'postgresqlServer', zone: 'privatelink.postgres.database.azure.com' }
  { name: 'kv', id: keyVaultId, group: 'vault', zone: 'privatelink.vaultcore.azure.net' }
  { name: 'blob', id: storageId, group: 'blob', zone: 'privatelink.blob.${environment().suffixes.storage}' }
  { name: 'docintel', id: docIntelId, group: 'account', zone: 'privatelink.cognitiveservices.azure.com' }
]

resource zones 'Microsoft.Network/privateDnsZones@2020-06-01' = [for e in endpoints: {
  name: e.zone
  location: 'global'
}]

resource zoneLinks 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = [for (e, i) in endpoints: {
  parent: zones[i]
  name: '${prefix}-link'
  location: 'global'
  properties: { virtualNetwork: { id: vnet.id }, registrationEnabled: false }
}]

resource pes 'Microsoft.Network/privateEndpoints@2024-01-01' = [for e in endpoints: {
  name: '${prefix}-pe-${e.name}'
  location: location
  properties: {
    subnet: { id: '${vnet.id}/subnets/private-endpoints' }
    privateLinkServiceConnections: [{ name: e.name, properties: { privateLinkServiceId: e.id, groupIds: [e.group] } }]
  }
}]

resource peDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-01-01' = [for (e, i) in endpoints: {
  parent: pes[i]
  name: 'default'
  properties: { privateDnsZoneConfigs: [{ name: e.name, properties: { privateDnsZoneId: zones[i].id } }] }
}]

output appsSubnetId string = '${vnet.id}/subnets/apps'
