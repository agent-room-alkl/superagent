// INNOPRO Super Agent — Azure deployment (PRD v1.3 §6). One resource group per environment.
// Secrets are never parameters here: the model API key is written by the app's Setup page into Key Vault at runtime.
targetScope = 'resourceGroup'

@description('Short environment name, e.g. dev, staging, prod')
param env string

@description('Azure region for every resource except Document Intelligence. Verify service + model availability before production.')
param location string = resourceGroup().location

@description('Region for Document Intelligence only. Defaults to location. Staging sets this to australiaeast because australiasoutheast has no Document Intelligence, while australiaeast has no free Container Apps environment quota.')
param docIntelLocation string = location

@description('Container image, e.g. <acr>.azurecr.io/superagent:<sha>')
param image string

@description('Entra tenant id and API app registration (client) id used to validate user tokens')
param entraTenantId string
param entraClientId string

@description('Platform tenant id (uuid) used for all rows of this single-tenant deployment. Stable per resource group.')
param platformTenantId string = guid(resourceGroup().id, 'superagent-platform-tenant')

@description('Optional approved read-only database sources JSON. Credential references only; never passwords or connection strings.')
param sourceDatabasesJson string = ''

@description('Approved mailbox/SharePoint metadata scopes and audiences; never credentials.')
param knowledgeSourcesJson string = ''

@description('PostgreSQL admin group (Entra) object id and display name. Password auth is disabled.')
param pgAdminGroupObjectId string
param pgAdminGroupName string

@description('Production hardening: VNet integration + private endpoints for Postgres, Key Vault, Blob')
param enablePrivateNetworking bool = false

@description('Production hardening: Azure Front Door Premium with a managed WAF policy in front of the web app')
param enableFrontDoor bool = false

@allowed(['Burstable', 'GeneralPurpose'])
param pgTier string = 'Burstable'
param pgSku string = 'Standard_B1ms'

var prefix = 'sa-${env}'
var uniq = uniqueString(resourceGroup().id)

// ---------- Identities (one per runtime; least privilege) ----------
resource appIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-app-id'
  location: location
}
resource sandboxIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  // Tool sandbox / browser / computer-use jobs: no access to the app Key Vault or database (PRD §3.5).
  name: '${prefix}-sandbox-id'
  location: location
}

// ---------- Observability ----------
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-logs'
  location: location
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 30 }
}
resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${prefix}-ai'
  location: location
  kind: 'web'
  properties: { Application_Type: 'web', WorkspaceResourceId: logs.id, SamplingPercentage: 50 }
}

// ---------- Registry ----------
resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: replace('${prefix}acr${uniq}', '-', '')
  location: location
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false }
}
var acrPullRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
resource appAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: acr
  name: guid(acr.id, appIdentity.id, 'acrpull')
  properties: { roleDefinitionId: acrPullRole, principalId: appIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}
resource sandboxAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: acr
  name: guid(acr.id, sandboxIdentity.id, 'acrpull')
  properties: { roleDefinitionId: acrPullRole, principalId: sandboxIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}

// ---------- Key Vault (RBAC; app may read/write secrets, sandbox gets nothing) ----------
resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: take('${prefix}-kv-${uniq}', 24)
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 30
    enablePurgeProtection: true
    publicNetworkAccess: enablePrivateNetworking ? 'Disabled' : 'Enabled'
  }
}
resource appKvSecretsOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: kv
  name: guid(kv.id, appIdentity.id, 'kv-secrets-officer')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7') // Key Vault Secrets Officer
    principalId: appIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// ---------- Storage (originals, attachments, artifacts, screenshots) ----------
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: take(replace('${prefix}st${uniq}', '-', ''), 24)
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: enablePrivateNetworking ? 'Disabled' : 'Enabled'
  }
}
resource blobSvc 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: { deleteRetentionPolicy: { enabled: true, days: 14 } }
}
resource sources 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobSvc
  name: 'sources'
}
resource artifacts 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobSvc
  name: 'artifacts'
}
// Knowledge originals (uploads, parsed binaries) keyed by content digest (T-40). Private; app identity only.
resource knowledge 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobSvc
  name: 'knowledge'
  properties: { publicAccess: 'None' }
}
// Restricted screenshot retention for sandbox runs: private container, deleted automatically after 7 days.
resource screenshots 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobSvc
  name: 'screenshots'
}
resource screenshotLifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'expire-screenshots'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: { blobTypes: ['blockBlob'], prefixMatch: ['screenshots/'] }
            actions: { baseBlob: { delete: { daysAfterModificationGreaterThan: 7 } } }
          }
        }
      ]
    }
  }
}
// The sandbox identity may write only to the screenshots container — no Key Vault, no database, no other containers.
resource sandboxScreenshotWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: screenshots
  name: guid(screenshots.id, sandboxIdentity.id, 'blob-contributor')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    principalId: sandboxIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}
resource appBlobContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, appIdentity.id, 'blob-contributor')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe') // Storage Blob Data Contributor
    principalId: appIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// ---------- PostgreSQL (Entra auth only) ----------
resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: '${prefix}-pg-${uniq}'
  location: location
  sku: { name: pgSku, tier: pgTier }
  properties: {
    version: '16'
    storage: { storageSizeGB: 32, autoGrow: 'Enabled' }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    authConfig: { activeDirectoryAuth: 'Enabled', passwordAuth: 'Disabled', tenantId: subscription().tenantId }
    network: { publicNetworkAccess: enablePrivateNetworking ? 'Disabled' : 'Enabled' }
  }
}
resource pgAdmin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2024-08-01' = {
  parent: pg
  name: pgAdminGroupObjectId
  properties: { principalType: 'Group', principalName: pgAdminGroupName, tenantId: subscription().tenantId }
}
resource pgExtensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: pg
  name: 'azure.extensions'
  properties: { value: 'PG_TRGM,VECTOR', source: 'user-override' }
}
resource pgDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: pg
  name: 'superagent'
}
resource pgAllowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = if (!enablePrivateNetworking) {
  parent: pg
  name: 'allow-azure-services'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

// ---------- Document Intelligence ----------
resource docIntel 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: '${prefix}-docintel-${uniq}'
  location: docIntelLocation
  kind: 'FormRecognizer'
  sku: { name: 'S0' }
  properties: { customSubDomainName: '${prefix}-docintel-${uniq}', disableLocalAuth: true, publicNetworkAccess: enablePrivateNetworking ? 'Disabled' : 'Enabled' }
}
resource appDocIntelUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: docIntel
  name: guid(docIntel.id, appIdentity.id, 'cog-user')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'a97b65f3-24c7-4388-baec-2e87135dc908') // Cognitive Services User
    principalId: appIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// ---------- Optional private networking ----------
module network 'network.bicep' = if (enablePrivateNetworking) {
  name: 'network'
  params: {
    prefix: prefix
    location: location
    postgresId: pg.id
    keyVaultId: kv.id
    storageId: storage.id
    docIntelId: docIntel.id
  }
}

// ---------- Container Apps ----------
resource caEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${prefix}-cae'
  location: location
  properties: {
    appLogsConfiguration: { destination: 'log-analytics', logAnalyticsConfiguration: { customerId: logs.properties.customerId, sharedKey: logs.listKeys().primarySharedKey } }
    vnetConfiguration: enablePrivateNetworking ? { infrastructureSubnetId: network!.outputs.appsSubnetId, internal: false } : null
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
  }
}

var commonEnv = [
  { name: 'NODE_ENV', value: 'production' }
  { name: 'AUTH_MODE', value: 'entra' }
  { name: 'PLATFORM_TENANT_ID', value: platformTenantId }
  { name: 'ENTRA_TENANT_ID', value: entraTenantId }
  { name: 'ENTRA_CLIENT_ID', value: entraClientId }
  { name: 'AZURE_CLIENT_ID', value: appIdentity.properties.clientId }
  { name: 'KEY_VAULT_URL', value: kv.properties.vaultUri }
  { name: 'PG_HOST', value: pg.properties.fullyQualifiedDomainName }
  { name: 'PG_DATABASE', value: 'superagent' }
  { name: 'PG_USER', value: appIdentity.name }
  { name: 'BLOB_URL', value: storage.properties.primaryEndpoints.blob }
  { name: 'DOC_INTEL_ENDPOINT', value: docIntel.properties.endpoint }
  { name: 'SOURCE_DATABASES_JSON', value: sourceDatabasesJson }
  { name: 'KNOWLEDGE_SOURCES_JSON', value: knowledgeSourcesJson }
  { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
]

resource web 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${prefix}-web'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${appIdentity.id}': {} } }
  properties: {
    managedEnvironmentId: caEnv.id
    configuration: {
      ingress: { external: true, targetPort: 8080, transport: 'auto' }
      registries: [{ server: acr.properties.loginServer, identity: appIdentity.id }]
    }
    template: {
      containers: [
        {
          name: 'web'
          image: image
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: concat(commonEnv, [{ name: 'APP_ROLE', value: 'web' }])
          probes: [
            { type: 'Liveness', httpGet: { path: '/healthz', port: 8080 } }
            { type: 'Readiness', httpGet: { path: '/readyz', port: 8080 } }
          ]
        }
      ]
      scale: { minReplicas: 0, maxReplicas: 3 } // web may scale to zero; background work lives in the worker
    }
  }
  dependsOn: [appAcrPull]
}

resource worker 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${prefix}-worker'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${appIdentity.id}': {} } }
  properties: {
    managedEnvironmentId: caEnv.id
    configuration: {
      registries: [{ server: acr.properties.loginServer, identity: appIdentity.id }]
    }
    template: {
      containers: [
        {
          name: 'worker'
          image: image
          resources: { cpu: json('1.0'), memory: '2Gi' }
          env: concat(commonEnv, [{ name: 'APP_ROLE', value: 'worker' }])
        }
      ]
      // No ingress and a Postgres-polling queue: without minReplicas it would scale to 0 and never start again (PRD §5.1).
      scale: { minReplicas: 1, maxReplicas: 2 }
    }
  }
  dependsOn: [appAcrPull]
}

// Migrations run as a manual Job before traffic is switched (CI triggers it).
resource migrate 'Microsoft.App/jobs@2024-03-01' = {
  name: '${prefix}-migrate'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${appIdentity.id}': {} } }
  properties: {
    environmentId: caEnv.id
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 600
      replicaRetryLimit: 1
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: [{ server: acr.properties.loginServer, identity: appIdentity.id }]
    }
    template: {
      containers: [
        {
          name: 'migrate'
          image: image
          command: ['node', 'apps/server/dist/migrate.js']
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: commonEnv
        }
      ]
    }
  }
  dependsOn: [appAcrPull]
}

// On-demand tool sandbox (per-minute billing). Separate identity: no app Key Vault, no app database (T-43).
resource sandbox 'Microsoft.App/jobs@2024-03-01' = {
  name: '${prefix}-sandbox'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${sandboxIdentity.id}': {} } }
  properties: {
    environmentId: caEnv.id
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 900
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: [{ server: acr.properties.loginServer, identity: sandboxIdentity.id }]
    }
    template: {
      containers: [
        {
          name: 'sandbox'
          image: replace(image, ':', '-browser:') // browser image variant built from Dockerfile.browser
          resources: { cpu: json('1.0'), memory: '2Gi' }
          env: [
            { name: 'APP_ROLE', value: 'browser' }
            { name: 'AZURE_CLIENT_ID', value: sandboxIdentity.properties.clientId }
            { name: 'SCREENSHOT_BLOB_URL', value: storage.properties.primaryEndpoints.blob }
          ]
        }
      ]
    }
  }
  dependsOn: [sandboxAcrPull]
}

// ---------- Optional Front Door + WAF ----------
resource wafPolicy 'Microsoft.Network/FrontDoorWebApplicationFirewallPolicies@2024-02-01' = if (enableFrontDoor) {
  name: replace('${prefix}waf', '-', '')
  location: 'global'
  sku: { name: 'Premium_AzureFrontDoor' }
  properties: {
    policySettings: { enabledState: 'Enabled', mode: 'Prevention' }
    managedRules: { managedRuleSets: [{ ruleSetType: 'Microsoft_DefaultRuleSet', ruleSetVersion: '2.1', ruleSetAction: 'Block' }] }
  }
}
resource afd 'Microsoft.Cdn/profiles@2024-02-01' = if (enableFrontDoor) {
  name: '${prefix}-afd'
  location: 'global'
  sku: { name: 'Premium_AzureFrontDoor' }
}
resource afdEndpoint 'Microsoft.Cdn/profiles/afdEndpoints@2024-02-01' = if (enableFrontDoor) {
  parent: afd
  name: '${prefix}-web'
  location: 'global'
  properties: { enabledState: 'Enabled' }
}
resource afdOrigins 'Microsoft.Cdn/profiles/originGroups@2024-02-01' = if (enableFrontDoor) {
  parent: afd
  name: 'web'
  properties: {
    loadBalancingSettings: { sampleSize: 4, successfulSamplesRequired: 3 }
    healthProbeSettings: { probePath: '/healthz', probeProtocol: 'Https', probeRequestType: 'GET', probeIntervalInSeconds: 60 }
  }
}
resource afdOrigin 'Microsoft.Cdn/profiles/originGroups/origins@2024-02-01' = if (enableFrontDoor) {
  parent: afdOrigins
  name: 'web-app'
  properties: { hostName: web.properties.configuration.ingress.fqdn, originHostHeader: web.properties.configuration.ingress.fqdn, httpsPort: 443 }
}
resource afdRoute 'Microsoft.Cdn/profiles/afdEndpoints/routes@2024-02-01' = if (enableFrontDoor) {
  parent: afdEndpoint
  name: 'default'
  properties: {
    originGroup: { id: afdOrigins.id }
    supportedProtocols: ['Https']
    httpsRedirect: 'Enabled'
    forwardingProtocol: 'HttpsOnly'
    patternsToMatch: ['/*']
    linkToDefaultDomain: 'Enabled'
  }
  dependsOn: [afdOrigin]
}
resource afdSecurity 'Microsoft.Cdn/profiles/securityPolicies@2024-02-01' = if (enableFrontDoor) {
  parent: afd
  name: 'waf'
  properties: {
    parameters: {
      type: 'WebApplicationFirewall'
      wafPolicy: { id: wafPolicy.id }
      associations: [{ domains: [{ id: afdEndpoint.id }], patternsToMatch: ['/*'] }]
    }
  }
}

output frontDoorHost string = enableFrontDoor ? afdEndpoint!.properties.hostName : ''
output webUrl string = 'https://${web.properties.configuration.ingress.fqdn}'
output acrLoginServer string = acr.properties.loginServer
output keyVaultUri string = kv.properties.vaultUri
output postgresHost string = pg.properties.fullyQualifiedDomainName
output appIdentityPrincipalId string = appIdentity.properties.principalId
