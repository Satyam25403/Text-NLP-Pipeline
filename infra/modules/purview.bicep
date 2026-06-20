// purview.bicep
// Provisions a Microsoft Purview account for data governance of the NLP pipeline.
//
// Resources created:
//   - Microsoft Purview account
//   - Role assignment: Purview MSI → Storage Blob Data Reader (on storage account)
//   - Role assignment: Purview MSI → Search Index Data Reader (on Search service)
//
// Post-deployment manual steps (see purview/scan-config.json):
//   1. Register data sources via Purview portal or REST API
//   2. Import classification rules from purview/classification-rules.json
//   3. Create and trigger scans per purview/scan-config.json
//   4. Run scripts/register-purview-lineage.js to register fn-enrich custom lineage

@description('Azure region for all resources')
param location string = resourceGroup().location

@description('Purview account name — must be globally unique')
param purviewAccountName string

@description('Storage account resource ID — Purview MSI needs Blob Data Reader')
param storageAccountResourceId string

@description('Azure AI Search service resource ID — Purview MSI needs Index Data Reader')
param searchServiceResourceId string

@description('Tags to apply to all resources')
param tags object = {
  project:     'nlp-pipeline'
  layer:       'governance'
  managedBy:   'bicep'
}

// ── Purview Account ───────────────────────────────────────────────────────────

resource purviewAccount 'Microsoft.Purview/accounts@2021-07-01' = {
  name:     purviewAccountName
  location: location
  tags:     tags
  sku: {
    name:     'Standard'
    capacity: 4
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    publicNetworkAccess: 'Enabled'
    managedResourceGroupName: '${purviewAccountName}-managed-rg'
  }
}

// ── Role assignments ───────────────────────────────────────────────────────────
// Purview's managed identity needs read access to scan each data source.

// Storage Blob Data Reader — allows Purview to scan bronze/silver/gold containers
resource storageBlobReaderRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  // Scope is the storage account (covers all containers)
  scope: resourceGroup()
  name:  guid(storageAccountResourceId, purviewAccount.id, 'StorageBlobDataReader')
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1' // Storage Blob Data Reader
    )
    principalId:   purviewAccount.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Search Index Data Reader — allows Purview to scan the articles index
resource searchIndexReaderRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: resourceGroup()
  name:  guid(searchServiceResourceId, purviewAccount.id, 'SearchIndexDataReader')
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '1407120a-92aa-4202-b7e9-c0e197c71c8f' // Search Index Data Reader
    )
    principalId:   purviewAccount.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// ── Outputs ────────────────────────────────────────────────────────────────────

@description('Purview account endpoint for REST API calls')
output purviewEndpoint string = purviewAccount.properties.endpoints.catalog

@description('Purview account name')
output purviewAccountName string = purviewAccount.name

@description('Purview managed identity principal ID — needed for role assignments on other resources')
output purviewPrincipalId string = purviewAccount.identity.principalId

@description('Atlas endpoint for lineage registration (used by register-purview-lineage.js)')
output atlasEndpoint string = purviewAccount.properties.endpoints.atlas