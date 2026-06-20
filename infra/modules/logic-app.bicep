// logic-app.bicep
// Deploys the Logic App that polls NewsAPI every 6 hours and writes
// individual article blobs to the bronze container.
//
// The workflow definition lives in logic-app/workflow.json.
// Parameters are injected at deploy time — no secrets in the workflow file.
//
// MSI: the Logic App uses the Function App's MSI (or its own) to write blobs.
// For simplicity, this module grants the Logic App's own MSI Storage Blob Data Contributor.

@description('Azure region')
param location string = resourceGroup().location

@description('Logic App name')
param logicAppName string

@description('Storage account name — used to build blob URLs in the workflow')
param storageAccountName string

@description('Storage account resource ID — for role assignment')
param storageAccountResourceId string

@description('NewsAPI key — raw value, no prefix')
@secure()
param newsApiKey string

@description('URL of fn-hash-url function')
param hashFunctionUrl string

@description('Function key for fn-hash-url')
@secure()
param hashFunctionKey string

@description('Bronze container name')
param bronzeContainerName string = 'articles-bronze'

@description('Comma-separated categories to ingest')
param ingestCategories string = 'technology,business,science,health'

@description('Tags')
param tags object = {
  project:   'nlp-pipeline'
  layer:     'ingestion'
  managedBy: 'bicep'
}

// ── Logic App ─────────────────────────────────────────────────────────────────

resource logicApp 'Microsoft.Logic/workflows@2019-05-01' = {
  name:     logicAppName
  location: location
  tags:     tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    state: 'Enabled'
    definition: loadJsonContent('../../logic-app/workflow.json')
    parameters: {
      newsApiKey: {
        value: newsApiKey
      }
      storageAccountName: {
        value: storageAccountName
      }
      bronzeContainer: {
        value: bronzeContainerName
      }
      ingestCategories: {
        value: ingestCategories
      }
      hashFunctionUrl: {
        value: hashFunctionUrl
      }
      hashFunctionKey: {
        value: hashFunctionKey
      }
    }
  }
}

// ── Role assignment: Logic App MSI → Storage Blob Data Contributor ────────────
// Allows the Logic App to write blobs via MSI (no connection string needed in workflow)

resource logicAppStorageRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: resourceGroup()
  name:  guid(storageAccountResourceId, logicApp.id, 'StorageBlobDataContributor')
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      'ba92f5b4-2d11-453d-a403-e96b0029c9fe'    // Storage Blob Data Contributor
    )
    principalId:   logicApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// ── Outputs ───────────────────────────────────────────────────────────────────

@description('Logic App name')
output logicAppName string = logicApp.name

@description('Logic App callback URL (trigger endpoint)')
output logicAppCallbackUrl string = listCallbackUrl('${logicApp.id}/triggers/Every_6_hours', '2019-05-01').value

@description('Logic App managed identity principal ID')
output logicAppPrincipalId string = logicApp.identity.principalId