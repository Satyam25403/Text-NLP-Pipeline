# Deployment Guide

## Prerequisites

```bash
# Azure CLI authenticated
az login
az account set --subscription "<your-subscription-id>"

# Create resource group
az group create --name nlp-pipeline-rg --location eastus

# Node.js 18+ and Azure Functions Core Tools v4
node --version   # >= 18
func --version   # >= 4
```

---

## Configuration

Before deploying, update `infra/parameters.json`:

1. Replace all `<placeholder>` values with your actual resource names
2. Set `publisherEmail` to your real email address
3. Set `tenantId` to your Azure AD tenant ID
4. Set `apiAppIdUri` — see "Create App Registration" below

### Create App Registration (for APIM JWT validation)

```bash
# Create app registration for the Search API
az ad app create \
  --display-name "nlp-pipeline-search-api" \
  --sign-in-audience AzureADMyOrg

# Get the app ID
APP_ID=$(az ad app list --display-name "nlp-pipeline-search-api" --query "[0].appId" -o tsv)

# Set the App ID URI
az ad app update --id $APP_ID --identifier-uris "api://$APP_ID"

echo "apiAppIdUri: api://$APP_ID"
echo "tenantId: $(az account show --query tenantId -o tsv)"
```

---

## Deployment Order

Resources must be deployed in this order because each step depends on outputs from previous steps.

### Step 1: Core infrastructure (one command)

```bash
az deployment group create \
  --resource-group nlp-pipeline-rg \
  --template-file infra/main.bicep \
  --parameters @infra/parameters.json \
  --parameters \
    newsApiKey="<your-newsapi-key>" \
    languageApiKey="<your-language-key>" \
    openAiApiKey="<your-openai-key>" \
    searchApiKey="<your-search-admin-key>" \
    hashFunctionKey="placeholder" \
    searchApiFunctionKey="placeholder" \
    nlpTriggerFunctionKey="placeholder" \
    auditLoggerFunctionKey="placeholder" \
    publisherEmail="<your-email>" \
    tenantId="<your-tenant-id>" \
    apiAppIdUri="api://<your-app-id>"
```

Note: Function keys are set to `"placeholder"` on first deploy because they don't exist yet. You'll update them in Step 4.

### Step 2: Deploy Function App code

```bash
cd functions
func azure functionapp publish <functionAppName> --node
cd ..
```

### Step 3: Get function keys

```bash
# Get all function keys
FUNCTION_APP="<your-function-app-name>"
RG="nlp-pipeline-rg"

HASH_KEY=$(az functionapp function keys list \
  --name $FUNCTION_APP -g $RG \
  --function-name fn-hash-url \
  --query "default" -o tsv)

SEARCH_KEY=$(az functionapp function keys list \
  --name $FUNCTION_APP -g $RG \
  --function-name fn-search-api \
  --query "default" -o tsv)

NLP_TRIGGER_KEY=$(az functionapp function keys list \
  --name $FUNCTION_APP -g $RG \
  --function-name fn-nlp-trigger \
  --query "default" -o tsv)

AUDIT_KEY=$(az functionapp function keys list \
  --name $FUNCTION_APP -g $RG \
  --function-name fn-audit-logger \
  --query "default" -o tsv)

echo "Hash key:         $HASH_KEY"
echo "Search API key:   $SEARCH_KEY"
echo "NLP trigger key:  $NLP_TRIGGER_KEY"
echo "Audit logger key: $AUDIT_KEY"
```

### Step 4: Re-deploy with real function keys

```bash
az deployment group create \
  --resource-group nlp-pipeline-rg \
  --template-file infra/main.bicep \
  --parameters @infra/parameters.json \
  --parameters \
    newsApiKey="<newsapi-key>" \
    languageApiKey="<language-key>" \
    openAiApiKey="<openai-key>" \
    searchApiKey="<search-admin-key>" \
    hashFunctionKey="$HASH_KEY" \
    searchApiFunctionKey="$SEARCH_KEY" \
    nlpTriggerFunctionKey="$NLP_TRIGGER_KEY" \
    auditLoggerFunctionKey="$AUDIT_KEY" \
    publisherEmail="<your-email>" \
    tenantId="<tenant-id>" \
    apiAppIdUri="api://<app-id>"
```

### Step 5: Create the Search index

```bash
# Set env vars from deployment outputs
SEARCH_ENDPOINT=$(az deployment group show \
  --resource-group nlp-pipeline-rg \
  --name main \
  --query "properties.outputs.searchEndpoint.value" -o tsv)

export SEARCH_ENDPOINT
export SEARCH_API_KEY="<your-search-admin-key>"
export SEARCH_INDEX_NAME="articles"

node scripts/create-index.js
```

Expected output:
```
Index created/updated successfully
  Name   : articles
  Fields : 12
  Vector profiles : 1
  Semantic configs: 1
  Scoring profiles: 1
```

### Step 6: Deploy ADF artifacts

```bash
ADF_NAME="<your-adf-factory-name>"
RG="nlp-pipeline-rg"

# Get fn-index-refresh URL from deployment output
INDEX_URL=$(az deployment group show \
  --resource-group $RG --name main \
  --query "properties.outputs.indexRefreshUrl.value" -o tsv)

# Update the pipeline JSON with actual values
# (replace <fn-app> and parameter defaults in pipeline_nlp_nightly.json
#  with your actual Function App hostname and ADLS paths)

# Deploy in dependency order: dataset → pipeline → trigger
az datafactory dataset create \
  --factory-name $ADF_NAME -g $RG \
  --dataset-name SilverContainerDataset \
  --properties @infra/adf/dataset_silver_container.json

az datafactory pipeline create \
  --factory-name $ADF_NAME -g $RG \
  --pipeline-name nlp_pipeline_nightly \
  --pipeline @infra/adf/pipeline_nlp_nightly.json

az datafactory trigger create \
  --factory-name $ADF_NAME -g $RG \
  --trigger-name NightlyScheduleTrigger \
  --properties @infra/adf/trigger_nightly_schedule.json

# Start the trigger (it won't fire until started)
az datafactory trigger start \
  --factory-name $ADF_NAME -g $RG \
  --trigger-name NightlyScheduleTrigger
```

### Step 7: Upload Databricks notebook

```bash
DATABRICKS_HOST=$(az deployment group show \
  --resource-group nlp-pipeline-rg --name main \
  --query "properties.outputs.databricksHost.value" -o tsv)

# Install Databricks CLI
pip install databricks-cli

# Configure
databricks configure --host $DATABRICKS_HOST --token

# Create workspace directory and upload
databricks workspace mkdirs /Shared/nlp-pipeline
databricks workspace import databricks/gold_aggregation.py \
  /Shared/nlp-pipeline/gold_aggregation \
  --language PYTHON --overwrite

databricks workspace import databricks/utils/delta_helpers.py \
  /Shared/nlp-pipeline/utils/delta_helpers \
  --language PYTHON --overwrite
```

### Step 8: Import Purview classification rules and configure scans

```bash
PURVIEW_ENDPOINT=$(az deployment group show \
  --resource-group nlp-pipeline-rg --name main \
  --query "properties.outputs.purviewEndpoint.value" -o tsv)

# Register lineage for custom functions (not auto-detected by Purview)
export PURVIEW_ENDPOINT
export PURVIEW_CLIENT_ID="<app-client-id>"
export PURVIEW_CLIENT_SECRET="<app-client-secret>"
export PURVIEW_TENANT_ID="<tenant-id>"
export STORAGE_ACCOUNT_NAME="<storage-account-name>"
export SEARCH_SERVICE_NAME="<search-service-name>"

node scripts/register-purview-lineage.js
```

For classification rules and scan configuration, import via Purview portal:
- Portal → Data Map → Classifications → New Classification Rule
- Import each rule from `purview/classification-rules.json`
- Portal → Data Map → Sources → Register each source from `purview/scan-config.json`

### Step 9: End-to-end smoke test

```bash
# Set env vars
export NEWSAPI_KEY="<your-newsapi-key>"
export AZURE_STORAGE_CONNECTION_STRING="<your-conn-string>"
export LANGUAGE_ENDPOINT="<language-endpoint>"
export LANGUAGE_API_KEY="<language-key>"
export OPENAI_ENDPOINT="<openai-endpoint>"
export OPENAI_API_KEY="<openai-key>"
export SEARCH_ENDPOINT="<search-endpoint>"
export SEARCH_API_KEY="<search-key>"

node scripts/test-pipeline.js --integration
```

All 92 assertions should pass.

---

## Key Vault Integration (Production)

For production, store all secrets in Azure Key Vault and reference them in the Function App settings instead of passing plaintext:

```bash
# Create Key Vault
az keyvault create --name nlp-pipeline-kv -g nlp-pipeline-rg --location eastus

# Store secrets
az keyvault secret set --vault-name nlp-pipeline-kv --name newsapi-key --value "<key>"
az keyvault secret set --vault-name nlp-pipeline-kv --name language-api-key --value "<key>"
az keyvault secret set --vault-name nlp-pipeline-kv --name openai-api-key --value "<key>"
az keyvault secret set --vault-name nlp-pipeline-kv --name search-api-key --value "<key>"

# Grant Function App MSI access to Key Vault
FUNCTION_PRINCIPAL=$(az functionapp identity show \
  --name <function-app-name> -g nlp-pipeline-rg \
  --query principalId -o tsv)

az keyvault set-policy --name nlp-pipeline-kv \
  --object-id $FUNCTION_PRINCIPAL \
  --secret-permissions get list

# Reference in Function App settings (replaces plaintext values)
az functionapp config appsettings set \
  --name <function-app-name> -g nlp-pipeline-rg \
  --settings \
  "NEWSAPI_KEY=@Microsoft.KeyVault(VaultName=nlp-pipeline-kv;SecretName=newsapi-key)" \
  "LANGUAGE_API_KEY=@Microsoft.KeyVault(VaultName=nlp-pipeline-kv;SecretName=language-api-key)"
```

---

## Zero-Downtime Index Updates

When you need to make breaking changes to the Search index schema (field type changes, removing fields, changing analyzers):

```bash
# 1. Create new versioned index
SEARCH_INDEX_NAME="articles-v2" node scripts/create-index.js

# 2. Backfill the new index
curl -X POST https://<fn-app>.azurewebsites.net/api/fn-index-refresh \
  -d '{"date": "2024-01-15", "category": "technology"}'
# (repeat for all dates and categories)

# 3. Swap alias atomically
node scripts/create-search-alias.js --alias articles --target articles-v2

# 4. All clients using the "articles" alias now see articles-v2
# 5. Delete old index when confident
az search index delete --service-name <search> -g nlp-pipeline-rg \
  --index-name articles-v1 --yes
```

---

## Monitoring Setup

### Application Insights alerts

```bash
# Alert on fn-enrich error rate > 5%
az monitor metrics alert create \
  --name "fn-enrich-error-rate" \
  -g nlp-pipeline-rg \
  --scopes "<app-insights-resource-id>" \
  --condition "count exceptions/count > 50" \
  --window-size 5m \
  --evaluation-frequency 1m \
  --action "<action-group-id>"
```

### ADF pipeline failure alert

In Azure portal → Data Factory → Monitor → Alerts → New alert rule:
- Metric: `PipelineFailedRuns`
- Condition: Count > 0
- Action: Email notification

### Queue depth alert

```bash
az monitor metrics alert create \
  --name "enrich-queue-depth" \
  -g nlp-pipeline-rg \
  --scopes "<storage-account-resource-id>" \
  --condition "avg ApproximateMessageCount > 500" \
  --window-size 15m \
  --evaluation-frequency 5m
```