# Local Development Guide

## Prerequisites

Install these before starting:

```bash
# Node.js 18+
node --version   # must be >= 18

# Azure Functions Core Tools v4
npm install -g azure-functions-core-tools@4 --unsafe-perm true
func --version   # must be 4.x

# Azurite (local Storage emulator — replaces Blob, Table, Queue)
npm install -g azurite
azurite --version

# Azure CLI (for deployment and index creation)
az --version
az login
```

Python 3.8+ is needed only if you want to test the Databricks notebook locally:
```bash
pip install pyspark delta-spark
```

---

## Environment Setup

```bash
cd functions
cp local.settings.example.txt .env
```

Open `.env` and fill in the values. For local development most things can stay as defaults — the only values you genuinely need to set are:

| Variable | What to put | Where to get it |
|---|---|---|
| `NEWSAPI_KEY` | Your raw API key | [newsapi.org/register](https://newsapi.org/register) |
| `AZURE_STORAGE_CONNECTION_STRING` | `UseDevelopmentStorage=true` | This is the Azurite default — no change needed |
| `LANGUAGE_ENDPOINT` | Your Language API endpoint | Azure portal → Cognitive Services → Keys and Endpoint |
| `LANGUAGE_API_KEY` | Your Language API key | Same page |
| `OPENAI_ENDPOINT` | Your Azure OpenAI endpoint | Azure portal → Azure OpenAI → Keys and Endpoint |
| `OPENAI_API_KEY` | Your Azure OpenAI key | Same page |
| `SEARCH_ENDPOINT` | Your Search endpoint | Azure portal → AI Search → Overview |
| `SEARCH_API_KEY` | Your Search admin key | Azure portal → AI Search → Keys |

**Note:** Language API, Azure OpenAI, and AI Search have no local emulator. You need real Azure resources for these. Free tiers exist for all three.

---

## Starting the Local Stack

### Step 1: Start Azurite

In a dedicated terminal:

```bash
mkdir -p .azurite
azurite --location .azurite --debug .azurite/debug.log
```

Azurite starts three services:
- Blob: `http://127.0.0.1:10000`
- Queue: `http://127.0.0.1:10001`
- Table: `http://127.0.0.1:10002`

Leave this terminal open. The data persists in `.azurite/` between runs.

### Step 2: Create the Search index (first time only)

```bash
node scripts/create-index.js
```

This is idempotent — safe to re-run. Required before fn-search-api or fn-index-refresh will work.

### Step 3: Start all Azure Functions

In a new terminal:

```bash
cd functions
func start
```

You should see all 6 functions loaded:
```
fn-audit-logger:   eventGridTrigger
fn-enrich:         queueTrigger
fn-hash-url:       [GET,POST] http://localhost:7071/api/fn-hash-url
fn-index-refresh:  [POST] http://localhost:7071/api/fn-index-refresh
fn-nlp-trigger:    eventGridTrigger
fn-search-api:     [GET] http://localhost:7071/api/fn-search-api
```

---

## Testing Each Component

### Test fn-hash-url

```bash
curl -X POST http://localhost:7071/api/fn-hash-url \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.theverge.com/2024/01/15/apple-earnings"}'

# Expected:
# { "urlHash": "e9bca57a5f8d50f4", "url": "https://www.theverge.com/2024/01/15/apple-earnings" }
```

### Simulate a Logic App blob write (trigger the pipeline)

```bash
# Create a sample bronze blob
cat > /tmp/sample-article.json << 'EOF'
{
  "source": { "id": "the-verge", "name": "The Verge" },
  "author": "Jane Doe",
  "title": "Apple reports record quarterly earnings",
  "description": "Apple Inc reported strong Q1 results.",
  "url": "https://www.theverge.com/2024/01/15/apple-earnings",
  "urlToImage": null,
  "publishedAt": "2024-01-15T17:09:12Z",
  "content": "Apple Inc reported record quarterly earnings on Tuesday. [+5204 chars]"
}
EOF

# Write it directly to Azurite (bypasses Logic App for testing)
az storage blob upload \
  --connection-string "UseDevelopmentStorage=true" \
  --container-name articles-bronze \
  --name "technology/$(date +%Y-%m-%d)/test123.json" \
  --file /tmp/sample-article.json \
  --create-container
```

**Note:** Event Grid does not work with Azurite. To test the full Event Grid → fn-nlp-trigger → queue flow locally, use the admin HTTP endpoint to trigger the function manually:

```bash
curl -X POST http://localhost:7071/admin/functions/fn-nlp-trigger \
  -H "Content-Type: application/json" \
  -d '{
    "input": {
      "eventType": "Microsoft.Storage.BlobCreated",
      "subject": "/blobServices/default/containers/articles-bronze/blobs/technology/2024-01-15/test123.json",
      "eventTime": "2024-01-15T02:00:00Z",
      "data": {
        "url": "http://127.0.0.1:10000/devstoreaccount1/articles-bronze/technology/2024-01-15/test123.json",
        "contentLength": 512
      }
    }
  }'
```

### Check the enrichment queue

```bash
az storage queue peek \
  --connection-string "UseDevelopmentStorage=true" \
  --name article-enrich-queue \
  --num-messages 5
```

### fn-enrich will fire automatically when queue depth > 0

Watch the `func start` terminal — you should see:
```
[fn-enrich] Enrichment started { urlHash: 'test123', category: 'technology' }
[fn-enrich] Enrichment complete { nlpStatus: 'ok', vectorStatus: 'ok' }
```

### Check a silver blob was written

```bash
az storage blob list \
  --connection-string "UseDevelopmentStorage=true" \
  --container-name articles-silver \
  --prefix "technology/$(date +%Y-%m-%d)/" \
  --output table
```

### Trigger the index refresh manually

```bash
curl -X POST http://localhost:7071/api/fn-index-refresh \
  -H "Content-Type: application/json" \
  -d "{\"date\": \"$(date +%Y-%m-%d)\", \"category\": \"technology\"}"

# Expected:
# { "date": "...", "processed": 1, "succeeded": 1, "failed": 0, "errors": [] }
```

### Search for the indexed article

```bash
curl "http://localhost:7071/api/fn-search-api?q=Apple+earnings&category=technology"
```

---

## Running Tests

### Jest unit tests (no Azure required)

```bash
cd nlp-pipeline
node_modules/.bin/jest --config functions/jest.config.json
```

### Smoke test — unit mode (no Azure required)

```bash
node scripts/test-pipeline.js
```

### Smoke test — integration mode (requires real Azure credentials in .env)

```bash
node scripts/test-pipeline.js --integration
```

---

## Backfilling Data

If you have bronze blobs without silver counterparts (e.g. fn-enrich was down):

```bash
# Dry run first — see what would be queued
node scripts/backfill-silver.js --date 2024-01-15 --dry-run

# Actually queue them
node scripts/backfill-silver.js --date 2024-01-15

# Date range
node scripts/backfill-silver.js --from 2024-01-01 --to 2024-01-15

# Force re-enrichment even if silver exists
node scripts/backfill-silver.js --date 2024-01-15 --force
```

---

## Common Issues

### `func start` fails with "No functions found"

The Function App looks for `function.json` files in subdirectories. Make sure you're running `func start` from `functions/`, not from the project root.

### Queue trigger doesn't fire locally

Azure Functions Core Tools polls Azurite Storage queues using the connection string in `AzureWebJobsStorage`. Confirm `AzureWebJobsStorage = UseDevelopmentStorage=true` in your `.env` and that Azurite is running.

### `AZURE_STORAGE_CONNECTION_STRING` vs `AzureWebJobsStorage`

Both should be set to `UseDevelopmentStorage=true` locally. `AzureWebJobsStorage` is the Functions runtime requirement. `AZURE_STORAGE_CONNECTION_STRING` is what our shared clients use. They both point to Azurite.

### Language API returns 401

The most common cause is a trailing space or newline in `LANGUAGE_API_KEY`. Check with:
```bash
node -e "console.log('[' + process.env.LANGUAGE_API_KEY + ']')" # must not have whitespace
```

### Search index not found

Run `node scripts/create-index.js` before starting the Function App. The index must exist before `fn-search-api` or `fn-index-refresh` can use it.

### Event Grid trigger won't fire locally

Event Grid is a cloud service and cannot be emulated locally. Use the admin endpoint method described above to trigger `fn-nlp-trigger` and `fn-audit-logger` manually. In a real deployment, Event Grid fires automatically on blob creation.