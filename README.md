# Text NLP Pipeline

Ingests news articles from NewsAPI, enriches them with sentiment analysis, named entity recognition, and vector embeddings, indexes them for hybrid semantic search in Azure AI Search, and serves a search API to consumers.

---

## Architecture Overview

```
NewsAPI (top-headlines, every 6h)
    │
    ▼
Logic App ──► fn-hash-url (SHA-256 URL dedup key)
    │
    ▼
Blob Storage: articles-bronze/{category}/{date}/{urlHash}.json
    │
    ▼ BlobCreated (Event Grid)
    ├──► fn-nlp-trigger  → Storage Queue (article-enrich-queue)
    └──► fn-audit-logger → Table Storage (articleAudit)
              │
              ▼
         fn-enrich (Queue trigger)
              ├── Azure Cognitive Services Language API
              │   └── sentiment + NER + key phrases
              ├── Azure OpenAI (text-embedding-ada-002)
              │   └── 1536-dim content vector
              └── ADLS Gen2: articles-silver/{category}/{date}/{urlHash}.json
                       │
                       ▼ ADF nightly pipeline (02:00 UTC)
                       ├── Databricks notebook → gold aggregations
                       │   ├── sentiment_trends (7-day rolling)
                       │   ├── top_entities (per week)
                       │   └── trending_keywords (3-day rolling)
                       └── fn-index-refresh → Azure AI Search
                                                    │
                                                    ▼
                                              APIM (JWT + rate limit + cache)
                                                    │
                                                    ▼
                                              fn-search-api
                                              (hybrid BM25 + HNSW + optional semantic reranker)
```

**Six layers:**

| Layer | What it does |
|---|---|
| 1 — Ingestion | Logic App polls NewsAPI every 6h, writes individual article blobs to bronze |
| 2 — NLP Enrichment | Azure Function reads bronze, calls Language API + OpenAI in parallel, writes silver |
| 3 — Batch Orchestration | ADF nightly pipeline: silver completeness check → Databricks gold → Search index refresh |
| 4 — Indexing | Azure AI Search hybrid index: BM25 keyword + HNSW vector, semantic reranker optional |
| 5 — API Serving | fn-search-api behind APIM: JWT auth, rate limiting, 60s response caching |
| 6 — Governance | Microsoft Purview: lineage graph, PII flagging via custom classification |

---

## Architecture Decision Record

### ADR-001: Logic App over ADF HTTP for ingestion
Logic Apps natively support HTTP connectors, schedule triggers, and blob writes. ADF is designed for bulk data movement, not API polling. Logic Apps also integrate directly with Event Grid.

### ADR-002: Event Grid over Event Hub for fan-out
Event Grid is push-based and designed for blob events (`BlobCreated`). Event Hub is pull-based and optimised for high-throughput streaming. Our volume (~1,600 articles/day) is far below Event Hub thresholds.

### ADR-003: URL hash as dedup key
`SHA-256(url)[0:16]` is the stable dedup key. Logic Apps have no native SHA-256 — `fn-hash-url` fills this gap. The hash becomes the blob filename, Table Storage dedup key, and Search document `id`. Collision probability at our volume: negligible.

### ADR-004: Queue trigger for enrichment (not direct Event Grid)
Event Grid → `fn-nlp-trigger` decouples arrival from processing. The queue absorbs bursts, enables per-article retry, and separates routing logic from enrichment logic. `maxDequeueCount: 5` before poison queue.

### ADR-005: Language API + OpenAI in parallel
`Promise.all()` in `fn-enrich` — the two calls are independent. Parallel execution halves enrichment latency at no cost.

### ADR-006: Databricks for gold aggregation
Delta Lake `MERGE` semantics make nightly aggregation idempotent. Rolling window aggregations (7-day sentiment, 3-day keywords) are native Spark operations. MLflow is built-in for embedding version tracking.

### ADR-007: Hybrid BM25 + HNSW with RRF
Pure vector search misses exact-match queries (e.g. "Apple Inc Q3"). Pure keyword misses semantic similarity. Reciprocal Rank Fusion merges both ranked lists without score normalisation. Over-fetch `kNN = max(top×2, 50)` gives RRF enough candidates.

### ADR-008: `defaultScoringProfile` removed from Search schema
The semantic cross-encoder re-scores the top-50 BM25+vector candidates. If a freshness boost fires globally before this window is built, fresh-but-irrelevant articles crowd out semantically-matched older ones. `scoringProfile: 'recency-boost'` is now passed explicitly in `searchClient.js` only when `semantic === false`.

### ADR-009: APIM as auth boundary
Azure Functions are `authLevel: anonymous` — APIM handles JWT validation (OAuth 2.0 client credentials), rate limiting (100 req/min/subscription), and response caching (60s TTL). The JWT is stripped before forwarding to the Function.

### ADR-010: Content stored in ADLS, not Search
AI Search storage is expensive and not designed for blob storage. The Search index holds metadata + vectors. Full article body stays in ADLS, referenced by URL.

---

## Project Structure

```
nlp-pipeline/
├── functions/                    # Azure Functions App (Node.js 18+)
│   ├── host.json                 # Runtime config (timeout, queue batch size)
│   ├── package.json
│   ├── shared/                   # Shared SDK wrappers — imported by all functions
│   │   ├── config.js             # Single source of truth: categories, containers, queues
│   │   ├── logger.js             # Structured JSON logger (Application Insights)
│   │   ├── blobClient.js         # Bronze/silver/error blob read/write
│   │   ├── tableClient.js        # Dedup table + audit log
│   │   ├── queueClient.js        # Enrichment queue enqueue/peek
│   │   ├── languageClient.js     # Cognitive Services Language API (batch 10)
│   │   ├── openaiClient.js       # Azure OpenAI ada-002 embeddings (retry 3×)
│   │   └── searchClient.js       # AI Search upsert + hybrid query
│   ├── fn-hash-url/              # HTTP: computes SHA-256(url)[0:16] for Logic App
│   ├── fn-nlp-trigger/           # Event Grid: dedup check → enqueue article
│   ├── fn-audit-logger/          # Event Grid: write immutable audit record
│   ├── fn-enrich/                # Queue: NLP enrichment + embedding → silver
│   ├── fn-index-refresh/         # HTTP (called by ADF): silver → Search upsert
│   └── fn-search-api/            # HTTP GET: hybrid search endpoint (behind APIM)
├── logic-app/
│   ├── workflow.json             # Logic App: polls NewsAPI, writes bronze blobs
│   └── README.md                 # Logic App deployment guide
├── databricks/
│   └── gold_aggregation.py       # PySpark notebook: silver → gold aggregations
├── search/
│   └── index-schema.json         # AI Search index: 12 fields, HNSW, semantic config
├── infra/
│   ├── modules/                  # Bicep resource provisioning (one file per resource)
│   └── adf/                      # ADF pipeline + dataset + trigger JSON definitions
│       ├── pipeline_nlp_nightly.json
│       ├── dataset_silver_container.json
│       └── trigger_nightly_schedule.json
├── apim/
│   ├── inbound-policy.xml        # JWT validation + rate limiting
│   └── outbound-policy.xml       # Response caching + CORS
├── purview/
│   ├── classification-rules.json # PII custom classification
│   └── scan-config.json
└── scripts/
    ├── create-index.js           # Idempotent AI Search index deploy
    ├── create-search-alias.js    # Zero-downtime index swap via alias
    ├── schemaUtils.js            # stripComments (used by create-index.js)
    └── test-pipeline.js          # End-to-end smoke test (unit + integration modes)
```

---

## Prerequisites

- Node.js 18+
- Azure CLI (`az`) authenticated to your subscription
- Azure Functions Core Tools v4 (`npm install -g azure-functions-core-tools@4`)
- Azurite (local Storage emulator): `npm install -g azurite`
- Python 3.8+ (for Databricks notebook local testing only)
- A NewsAPI key from [newsapi.org](https://newsapi.org) (free tier works)

---

## Environment Setup

```bash
cd functions
cp local.settings.example.txt .env
# Fill in all values — see comments in the file
```

Required variables:

| Variable | Description |
|---|---|
| `NEWSAPI_KEY` | Raw key from newsapi.org — no prefix, no whitespace |
| `AZURE_STORAGE_CONNECTION_STRING` | `UseDevelopmentStorage=true` for local, real conn string for Azure |
| `LANGUAGE_ENDPOINT` | Cognitive Services Language API endpoint |
| `LANGUAGE_API_KEY` | Language API key |
| `OPENAI_ENDPOINT` | Azure OpenAI endpoint |
| `OPENAI_API_KEY` | Azure OpenAI key |
| `OPENAI_EMBEDDING_DEPLOYMENT` | Deployment name (default: `text-embedding-ada-002`) |
| `SEARCH_ENDPOINT` | Azure AI Search endpoint |
| `SEARCH_API_KEY` | Search admin key (for index create/refresh) |
| `SEARCH_INDEX_NAME` | Index name (default: `articles`) |
| `INGEST_CATEGORIES` | Comma-separated categories (default: `technology,business,science,health`) |

---

## Local Development

### 1. Start Azurite (local Storage emulator)

```bash
azurite --location .azurite --debug .azurite/debug.log
```

### 2. Create the Search index

```bash
# Requires SEARCH_ENDPOINT and SEARCH_API_KEY in functions/.env
node scripts/create-index.js
```

### 3. Start all Azure Functions

```bash
cd functions
func start
```

Functions loaded:
- `fn-hash-url` → `POST http://localhost:7071/api/fn-hash-url`
- `fn-nlp-trigger` → Event Grid trigger (test via HTTP POST to admin endpoint)
- `fn-audit-logger` → Event Grid trigger
- `fn-enrich` → Queue trigger (fires automatically when queue has messages)
- `fn-index-refresh` → `POST http://localhost:7071/api/fn-index-refresh`
- `fn-search-api` → `GET http://localhost:7071/api/fn-search-api?q=apple`

### 4. Run the smoke test

```bash
# Unit mode — no Azure required
node scripts/test-pipeline.js

# Integration mode — requires all env vars set
node scripts/test-pipeline.js --integration
```

### 5. Manually trigger the pipeline

```bash
# Simulate a Logic App blob write
az storage blob upload \
  --connection-string "UseDevelopmentStorage=true" \
  --container-name articles-bronze \
  --name "technology/$(date +%Y-%m-%d)/test123.json" \
  --file scripts/fixtures/sample-article.json

# Check queue depth
az storage queue peek \
  --connection-string "UseDevelopmentStorage=true" \
  --name article-enrich-queue

# Trigger index refresh manually
curl -X POST http://localhost:7071/api/fn-index-refresh \
  -H "Content-Type: application/json" \
  -d "{\"date\": \"$(date +%Y-%m-%d)\", \"category\": \"technology\"}"

# Search
curl "http://localhost:7071/api/fn-search-api?q=apple+earnings&category=technology"
```

---

## Search API Reference

```
GET /api/fn-search-api
Authorization: Bearer <JWT>           (required in production via APIM)
```

### Query Parameters

| Parameter | Type | Default | Description |
|---|---|---|---|
| `q` | string | required | Search query (max 500 chars) |
| `top` | integer | 10 | Results to return (max 50) |
| `category` | string | — | Filter: `technology\|business\|science\|health` |
| `source` | string | — | Filter: exact source name (e.g. `BBC`) |
| `sentiment` | string | — | Filter: `positive\|negative\|neutral\|mixed` |
| `semantic` | boolean | false | Enable semantic reranker (costs extra Search units) |
| `vector` | boolean | true | Enable vector search (requires embedding call) |
| `from` | string | — | ISO date lower bound: `YYYY-MM-DD` |
| `to` | string | — | ISO date upper bound: `YYYY-MM-DD` |

### Example Requests

```bash
# Basic keyword search
curl "https://<apim>.azure-api.net/search?q=Apple+earnings" \
  -H "Authorization: Bearer <token>"

# Semantic search with category filter
curl "https://<apim>.azure-api.net/search?q=electric+vehicles&category=technology&semantic=true"

# Sentiment-filtered date range
curl "https://<apim>.azure-api.net/search?q=inflation&sentiment=negative&from=2024-01-01&to=2024-01-31"

# Keyword-only (no vector embedding, faster)
curl "https://<apim>.azure-api.net/search?q=Apple&vector=false"
```

### Response Shape

```json
{
  "query": {
    "q": "Apple earnings",
    "top": 10,
    "filters": { "category": "technology", "source": null, "sentiment": null, "from": null, "to": null },
    "semantic": false,
    "vector": true
  },
  "count": 42,
  "results": [
    {
      "score": 0.94,
      "id": "e9bca57a5f8d50f4",
      "url": "https://www.theverge.com/2024/01/15/apple-earnings",
      "title": "Apple reports record quarterly earnings",
      "source": "The Verge",
      "category": "technology",
      "publishedAt": "2024-01-15T17:09:12Z",
      "sentimentLabel": "positive",
      "sentimentScore": 0.9,
      "entities": ["Apple", "Tim Cook", "Cupertino"],
      "keyPhrases": ["record earnings", "quarterly results"]
    }
  ],
  "facets": {
    "categories": [{ "value": "technology", "count": 38 }],
    "sentiments":  [{ "value": "positive", "count": 30 }]
  },
  "durationMs": 142,
  "warning": null
}
```

---

## Deployment Order

Run these in order — each step depends on the previous:

```bash
# 1. Storage resources
az deployment group create -g <rg> --template-file infra/modules/storage.bicep

# 2. Cognitive services
az deployment group create -g <rg> --template-file infra/modules/cognitive.bicep

# 3. Function App
az deployment group create -g <rg> --template-file infra/modules/functions.bicep
func azure functionapp publish <fn-app-name>

# 4. Event Grid subscription
az deployment group create -g <rg> --template-file infra/modules/eventgrid.bicep

# 5. Logic App
az logic workflow create \
  --resource-group <rg> \
  --name nlp-pipeline-ingestor \
  --definition @logic-app/workflow.json \
  --parameters newsApiKey=<key> storageAccountName=<account> \
               hashFunctionUrl=https://<fn-app>.azurewebsites.net/api/fn-hash-url \
               hashFunctionKey=<fn-key>

# 6. Create Search index (run once)
node scripts/create-index.js

# 7. Search + Databricks
az deployment group create -g <rg> --template-file infra/modules/search.bicep
az deployment group create -g <rg> --template-file infra/modules/databricks.bicep
# Upload databricks/gold_aggregation.py to /Shared/nlp-pipeline/ in your workspace

# 8. ADF pipeline (dataset → pipeline → trigger, in this order)
az datafactory dataset create  --factory-name <adf> -g <rg> \
  --dataset-name SilverContainerDataset \
  --properties @infra/adf/dataset_silver_container.json

az datafactory pipeline create --factory-name <adf> -g <rg> \
  --pipeline-name nlp_pipeline_nightly \
  --pipeline @infra/adf/pipeline_nlp_nightly.json

az datafactory trigger create  --factory-name <adf> -g <rg> \
  --trigger-name NightlyScheduleTrigger \
  --properties @infra/adf/trigger_nightly_schedule.json

az datafactory trigger start   --factory-name <adf> -g <rg> \
  --trigger-name NightlyScheduleTrigger

# 9. APIM
az deployment group create -g <rg> --template-file infra/modules/apim.bicep
# Apply policies via Azure portal or APIM REST API

# 10. Purview
az deployment group create -g <rg> --template-file infra/modules/purview.bicep

# 11. Smoke test
node scripts/test-pipeline.js --integration
```

---

## Monitoring

### Application Insights queries

```kusto
-- Function errors in last 24h
exceptions
| where timestamp > ago(24h)
| summarize count() by outerMessage
| order by count_ desc

-- fn-enrich throughput
traces
| where message contains "Enrichment complete"
| summarize count() by bin(timestamp, 1h)
| render timechart

-- Search API latency
traces
| where message contains "Search complete"
| extend durationMs = toint(customDimensions.durationMs)
| summarize avg(durationMs), percentile(durationMs, 95) by bin(timestamp, 1h)
```

### ADF pipeline monitoring
Azure portal → Data Factory → Monitor → Pipeline runs. Alert on `RunFailed` or `fn-index-refresh` returning HTTP 207 (partial failure).

### Key metrics to watch

| Metric | Source | Alert threshold |
|---|---|---|
| `article-enrich-queue` depth | Storage Queue | > 500 (enrichment falling behind) |
| `fn-enrich` failures | App Insights | > 5% error rate |
| Search index document count | AI Search metrics | No growth after nightly run |
| NewsAPI 429 rate | Logic App run history | Any 429 not resolved by retry |

---

## Known Limitations

- **NewsAPI free tier**: 100 req/day, articles truncated at ~200 chars. Content vector quality is limited by this truncation — embeddings built from title + snippet, not full article.
- **AI Search free tier (F1)**: 50MB storage, no SLA. Upgrade to Basic for production.
- **Logic App `SetVariable` concurrency**: Article loop runs sequentially (`repetitions: 1`) because `SetVariable` is not thread-safe. This means each category takes `n_articles × fn-hash-url_latency` time. At 100 articles × ~50ms each = ~5 seconds per category — well within the 6-hour polling window.
- **APIM caching vs near-real-time indexing**: Search results cached for 60s. Articles indexed by the nightly ADF run won't appear in search results until the cache expires.
- **Semantic reranker and scoring profile**: `scoringProfile: 'recency-boost'` is deliberately not applied when `semantic=true` — see ADR-008. For semantic queries, result ordering is controlled entirely by the cross-encoder.

---

## Running Tests

```bash
# Jest unit tests (187 tests across 8 suites)
cd nlp-pipeline
node_modules/.bin/jest --config functions/jest.config.json

# Smoke test — unit mode (64 assertions, no Azure needed)
node scripts/test-pipeline.js

# Smoke test — integration mode (requires .env with live credentials)
node scripts/test-pipeline.js --integration
```