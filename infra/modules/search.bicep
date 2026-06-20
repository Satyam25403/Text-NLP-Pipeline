// search.bicep
// Provisions Azure AI Search service.
//
// Index schema is NOT created here — run scripts/create-index.js after deployment.
// This module only provisions the service and outputs the keys needed by the script.
//
// SKU options:
//   free (F1):  50MB, no SLA, 1 service per subscription — for development only
//   basic:      2GB, SLA, up to 15 indexes — minimum for production
//   standard:   25GB/partition, 3 replicas — for production with HA

@description('Azure region')
param location string = resourceGroup().location

@description('Search service name — must be globally unique')
param searchServiceName string

@description('SKU tier: free | basic | standard')
@allowed(['free', 'basic', 'standard'])
param skuName string = 'basic'

@description('Number of replicas (1 for dev, 2+ for HA in production)')
@minValue(1)
@maxValue(12)
param replicaCount int = 1

@description('Number of partitions (1 for dev, scale for larger indexes)')
@allowed([1, 2, 3, 4, 6, 12])
param partitionCount int = 1

@description('Tags')
param tags object = {
  project:   'nlp-pipeline'
  layer:     'indexing'
  managedBy: 'bicep'
}

// ── Search Service ────────────────────────────────────────────────────────────

resource searchService 'Microsoft.Search/searchServices@2023-11-01' = {
  name:     searchServiceName
  location: location
  tags:     tags
  sku: {
    name: skuName
  }
  properties: {
    replicaCount:        replicaCount
    partitionCount:      partitionCount
    hostingMode:         'default'
    publicNetworkAccess: 'enabled'
    semanticSearch:      'free'    // free semantic ranker tier (1,000 queries/month)
  }
}

// ── Outputs ───────────────────────────────────────────────────────────────────

@description('Search service endpoint — set as SEARCH_ENDPOINT env var')
output searchEndpoint string = 'https://${searchService.name}.search.windows.net'

@description('Search service resource ID — used by purview.bicep for role assignment')
output searchServiceResourceId string = searchService.id

@description('Search admin key — store in Key Vault, set as SEARCH_API_KEY env var')
output searchAdminKey string = searchService.listAdminKeys().primaryKey

@description('Search query key — use for fn-search-api (read-only, lower privilege)')
output searchQueryKey string = searchService.listQueryKeys().value[0].key

@description('Search service name')
output searchServiceName string = searchService.name