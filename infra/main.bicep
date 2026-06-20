// main.bicep
// Entry point for the NLP pipeline infrastructure deployment.
// Calls all resource modules in dependency order, wiring outputs to inputs.
//
// Deploy with:
//   az deployment group create \
//     --resource-group <rg> \
//     --template-file infra/main.bicep \
//     --parameters @infra/parameters.json \
//     --parameters newsApiKey=<key> languageApiKey=<key> openAiApiKey=<key> \
//                  searchApiKey=<key> hashFunctionKey=<key> \
//                  searchApiFunctionKey=<key> nlpTriggerFunctionKey=<key> \
//                  auditLoggerFunctionKey=<key> publisherEmail=<email>
//
// DEPLOYMENT ORDER (enforced by dependsOn and output→input wiring):
//   1. storage      → blob containers, tables, queues, Event Grid system topic
//   2. cognitive    → Language API + Azure OpenAI
//   3. search       → Azure AI Search service
//   4. functions    → Function App (all 6 functions)
//   5. eventgrid    → Event Grid subscriptions (needs Function App endpoint)
//   6. logic-app    → Logic App workflow (needs fn-hash-url URL)
//   7. databricks   → Databricks workspace
//   8. apim         → APIM (needs fn-search-api URL)
//   9. purview      → Purview account + role assignments

targetScope = 'resourceGroup'

// ── Global parameters ──────────────────────────────────────────────────────────

@description('Azure region for all resources')
param location string = resourceGroup().location

@description('Tags applied to all resources')
param tags object = {
  project:   'nlp-pipeline'
  managedBy: 'bicep'
}

// ── Resource name parameters ───────────────────────────────────────────────────

param storageAccountName    string
param languageAccountName   string
param openAiAccountName     string
param embeddingDeploymentName string = 'text-embedding-ada-002'
param functionAppName       string
param searchServiceName     string
param workspaceName         string
param logicAppName          string
param apimName              string
param purviewAccountName    string

// ── Config parameters ──────────────────────────────────────────────────────────

param ingestCategories   string = 'technology,business,science,health'
param bronzeContainerName string = 'articles-bronze'
param searchIndexName    string = 'articles'
param skuName            string = 'basic'
param replicaCount       int    = 1
param partitionCount     int    = 1
param pricingTier        string = 'standard'
param tenantId           string
param apiAppIdUri        string
param publisherEmail     string
param publisherName      string = 'NLP Pipeline Team'

// ── Secret parameters (@secure — never logged, never in state file in plaintext)

@secure() param newsApiKey                string
@secure() param languageApiKey            string
@secure() param openAiApiKey              string
@secure() param searchApiKey              string
@secure() param hashFunctionKey           string
@secure() param searchApiFunctionKey      string
@secure() param nlpTriggerFunctionKey     string
@secure() param auditLoggerFunctionKey    string
@secure() param appInsightsInstrumentationKey string = ''

// ── Module: Storage ────────────────────────────────────────────────────────────

module storage 'modules/storage.bicep' = {
  name:   'storage'
  params: {
    location:           location
    storageAccountName: storageAccountName
    tags:               tags
  }
}

// ── Module: Cognitive Services ─────────────────────────────────────────────────

module cognitive 'modules/cognitive.bicep' = {
  name:   'cognitive'
  params: {
    location:               location
    languageAccountName:    languageAccountName
    openAiAccountName:      openAiAccountName
    embeddingDeploymentName: embeddingDeploymentName
    tags:                   tags
  }
}

// ── Module: Search ─────────────────────────────────────────────────────────────

module search 'modules/search.bicep' = {
  name:   'search'
  params: {
    location:          location
    searchServiceName: searchServiceName
    skuName:           skuName
    replicaCount:      replicaCount
    partitionCount:    partitionCount
    tags:              tags
  }
}

// ── Module: Function App ───────────────────────────────────────────────────────
// Depends on: storage (connection string), cognitive (endpoints/keys), search (endpoint/key)

module functions 'modules/functions.bicep' = {
  name:   'functions'
  params: {
    location:                     location
    functionAppName:              functionAppName
    storageAccountName:           storageAccountName
    storageConnectionString:      storage.outputs.storageConnectionString
    appInsightsInstrumentationKey: appInsightsInstrumentationKey
    newsApiKey:                   newsApiKey
    languageEndpoint:             cognitive.outputs.languageEndpoint
    languageApiKey:               languageApiKey
    openAiEndpoint:               cognitive.outputs.openAiEndpoint
    openAiApiKey:                 openAiApiKey
    openAiEmbeddingDeployment:    embeddingDeploymentName
    searchEndpoint:               search.outputs.searchEndpoint
    searchApiKey:                 searchApiKey
    searchIndexName:              searchIndexName
    ingestCategories:             ingestCategories
    tags:                         tags
  }
  dependsOn: [storage, cognitive, search]
}

// ── Module: Event Grid ─────────────────────────────────────────────────────────
// Depends on: storage (system topic), functions (webhook endpoints)

module eventgrid 'modules/eventgrid.bicep' = {
  name:   'eventgrid'
  params: {
    eventGridTopicName:      storage.outputs.eventGridTopicName
    functionAppHostname:     functions.outputs.functionAppHostname
    nlpTriggerFunctionKey:   nlpTriggerFunctionKey
    auditLoggerFunctionKey:  auditLoggerFunctionKey
    bronzeContainerName:     bronzeContainerName
  }
  dependsOn: [storage, functions]
}

// ── Module: Logic App ──────────────────────────────────────────────────────────
// Depends on: storage (account name), functions (fn-hash-url URL)

module logicApp 'modules/logic-app.bicep' = {
  name:   'logic-app'
  params: {
    location:               location
    logicAppName:           logicAppName
    storageAccountName:     storageAccountName
    storageAccountResourceId: storage.outputs.storageAccountResourceId
    newsApiKey:             newsApiKey
    hashFunctionUrl:        functions.outputs.hashFunctionUrl
    hashFunctionKey:        hashFunctionKey
    bronzeContainerName:    bronzeContainerName
    ingestCategories:       ingestCategories
    tags:                   tags
  }
  dependsOn: [storage, functions]
}

// ── Module: Databricks ─────────────────────────────────────────────────────────
// Depends on: storage (account name for ADLS access)

module databricks 'modules/databricks.bicep' = {
  name:   'databricks'
  params: {
    location:                 location
    workspaceName:            workspaceName
    pricingTier:              pricingTier
    storageAccountName:       storageAccountName
    storageAccountResourceId: storage.outputs.storageAccountResourceId
    tags:                     tags
  }
  dependsOn: [storage]
}

// ── Module: APIM ───────────────────────────────────────────────────────────────
// Depends on: functions (fn-search-api URL)

module apim 'modules/apim.bicep' = {
  name:   'apim'
  params: {
    location:               location
    apimName:               apimName
    publisherEmail:         publisherEmail
    publisherName:          publisherName
    searchApiFunctionUrl:   functions.outputs.searchApiUrl
    searchApiFunctionKey:   searchApiFunctionKey
    tenantId:               tenantId
    apiAppIdUri:            apiAppIdUri
    tags:                   tags
  }
  dependsOn: [functions]
}

// ── Module: Purview ────────────────────────────────────────────────────────────
// Depends on: storage (resource ID), search (resource ID)

module purview 'modules/purview.bicep' = {
  name:   'purview'
  params: {
    location:                 location
    purviewAccountName:       purviewAccountName
    storageAccountResourceId: storage.outputs.storageAccountResourceId
    searchServiceResourceId:  search.outputs.searchServiceResourceId
    tags:                     tags
  }
  dependsOn: [storage, search]
}

// ── Outputs ────────────────────────────────────────────────────────────────────

output storageAccountName     string = storage.outputs.storageAccountName
output functionAppHostname    string = functions.outputs.functionAppHostname
output searchEndpoint         string = search.outputs.searchEndpoint
output apimGatewayUrl         string = apim.outputs.apimGatewayUrl
output databricksHost         string = databricks.outputs.databricksHost
output purviewEndpoint        string = purview.outputs.purviewEndpoint
output hashFunctionUrl        string = functions.outputs.hashFunctionUrl
output indexRefreshUrl        string = functions.outputs.indexRefreshUrl
output searchApiEndpoint      string = apim.outputs.searchApiEndpoint
output notebookUploadPath     string = databricks.outputs.notebookPath