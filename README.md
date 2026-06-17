# Text NLP Pipeline — Project Plan
## Pre-Implementation Blueprint

---

## 1. Project Overview

**Goal**: Ingest news articles from NewsAPI, enrich with NLP (sentiment, NER, key phrases) and vector embeddings, index for hybrid semantic search in Azure AI Search, and serve trend analytics + a search API.

**Stack**: Azure Logic Apps · Azure Functions (Node.js) · Azure Blob Storage · ADLS Gen2 · Azure Cognitive Services (Language API) · Azure OpenAI · Azure Databricks · Azure AI Search · Azure API Management · Microsoft Purview

**Constraint**: NewsAPI free tier = 100 req/day, 100 articles/request → max 10,000 articles/day.

---

## 2. Architecture Decision Record (ADR)

### ADR-001: Logic App vs ADF HTTP for ingestion scheduler
**Decision**: Logic App  
**Reason**: Logic Apps natively support HTTP connectors, JSON parsing, schedule triggers (recurrence), and writing to Blob Storage — no custom code. ADF HTTP is heavier, requires linked services, and is better suited for bulk data movement, not API polling. Logic App also integrates directly with Event Grid.

### ADR-002: Event Grid vs Event Hub for fan-out
**Decision**: Event Grid  
**Reason**: Event Grid is push-based, serverless, and designed for blob events (BlobCreated trigger). Event Hub is pull-based and better for high-throughput streaming (millions/sec). Our volume (~10K articles/day) is far below Event Hub thresholds. Event Grid's BlobCreated subscription is zero-config with Blob Storage.

### ADR-003: Idempotent ingestion key
**Decision**: URL hash as dedup key  
**Reason**: Article URLs are stable unique identifiers. SHA-256(url) → stored in Azure Table Storage. Before writing to Blob, check if hash exists. If yes, skip. This prevents re-processing on Logic App re-runs.

### ADR-004: NLP enrichment runtime
**Decision**: Azure Function (Node.js) over a container/VM  
**Reason**: Event Grid → Function is a natural serverless chain. Batch size limits of Language API (10 documents/request) handled in the Function with chunking logic. Functions scale per event automatically.

### ADR-005: Embeddings model
**Decision**: Azure OpenAI `text-embedding-ada-002`  
**Reason**: 1536-dimensional vectors, well-supported in Azure AI Search HNSW index, cosine similarity. Per-article call (not batch) since Language API and OpenAI calls are already concurrent per article batch.

### ADR-006: Gold layer compute
**Decision**: Databricks (PySpark notebook)  
**Reason**: Databricks Delta Lake supports MERGE (upsert) semantics natively. Rolling window aggregations (top entities per week, keyword trends) are Spark-native operations. MLflow is built into Databricks for model/embedding version tracking.

### ADR-007: Hybrid search strategy
**Decision**: BM25 (keyword) + HNSW (vector) with Reciprocal Rank Fusion (RRF)  
**Reason**: Pure vector search misses exact-match queries (e.g. "Apple Inc Q3 earnings"). Pure keyword misses semantic similarity. RRF combines ranked lists without needing score normalization. Semantic ranker re-scores top-50 results using a cross-encoder — optional but improves precision.

### ADR-008: API auth strategy
**Decision**: APIM with OAuth 2.0 (client credentials) + JWT validation inbound policy  
**Reason**: Azure Function itself has no auth — APIM sits in front as the security boundary. JWT validation policy offloads auth from Function code. Rate limiting per subscription key prevents abuse of free Search tier.

### ADR-009: Content storage — ADLS not Search
**Decision**: Store full article text in ADLS Gen2, store only metadata + vectors in AI Search  
**Reason**: AI Search storage is expensive and not designed for blob storage. Search index holds: id, url, title, source, category, published_at, sentiment_score, sentiment_label, entities (array), key_phrases (array), content_vector (1536-dim). Full article body stays in ADLS and is fetched on demand via URL reference.

---

## 3. Data Flow (End to End)

```
NewsAPI (per category, scheduled)
  └─ Logic App (recurrence every 6h, 4 categories × 25 articles = 100/day)
       └─ Blob Storage: raw/{category}/{date}/{url_hash}.json   [bronze]
            └─ Event Grid (BlobCreated)
                 ├─ Fn-NLP-Trigger   → kicks enrichment job (adds to queue)
                 └─ Fn-Audit-Logger  → writes to Table Storage audit log

Fn-NLP-Trigger enqueues article refs to Azure Storage Queue
  └─ Fn-Enrich (queue trigger, batch=10)
       ├─ Calls Language API: sentiment + NER + key phrases (batch of 10)
       ├─ Calls Azure OpenAI: text-embedding-ada-002 per article
       ├─ Merges results
       └─ Writes to ADLS Gen2: silver/{category}/{date}/{url_hash}.json  [silver]

ADF Pipeline (nightly, 02:00 UTC)
  └─ Activity 1: Check silver layer completeness
  └─ Activity 2: Trigger Databricks notebook (gold aggregation)
       └─ Databricks: reads silver → computes gold outputs
            ├─ sentiment_trends_by_category (daily rolling 7d)
            ├─ top_entities_per_week
            └─ trending_keywords (rolling 3d window)
       └─ Writes to ADLS: gold/{report_type}/{date}/
  └─ Activity 3: Trigger Fn-Index-Refresh → pushes silver docs to AI Search

Azure AI Search Index
  └─ Fn-Index-Refresh: upsert documents (key=url_hash)
       ├─ Keyword fields: title, body_snippet, category, source, entities
       └─ Vector field: content_vector (1536-dim, HNSW, cosine)

Fn-Search-API (HTTP trigger)
  └─ Receives query → calls AI Search with hybrid query (RRF)
  └─ Returns ranked results + metadata

APIM (in front of Fn-Search-API)
  └─ Inbound: JWT validation, rate limit (100 req/min/subscription)
  └─ Outbound: response caching (60s TTL for identical queries)

Microsoft Purview
  └─ Scans: Blob Storage, ADLS Gen2, Azure SQL (audit table), AI Search index
  └─ Builds lineage: raw JSON → silver → gold → Search index
  └─ Custom classification rule: flag articles with PII entities (PERSON + email/phone patterns)
```

---

## 4. Project Structure

```
nlp-pipeline/
│
├── README.md                          # How to run, architecture, decisions
├── .env.example                       # All env vars with descriptions (no secrets)
├── .gitignore
├── package.json                       # Root (workspaces)
│
├── infra/                             # Azure infrastructure as code
│   ├── main.bicep                     # Entry point — calls all modules
│   ├── parameters.json                # Environment parameters
│   ├── modules/                       # Bicep resource provisioning (one file per resource)
│   │   ├── storage.bicep              # Blob Storage + ADLS Gen2 + Table Storage + Queue
│   │   ├── functions.bicep            # All Function Apps (one app, multiple functions)
│   │   ├── logic-app.bicep            # Logic App workflow definition
│   │   ├── eventgrid.bicep            # Event Grid subscription
│   │   ├── cognitive.bicep            # Language API + Azure OpenAI
│   │   ├── databricks.bicep           # Databricks workspace
│   │   ├── search.bicep               # Azure AI Search + index schema
│   │   ├── apim.bicep                 # APIM instance + API + policies
│   │   └── purview.bicep              # Purview account + scan rules
│   └── adf/                           # ADF artifacts — deployed via az datafactory CLI, NOT Bicep
│       ├── pipeline_nlp_nightly.json      # 5-activity nightly pipeline
│       ├── dataset_silver_container.json  # SilverContainerDataset (used by GetMetadata activity)
│       └── trigger_nightly_schedule.json  # Daily 02:00 UTC schedule trigger
│
├── functions/                         # Azure Functions App (Node.js)
│   ├── package.json
│   ├── host.json
│   ├── local.settings.json.example
│   │
│   ├── shared/                        # Shared utilities across functions
│   │   ├── blobClient.js              # Azure Blob Storage SDK wrapper
│   │   ├── tableClient.js             # Table Storage SDK wrapper (dedup + audit)
│   │   ├── queueClient.js             # Storage Queue SDK wrapper
│   │   ├── languageClient.js          # Cognitive Services Language API wrapper
│   │   ├── openaiClient.js            # Azure OpenAI embedding wrapper
│   │   ├── searchClient.js            # Azure AI Search SDK wrapper
│   │   └── logger.js                  # Structured logger (Application Insights)
│   │
│   ├── fn-nlp-trigger/                # Event Grid trigger → enqueue article refs
│   │   ├── function.json
│   │   └── index.js
│   │
│   ├── fn-audit-logger/               # Event Grid trigger → write audit row
│   │   ├── function.json
│   │   └── index.js
│   │
│   ├── fn-enrich/                     # Queue trigger → NLP enrichment
│   │   ├── function.json
│   │   └── index.js
│   │
│   ├── fn-index-refresh/              # HTTP trigger (called by ADF) → push to Search
│   │   ├── function.json
│   │   └── index.js
│   │
│   └── fn-search-api/                 # HTTP trigger → search endpoint
│       ├── function.json
│       └── index.js
│
├── logic-app/                         # Logic App workflow definition
│   └── workflow.json                  # ARM/Bicep-embeddable workflow definition
│
├── databricks/                        # Databricks notebooks
│   ├── gold_aggregation.py            # Main gold layer notebook
│   └── utils/
│       └── delta_helpers.py           # MERGE/upsert helpers, rolling window UDFs
│
├── search/                            # AI Search index definitions
│   ├── index-schema.json              # Full index schema (fields, vector config)
│   ├── skillset.json                  # (optional) built-in skillset definition
│   └── indexer.json                   # (optional) indexer if push model not used
│
├── apim/                              # APIM policy files
│   ├── inbound-policy.xml             # JWT validation + rate limit
│   └── outbound-policy.xml            # Response caching
│
├── purview/                           # Purview configuration
│   ├── classification-rules.json      # PII custom classification rule
│   └── scan-config.json               # Scan definitions for each asset type
│
├── scripts/                           # One-off admin / setup scripts
│   ├── create-index.js                # Create/update AI Search index
│   ├── create-search-alias.js         # Zero-downtime index swap
│   ├── backfill-silver.js             # Re-enrich bronze articles if needed
│   └── test-pipeline.js              # End-to-end smoke test
│
└── docs/
    ├── architecture.md                # Detailed ADR + component descriptions
    ├── local-dev.md                   # Local development guide
    ├── deployment.md                  # Step-by-step Azure deployment
    └── api-reference.md               # Search API endpoint docs
```

---

## 5. Environment Variables (`.env.example`)

```bash
# NewsAPI
NEWSAPI_KEY=

# Azure Storage
AZURE_STORAGE_CONNECTION_STRING=
BLOB_CONTAINER_BRONZE=articles-bronze
BLOB_CONTAINER_SILVER=articles-silver
ADLS_CONTAINER_GOLD=articles-gold
TABLE_DEDUP=articleDedup
TABLE_AUDIT=articleAudit
QUEUE_ENRICH=article-enrich-queue

# Cognitive Services
LANGUAGE_ENDPOINT=https://<name>.cognitiveservices.azure.com/
LANGUAGE_API_KEY=
LANGUAGE_API_VERSION=2023-04-01

# Azure OpenAI
OPENAI_ENDPOINT=https://<name>.openai.azure.com/
OPENAI_API_KEY=
OPENAI_EMBEDDING_DEPLOYMENT=text-embedding-ada-002

# Azure AI Search
SEARCH_ENDPOINT=https://<name>.search.windows.net
SEARCH_API_KEY=
SEARCH_INDEX_NAME=articles

# APIM
APIM_ENDPOINT=https://<name>.azure-api.net
APIM_SUBSCRIPTION_KEY=

# Databricks
DATABRICKS_HOST=https://<workspace>.azuredatabricks.net
DATABRICKS_TOKEN=
DATABRICKS_CLUSTER_ID=

# Application Insights
APPINSIGHTS_INSTRUMENTATIONKEY=
```

---

## 6. AI Search Index Schema (key fields)

```json
{
  "name": "articles",
  "fields": [
    { "name": "id",              "type": "Edm.String",              "key": true,       "filterable": true },
    { "name": "url",             "type": "Edm.String",              "retrievable": true },
    { "name": "title",           "type": "Edm.String",              "searchable": true, "analyzer": "en.microsoft" },
    { "name": "body_snippet",    "type": "Edm.String",              "searchable": true, "analyzer": "en.microsoft" },
    { "name": "source",          "type": "Edm.String",              "filterable": true, "facetable": true },
    { "name": "category",        "type": "Edm.String",              "filterable": true, "facetable": true },
    { "name": "published_at",    "type": "Edm.DateTimeOffset",      "sortable": true,  "filterable": true },
    { "name": "sentiment_label", "type": "Edm.String",              "filterable": true, "facetable": true },
    { "name": "sentiment_score", "type": "Edm.Double",              "sortable": true },
    { "name": "entities",        "type": "Collection(Edm.String)",  "searchable": true, "filterable": true },
    { "name": "key_phrases",     "type": "Collection(Edm.String)",  "searchable": true },
    { "name": "content_vector",  "type": "Collection(Edm.Single)",  "dimensions": 1536, "vectorSearchProfile": "hnsw-cosine" }
  ],
  "vectorSearch": {
    "algorithms": [{ "name": "hnsw-config", "kind": "hnsw", "parameters": { "m": 4, "metric": "cosine" } }],
    "profiles":   [{ "name": "hnsw-cosine", "algorithm": "hnsw-config" }]
  },
  "semanticSearch": {
    "configurations": [{
      "name": "semantic-config",
      "prioritizedFields": {
        "titleField":   { "fieldName": "title" },
        "contentFields": [{ "fieldName": "body_snippet" }],
        "keywordsFields": [{ "fieldName": "key_phrases" }]
      }
    }]
  }
}
```

---

## 7. Key Implementation Contracts

### fn-enrich input message (from queue)
```json
{
  "blobPath": "raw/technology/2024-01-15/abc123.json",
  "urlHash":  "abc123",
  "category": "technology",
  "ingestedAt": "2024-01-15T02:00:00Z"
}
```

### Silver layer article schema
```json
{
  "id":             "abc123",
  "url":            "https://...",
  "title":          "...",
  "body_snippet":   "first 500 chars of content",
  "source":         "BBC",
  "category":       "technology",
  "published_at":   "2024-01-15T00:00:00Z",
  "sentiment":      { "label": "positive", "score": 0.87 },
  "entities":       [{ "text": "Apple", "category": "Organization" }],
  "key_phrases":    ["quarterly earnings", "revenue growth"],
  "content_vector": [0.012, -0.034, ...],
  "enriched_at":    "2024-01-15T02:05:00Z"
}
```

### Search API request/response
```
GET /api/search?q=Apple earnings&category=business&top=10&semantic=true
Authorization: Bearer <JWT>

Response:
{
  "count": 10,
  "results": [
    {
      "id": "abc123",
      "title": "...",
      "url":   "...",
      "score": 0.94,
      "sentiment_label": "positive",
      "entities": ["Apple", "Tim Cook"],
      "key_phrases": ["quarterly earnings"],
      "published_at": "2024-01-15T00:00:00Z"
    }
  ],
  "trends": null
}
```

---

## 8. Error Handling Strategy

| Layer | Failure Scenario | Strategy |
|---|---|---|
| Ingestion | NewsAPI rate limit hit | Logic App retry policy (3x, exponential backoff). Dead-letter queue for failed batches. |
| Ingestion | Duplicate article | URL hash check in Table Storage before blob write. Skip if exists. |
| Enrichment | Language API partial failure | Per-article try/catch. Failed articles written to `error/` container with error metadata. Retry queue. |
| Enrichment | OpenAI timeout | Azure OpenAI has built-in retry. Function timeout = 10min. Partial results (no vector) written to silver with `vectorStatus: "pending"`. |
| Indexing | Search upsert failure | Batch upserts (1000 docs max). Failed batch retried once. Logged to Application Insights. |
| ADF pipeline | Databricks notebook fails | ADF pipeline has on-failure alerts. Email notification via Logic App. Previous gold data remains. |
| API | Search query error | Function returns 400 with structured error. APIM caches errors for 5s to prevent hammering. |

---

## 9. Local Development Plan

### Running without Azure
- **Azurite** (local Azure Storage emulator) for Blob, Table, Queue
- **Azure Functions Core Tools v4** for local function execution
- **NewsAPI**: real key required (free tier works)
- **Language API + OpenAI**: either real Azure endpoint or mock stubs in `shared/mocks/`
- **AI Search**: no local emulator → use a real free-tier Search instance (F1 is free)
- Databricks notebooks: run locally as plain Python with `pyspark` installed

### Local run order
1. `azurite` (Storage emulator)
2. `func start` in `functions/` (all functions loaded)
3. Trigger ingestion manually via `scripts/test-pipeline.js`
4. Watch queue → enrich → silver flow in logs

---

## 10. Deployment Order

1. Deploy `infra/modules/storage.bicep` (Blob, ADLS, Table, Queue)
2. Deploy `infra/modules/cognitive.bicep` (Language API + OpenAI)
3. Deploy `infra/modules/functions.bicep` (Function App + App Settings)
4. Deploy `infra/modules/eventgrid.bicep` (link Blob → Event Grid → Functions)
5. Deploy `infra/modules/logic-app.bicep` (Logic App with NewsAPI connection)
6. Run `scripts/create-index.js` (create AI Search index)
7. Deploy `infra/modules/search.bicep`
8. Deploy `infra/modules/databricks.bicep` + upload `databricks/gold_aggregation.py` notebook
9. Deploy ADF artifacts in order (dataset before pipeline before trigger):
   ```bash
   az datafactory dataset create   --factory-name <adf> -g <rg> --dataset-name SilverContainerDataset --properties @infra/adf/dataset_silver_container.json
   az datafactory pipeline create  --factory-name <adf> -g <rg> --pipeline-name nlp_pipeline_nightly  --pipeline    @infra/adf/pipeline_nlp_nightly.json
   az datafactory trigger create   --factory-name <adf> -g <rg> --trigger-name NightlyScheduleTrigger --properties @infra/adf/trigger_nightly_schedule.json
   az datafactory trigger start    --factory-name <adf> -g <rg> --trigger-name NightlyScheduleTrigger
   ```
10. Deploy `infra/modules/apim.bicep` + apply policies
11. Deploy `infra/modules/purview.bicep` + configure scans
12. Run `scripts/test-pipeline.js` (end-to-end smoke test)

---

## 11. README Outline (what the submission README must cover)

1. **Architecture overview** — diagram + 2-paragraph description
2. **Design decisions** — numbered ADR list (from section 2 above)
3. **Prerequisites** — Azure subscription, Node.js 18+, Azure CLI, Azurite
4. **Environment setup** — copy `.env.example`, fill in values
5. **Local development** — step-by-step with Azurite
6. **Deployment** — `az deployment group create` commands in order
7. **Running the pipeline** — trigger Logic App / use test script
8. **Search API usage** — `curl` examples with JWT
9. **Monitoring** — Application Insights queries + ADF monitoring
10. **Known limitations** — NewsAPI 100 req/day, free Search tier limits, no Databricks in local dev

---

## 12. Critical Edge Cases to Handle in Code

1. **Article with no `content` field from NewsAPI** — use `description` as fallback, flag `contentTruncated: true`
2. **Language API: 10-doc batch limit** — chunk articles array into groups of 10 before calling
3. **OpenAI: empty string input** — skip embedding, set `content_vector: null`, mark `vectorStatus: "empty_content"`
4. **Dedup across Logic App runs** — Table Storage entity: PartitionKey=`urlHash[:2]`, RowKey=`urlHash`
5. **AI Search: 1000-doc batch upsert limit** — chunk silver folder files into batches of 1000
6. **`_ts` timestamp for idempotent gold writes** — Databricks MERGE on `url_hash` as key, REPLACE WHERE on date partition
7. **APIM caching + near-real-time indexing** — 60s TTL acceptable; document this in README
8. **Purview PII flag** — Language API entity category `"Person"` + pattern match for email/phone → custom classification

---

*This plan is the source of truth for all implementation. No implementation begins without every section above being confirmed.*