// storage.bicep
// Provisions all storage resources for the NLP pipeline:
//   - Azure Storage Account (Blob + Table + Queue)
//   - ADLS Gen2 containers: articles-bronze, articles-silver, articles-gold, articles-error
//   - Table Storage tables: articleDedup, articleAudit
//   - Storage Queue: article-enrich-queue
//   - Event Grid system topic on the storage account (for BlobCreated events)

@description('Azure region for all resources')
param location string = resourceGroup().location

@description('Storage account name — must be 3-24 lowercase alphanumeric, globally unique')
param storageAccountName string

@description('Tags to apply to all resources')
param tags object = {
  project:   'nlp-pipeline'
  layer:     'storage'
  managedBy: 'bicep'
}

// ── Storage Account ───────────────────────────────────────────────────────────
// hierarchicalNamespace=true enables ADLS Gen2 on this account
// (bronze/silver/gold containers become ADLS Gen2 filesystems)

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name:     storageAccountName
  location: location
  tags:     tags
  kind:     'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    isHnsEnabled:             true    // ADLS Gen2
    supportsHttpsTrafficOnly: true
    minimumTlsVersion:        'TLS1_2'
    allowBlobPublicAccess:    false
    networkAcls: {
      defaultAction: 'Allow'          // tighten to VNet in production
    }
  }
}

// ── Blob Service ──────────────────────────────────────────────────────────────

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-01-01' = {
  parent: storageAccount
  name:   'default'
  properties: {
    deleteRetentionPolicy: {
      enabled: true
      days:    7
    }
  }
}

// ── Containers ────────────────────────────────────────────────────────────────

var containers = [
  { name: 'articles-bronze', comment: 'Raw NewsAPI article JSON — written by Logic App' }
  { name: 'articles-silver', comment: 'Enriched articles — written by fn-enrich' }
  { name: 'articles-gold',   comment: 'Aggregated outputs — written by Databricks' }
  { name: 'articles-error',  comment: 'Failed enrichment articles for inspection/retry' }
]

resource blobContainers 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = [for c in containers: {
  parent: blobService
  name:   c.name
  properties: {
    publicAccess: 'None'
  }
}]

// ── Table Service + Tables ────────────────────────────────────────────────────

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-01-01' = {
  parent: storageAccount
  name:   'default'
}

resource dedupTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-01-01' = {
  parent: tableService
  name:   'articleDedup'
}

resource auditTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-01-01' = {
  parent: tableService
  name:   'articleAudit'
}

// ── Queue Service + Queue ─────────────────────────────────────────────────────

resource queueService 'Microsoft.Storage/storageAccounts/queueServices@2023-01-01' = {
  parent: storageAccount
  name:   'default'
}

resource enrichQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-01-01' = {
  parent: queueService
  name:   'article-enrich-queue'
  properties: {
    metadata: {}
  }
}

// Poison queue — Azure Storage SDK automatically appends -poison
// Defined explicitly so it's visible in Bicep state
resource poisonQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-01-01' = {
  parent: queueService
  name:   'article-enrich-queue-poison'
  properties: {
    metadata: {}
  }
}

// ── Event Grid System Topic ───────────────────────────────────────────────────
// System topic scoped to the storage account.
// Subscriptions (→ fn-nlp-trigger, → fn-audit-logger) are created in eventgrid.bicep.

resource eventGridTopic 'Microsoft.EventGrid/systemTopics@2022-06-15' = {
  name:     '${storageAccountName}-events'
  location: location
  tags:     tags
  properties: {
    source:    storageAccount.id
    topicType: 'Microsoft.Storage.StorageAccounts'
  }
}

// ── Outputs ───────────────────────────────────────────────────────────────────

@description('Storage account name (used by Logic App storageAccountName param)')
output storageAccountName string = storageAccount.name

@description('Storage account resource ID (used by purview.bicep for role assignments)')
output storageAccountResourceId string = storageAccount.id

@description('Primary blob endpoint')
output blobEndpoint string = storageAccount.properties.primaryEndpoints.blob

@description('Primary ADLS Gen2 DFS endpoint')
output dfsEndpoint string = storageAccount.properties.primaryEndpoints.dfs

@description('Event Grid system topic name (used by eventgrid.bicep)')
output eventGridTopicName string = eventGridTopic.name

@description('Storage account connection string — store in Key Vault, not in app settings directly')
output storageConnectionString string = 'DefaultEndpointsProtocol=https;AccountName=${storageAccount.name};AccountKey=${storageAccount.listKeys().keys[0].value};EndpointSuffix=core.windows.net'