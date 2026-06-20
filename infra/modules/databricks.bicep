// databricks.bicep
// Provisions an Azure Databricks workspace for the nightly gold aggregation notebook.
//
// The PySpark notebook (databricks/gold_aggregation.py) is NOT deployed here —
// upload it manually to /Shared/nlp-pipeline/ in the workspace, or use the
// Databricks REST API / CLI in your CI/CD pipeline.
//
// ADF calls this via a DatabricksNotebook activity in the nightly pipeline.
// The notebook reads from ADLS Gen2 (silver) and writes to ADLS Gen2 (gold).

@description('Azure region')
param location string = resourceGroup().location

@description('Databricks workspace name')
param workspaceName string

@description('Pricing tier: standard | premium')
@allowed(['standard', 'premium'])
param pricingTier string = 'standard'

@description('Storage account name — Databricks needs access to read silver and write gold')
param storageAccountName string

@description('Storage account resource ID — for role assignment')
param storageAccountResourceId string

@description('Tags')
param tags object = {
  project:   'nlp-pipeline'
  layer:     'batch-orchestration'
  managedBy: 'bicep'
}

// ── Managed Resource Group ────────────────────────────────────────────────────
// Databricks creates its own managed resource group for cluster VMs etc.
var managedResourceGroupName = '${workspaceName}-managed-rg'
var managedResourceGroupId   = '${subscription().id}/resourceGroups/${managedResourceGroupName}'

// ── Databricks Workspace ──────────────────────────────────────────────────────

resource databricksWorkspace 'Microsoft.Databricks/workspaces@2023-02-01' = {
  name:     workspaceName
  location: location
  tags:     tags
  sku: {
    name: pricingTier
  }
  properties: {
    managedResourceGroupId: managedResourceGroupId
    parameters: {
      enableNoPublicIp: {
        value: false    // set true for VNet-injected workspaces in production
      }
    }
  }
}

// ── Role assignment: Databricks MSI → Storage Blob Data Contributor ───────────
// Allows the Databricks cluster to read silver and write gold via ADLS Gen2
// using credential passthrough or service principal auth.
//
// Note: in practice you may use a Databricks secret scope backed by Key Vault
// with a service principal. This role assignment covers the simpler MSI approach.

resource databricksStorageRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: resourceGroup()
  name:  guid(storageAccountResourceId, databricksWorkspace.id, 'StorageBlobDataContributor')
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      'ba92f5b4-2d11-453d-a403-e96b0029c9fe'    // Storage Blob Data Contributor
    )
    principalId:   databricksWorkspace.properties.managedDisk.managedIdentity.principalId
    principalType: 'ServicePrincipal'
  }
}

// ── Outputs ───────────────────────────────────────────────────────────────────

@description('Databricks workspace URL — set as DATABRICKS_HOST env var')
output databricksHost string = 'https://${databricksWorkspace.properties.workspaceUrl}'

@description('Databricks workspace resource ID')
output workspaceResourceId string = databricksWorkspace.id

@description('Databricks workspace ID (numeric)')
output workspaceId string = databricksWorkspace.properties.workspaceId

@description('Notebook upload path — upload databricks/gold_aggregation.py here')
output notebookPath string = '/Shared/nlp-pipeline/gold_aggregation'