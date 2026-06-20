// apim.bicep
// Provisions Azure API Management in front of fn-search-api.
//
// Creates:
//   - APIM instance (Consumption tier — serverless, pay-per-call)
//   - API: nlp-search (backed by fn-search-api Function)
//   - Operation: GET /search
//   - Inbound policy: JWT validation + rate limiting (from apim/inbound-policy.xml)
//   - Outbound policy: response caching (from apim/outbound-policy.xml)
//
// Consumption tier has no VNet support and no built-in cache.
// For the outbound caching policy, either upgrade to Developer+ tier
// or use an external Redis cache (not provisioned here).

@description('Azure region')
param location string = resourceGroup().location

@description('APIM instance name — must be globally unique')
param apimName string

@description('Publisher email address (required by APIM)')
param publisherEmail string

@description('Publisher organisation name')
param publisherName string = 'NLP Pipeline'

@description('fn-search-api URL — output from functions.bicep')
param searchApiFunctionUrl string

@description('fn-search-api function key for APIM backend auth')
@secure()
param searchApiFunctionKey string

@description('Azure AD tenant ID for JWT validation in inbound policy')
param tenantId string

@description('Azure AD application ID URI for JWT audience validation')
param apiAppIdUri string

@description('Tags')
param tags object = {
  project:   'nlp-pipeline'
  layer:     'api-serving'
  managedBy: 'bicep'
}

// ── APIM Instance ─────────────────────────────────────────────────────────────

resource apim 'Microsoft.ApiManagement/service@2022-08-01' = {
  name:     apimName
  location: location
  tags:     tags
  sku: {
    name:     'Consumption'
    capacity: 0    // Consumption tier uses 0 capacity units
  }
  properties: {
    publisherEmail: publisherEmail
    publisherName:  publisherName
  }
}

// ── Named Values (non-secret config referenced in policies) ───────────────────

resource tenantIdNamedValue 'Microsoft.ApiManagement/service/namedValues@2022-08-01' = {
  parent: apim
  name:   'tenant-id'
  properties: {
    displayName: 'tenant-id'
    value:       tenantId
    secret:      false
  }
}

resource apiAppIdUriNamedValue 'Microsoft.ApiManagement/service/namedValues@2022-08-01' = {
  parent: apim
  name:   'api-app-id-uri'
  properties: {
    displayName: 'api-app-id-uri'
    value:       apiAppIdUri
    secret:      false
  }
}

resource functionKeyNamedValue 'Microsoft.ApiManagement/service/namedValues@2022-08-01' = {
  parent: apim
  name:   'search-api-function-key'
  properties: {
    displayName: 'search-api-function-key'
    value:       searchApiFunctionKey
    secret:      true    // stored as secret in APIM key vault
  }
}

// ── Backend: fn-search-api ────────────────────────────────────────────────────

resource searchApiBackend 'Microsoft.ApiManagement/service/backends@2022-08-01' = {
  parent: apim
  name:   'fn-search-api-backend'
  properties: {
    description: 'fn-search-api Azure Function'
    url:          searchApiFunctionUrl
    protocol:     'http'
    credentials: {
      query: {
        code: [searchApiFunctionKey]
      }
    }
  }
}

// ── API Definition ────────────────────────────────────────────────────────────

resource nlpSearchApi 'Microsoft.ApiManagement/service/apis@2022-08-01' = {
  parent: apim
  name:   'nlp-search'
  properties: {
    displayName:          'NLP Search API'
    description:          'Hybrid semantic search over enriched news articles'
    path:                 'search'
    protocols:            ['https']
    subscriptionRequired: true
    subscriptionKeyParameterNames: {
      header: 'Ocp-Apim-Subscription-Key'
      query:  'subscription-key'
    }
    apiType: 'http'
  }
}

// ── GET /search Operation ─────────────────────────────────────────────────────

resource searchOperation 'Microsoft.ApiManagement/service/apis/operations@2022-08-01' = {
  parent: nlpSearchApi
  name:   'get-search'
  properties: {
    displayName: 'Search articles'
    method:      'GET'
    urlTemplate: '/'
    description: 'Hybrid BM25 + vector search with optional semantic reranking'
    request: {
      queryParameters: [
        { name: 'q',         required: true,  type: 'string',  description: 'Search query (max 500 chars)' }
        { name: 'top',       required: false, type: 'integer', description: 'Results to return (max 50, default 10)' }
        { name: 'category',  required: false, type: 'string',  description: 'Filter: technology|business|science|health' }
        { name: 'source',    required: false, type: 'string',  description: 'Filter: exact source name' }
        { name: 'sentiment', required: false, type: 'string',  description: 'Filter: positive|negative|neutral|mixed' }
        { name: 'semantic',  required: false, type: 'boolean', description: 'Enable semantic reranker (default false)' }
        { name: 'vector',    required: false, type: 'boolean', description: 'Enable vector search (default true)' }
        { name: 'from',      required: false, type: 'string',  description: 'Date lower bound YYYY-MM-DD' }
        { name: 'to',        required: false, type: 'string',  description: 'Date upper bound YYYY-MM-DD' }
      ]
    }
    responses: [
      { statusCode: 200, description: 'Search results with facets and metadata' }
      { statusCode: 400, description: 'Invalid query parameters' }
      { statusCode: 401, description: 'Unauthorized — invalid or missing Bearer token' }
      { statusCode: 429, description: 'Rate limit exceeded' }
      { statusCode: 500, description: 'Search service unavailable' }
    ]
  }
}

// ── Inbound Policy: JWT validation + rate limiting ────────────────────────────

resource apiInboundPolicy 'Microsoft.ApiManagement/service/apis/policies@2022-08-01' = {
  parent: nlpSearchApi
  name:   'policy'
  properties: {
    format: 'rawxml'
    value:  loadTextContent('../../apim/inbound-policy.xml')
  }
}

// ── Operation-level Outbound Policy: response caching ────────────────────────

resource operationOutboundPolicy 'Microsoft.ApiManagement/service/apis/operations/policies@2022-08-01' = {
  parent: searchOperation
  name:   'policy'
  properties: {
    format: 'rawxml'
    value:  loadTextContent('../../apim/outbound-policy.xml')
  }
}

// ── Outputs ───────────────────────────────────────────────────────────────────

@description('APIM gateway URL — the public endpoint for API consumers')
output apimGatewayUrl string = apim.properties.gatewayUrl

@description('APIM portal URL — for developer portal')
output apimPortalUrl string = apim.properties.developerPortalUrl

@description('APIM instance name')
output apimName string = apim.name

@description('Full search API endpoint')
output searchApiEndpoint string = '${apim.properties.gatewayUrl}/search'