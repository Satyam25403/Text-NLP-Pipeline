// cognitive.bicep
// Provisions Azure Cognitive Services resources:
//   - Language API (sentiment, NER, key phrases) — used by fn-enrich
//   - Azure OpenAI (text-embedding-ada-002) — used by fn-enrich and fn-search-api

@description('Azure region for all resources')
param location string = resourceGroup().location

@description('Name for the Language API Cognitive Services account')
param languageAccountName string

@description('Name for the Azure OpenAI account')
param openAiAccountName string

@description('Name of the embedding model deployment (text-embedding-ada-002)')
param embeddingDeploymentName string = 'text-embedding-ada-002'

@description('Tags to apply to all resources')
param tags object = {
  project:   'nlp-pipeline'
  layer:     'cognitive'
  managedBy: 'bicep'
}

// ── Language API ──────────────────────────────────────────────────────────────
// Supports: sentiment analysis, NER, key phrase extraction
// Used by: fn-enrich (languageClient.js)

resource languageAccount 'Microsoft.CognitiveServices/accounts@2023-05-01' = {
  name:     languageAccountName
  location: location
  tags:     tags
  kind:     'TextAnalytics'
  sku: {
    name: 'S'    // Standard tier — free tier (F0) has 5K transactions/month limit
  }
  properties: {
    publicNetworkAccess:   'Enabled'
    disableLocalAuth:      false
    customSubDomainName:   languageAccountName
  }
}

// ── Azure OpenAI ──────────────────────────────────────────────────────────────
// Used by: fn-enrich (openaiClient.js) for content embeddings
//          fn-search-api for query embeddings

resource openAiAccount 'Microsoft.CognitiveServices/accounts@2023-05-01' = {
  name:     openAiAccountName
  location: location
  tags:     tags
  kind:     'OpenAI'
  sku: {
    name: 'S0'
  }
  properties: {
    publicNetworkAccess: 'Enabled'
    disableLocalAuth:    false
    customSubDomainName: openAiAccountName
  }
}

// ── Embedding model deployment ────────────────────────────────────────────────
// text-embedding-ada-002: 1536 dimensions, cosine similarity
// Matches SEARCH_EMBEDDING_DEPLOYMENT env var and HNSW index config

resource embeddingDeployment 'Microsoft.CognitiveServices/accounts/deployments@2023-05-01' = {
  parent: openAiAccount
  name:   embeddingDeploymentName
  sku: {
    name:     'Standard'
    capacity: 120    // 120K tokens per minute — sufficient for 1,600 articles/day
  }
  properties: {
    model: {
      format:  'OpenAI'
      name:    'text-embedding-ada-002'
      version: '2'
    }
    versionUpgradeOption: 'OnceCurrentVersionExpired'
  }
}

// ── Outputs ───────────────────────────────────────────────────────────────────

@description('Language API endpoint — set as LANGUAGE_ENDPOINT env var')
output languageEndpoint string = languageAccount.properties.endpoint

@description('Language API key — store in Key Vault')
output languageApiKey string = languageAccount.listKeys().key1

@description('Azure OpenAI endpoint — set as OPENAI_ENDPOINT env var')
output openAiEndpoint string = openAiAccount.properties.endpoint

@description('Azure OpenAI key — store in Key Vault')
output openAiApiKey string = openAiAccount.listKeys().key1

@description('Embedding deployment name — set as OPENAI_EMBEDDING_DEPLOYMENT env var')
output embeddingDeploymentName string = embeddingDeployment.name