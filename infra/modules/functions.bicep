// functions.bicep
// Provisions the Azure Functions App hosting all 6 pipeline functions:
//   fn-hash-url, fn-nlp-trigger, fn-audit-logger, fn-enrich,
//   fn-index-refresh, fn-search-api
//
// Runtime: Node.js 18, Consumption plan (serverless)
// All sensitive values come from Key Vault references — no plaintext secrets in app settings.

@description('Azure region for all resources')
param location string = resourceGroup().location

@description('Function App name — must be globally unique')
param functionAppName string

@description('Storage account name for AzureWebJobsStorage (Functions runtime requirement)')
param storageAccountName string

@description('Storage account connection string — should be Key Vault reference in production')
@secure()
param storageConnectionString string

@description('Application Insights instrumentation key')
@secure()
param appInsightsInstrumentationKey string

@description('NewsAPI key')
@secure()
param newsApiKey string

@description('Language API endpoint')
param languageEndpoint string

@description('Language API key')
@secure()
param languageApiKey string

@description('Azure OpenAI endpoint')
param openAiEndpoint string

@description('Azure OpenAI key')
@secure()
param openAiApiKey string

@description('OpenAI embedding deployment name')
param openAiEmbeddingDeployment string = 'text-embedding-ada-002'

@description('Azure AI Search endpoint')
param searchEndpoint string

@description('Azure AI Search admin key')
@secure()
param searchApiKey string

@description('Azure AI Search index name')
param searchIndexName string = 'articles'

@description('Comma-separated ingest categories — must match Logic App and Databricks')
param ingestCategories string = 'technology,business,science,health'

@description('Tags to apply to all resources')
param tags object = {
  project:   'nlp-pipeline'
  layer:     'functions'
  managedBy: 'bicep'
}

// ── Consumption Plan ──────────────────────────────────────────────────────────

resource hostingPlan 'Microsoft.Web/serverfarms@2022-09-01' = {
  name:     '${functionAppName}-plan'
  location: location
  tags:     tags
  kind:     'functionapp'
  sku: {
    name: 'Y1'    // Consumption (serverless)
    tier: 'Dynamic'
  }
  properties: {
    reserved: false    // Windows host (Node.js on Windows Functions)
  }
}

// ── Application Insights ──────────────────────────────────────────────────────

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name:     '${functionAppName}-insights'
  location: location
  tags:     tags
  kind:     'web'
  properties: {
    Application_Type: 'web'
    RetentionInDays:  30
  }
}

// ── Function App ──────────────────────────────────────────────────────────────

resource functionApp 'Microsoft.Web/sites@2022-09-01' = {
  name:     functionAppName
  location: location
  tags:     tags
  kind:     'functionapp'
  identity: {
    type: 'SystemAssigned'    // MSI for Storage blob writes from Logic App
  }
  properties: {
    serverFarmId: hostingPlan.id
    siteConfig: {
      nodeVersion:            '~18'
      functionAppScaleLimit:  10
      minimumElasticInstanceCount: 0
      appSettings: [
        // ── Functions runtime ──
        { name: 'FUNCTIONS_WORKER_RUNTIME',        value: 'node' }
        { name: 'FUNCTIONS_EXTENSION_VERSION',     value: '~4' }
        { name: 'WEBSITE_NODE_DEFAULT_VERSION',    value: '~18' }
        { name: 'AzureWebJobsStorage',             value: storageConnectionString }

        // ── Monitoring ──
        { name: 'APPINSIGHTS_INSTRUMENTATIONKEY',  value: appInsightsInstrumentationKey }
        { name: 'ApplicationInsightsAgent_EXTENSION_VERSION', value: '~3' }
        { name: 'LOG_LEVEL',                       value: 'info' }

        // ── Shared config ──
        { name: 'INGEST_CATEGORIES',               value: ingestCategories }

        // ── Storage ──
        { name: 'AZURE_STORAGE_CONNECTION_STRING', value: storageConnectionString }
        { name: 'STORAGE_ACCOUNT_NAME',            value: storageAccountName }
        { name: 'BLOB_CONTAINER_BRONZE',           value: 'articles-bronze' }
        { name: 'BLOB_CONTAINER_SILVER',           value: 'articles-silver' }
        { name: 'ADLS_CONTAINER_GOLD',             value: 'articles-gold' }
        { name: 'TABLE_DEDUP',                     value: 'articleDedup' }
        { name: 'TABLE_AUDIT',                     value: 'articleAudit' }
        { name: 'QUEUE_ENRICH',                    value: 'article-enrich-queue' }

        // ── NewsAPI ──
        { name: 'NEWSAPI_KEY',                     value: newsApiKey }

        // ── Cognitive Services ──
        { name: 'LANGUAGE_ENDPOINT',               value: languageEndpoint }
        { name: 'LANGUAGE_API_KEY',                value: languageApiKey }
        { name: 'LANGUAGE_API_VERSION',            value: '2023-04-01' }

        // ── Azure OpenAI ──
        { name: 'OPENAI_ENDPOINT',                 value: openAiEndpoint }
        { name: 'OPENAI_API_KEY',                  value: openAiApiKey }
        { name: 'OPENAI_EMBEDDING_DEPLOYMENT',     value: openAiEmbeddingDeployment }

        // ── Azure AI Search ──
        { name: 'SEARCH_ENDPOINT',                 value: searchEndpoint }
        { name: 'SEARCH_API_KEY',                  value: searchApiKey }
        { name: 'SEARCH_INDEX_NAME',               value: searchIndexName }
      ]
      cors: {
        allowedOrigins: ['https://portal.azure.com']
        supportCredentials: false
      }
    }
    httpsOnly: true
  }
}

// ── Outputs ───────────────────────────────────────────────────────────────────

@description('Function App name')
output functionAppName string = functionApp.name

@description('Function App default hostname')
output functionAppHostname string = functionApp.properties.defaultHostName

@description('Function App managed identity principal ID — used by Logic App MSI auth to Storage')
output functionAppPrincipalId string = functionApp.identity.principalId

@description('Application Insights instrumentation key')
output appInsightsKey string = appInsights.properties.InstrumentationKey

@description('fn-hash-url base URL — used as Logic App hashFunctionUrl parameter')
output hashFunctionUrl string = 'https://${functionApp.properties.defaultHostName}/api/fn-hash-url'

@description('fn-index-refresh base URL — used in ADF WebActivity')
output indexRefreshUrl string = 'https://${functionApp.properties.defaultHostName}/api/fn-index-refresh'

@description('fn-search-api base URL — used as APIM backend')
output searchApiUrl string = 'https://${functionApp.properties.defaultHostName}/api/fn-search-api'