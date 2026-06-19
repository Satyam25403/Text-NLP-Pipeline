# Architecture

## Overview

The NLP pipeline is a six-layer event-driven system on Azure. Each layer has a single responsibility and passes data to the next via a durable storage boundary — no direct function-to-function calls, so each layer can fail and retry independently.

```
Layer 1  Ingestion          Logic App → Blob Storage (bronze)
Layer 2  NLP Enrichment     Azure Function → ADLS Gen2 (silver)
Layer 3  Batch Orchestration ADF → Databricks → Azure AI Search (gold)
Layer 4  Indexing           Azure AI Search (hybrid BM25 + HNSW vector)
Layer 5  API Serving        Azure Function → APIM → consumers
Layer 6  Governance         Microsoft Purview (lineage + PII classification)
```

---

## Layer 1 — Ingestion

**Components:** Logic App, fn-hash-url, Azure Blob Storage, Event Grid, fn-nlp-trigger, fn-audit-logger

**Flow:**

The Logic App fires every 6 hours (00:00, 06:00, 12:00, 18:00 UTC) and iterates over each category in `ingestCategories`. For each category it calls `GET /v2/top-headlines` on NewsAPI with `X-Api-Key` header authentication, `language=en`, `pageSize=100`. On a successful `status: "ok"` response it iterates each article in the `articles[]` array.

For each article with a non-null `url`, it calls `fn-hash-url` to compute `SHA-256(url)[0:16]` — the stable dedup key used as the blob filename throughout the pipeline. It then writes the raw article JSON as an individual blob to `articles-bronze/{category}/{date}/{urlHash}.json` using Managed Identity authentication to Storage.

The Logic App uses `SetVariable` inside loops (not `InitializeVariable`, which is not thread-safe for loop reassignment) and runs both the category and article loops sequentially (`concurrency: 1`) to avoid race conditions on shared variables.

When each blob lands in `articles-bronze`, Azure Event Grid fires a `BlobCreated` event and fans it out to two independent subscriptions:
- `fn-nlp-trigger` — checks the dedup table, writes `markIngested` before enqueueing (so re-triggered events from a crash window are caught), then enqueues the article reference to `article-enrich-queue`
- `fn-audit-logger` — writes an immutable audit record to `articleAudit` Table Storage, never rethrows

**Rate budget:** 4 categories × 4 polls/day = 16 requests/day (limit: 100/day)

---

## Layer 2 — NLP Enrichment

**Components:** fn-enrich, Azure Cognitive Services Language API, Azure OpenAI, ADLS Gen2 (silver)

**Flow:**

`fn-enrich` is triggered by Storage Queue messages from `fn-nlp-trigger`. On each invocation it first checks whether the silver blob already exists (`exists()` check) — if yes, returns immediately (idempotent). It then reads the bronze blob, extracts the article text via a fallback chain:

1. `content` — strips `[+N chars]` free-tier truncation marker and HTML fragments
2. `description` — if content is null or empty
3. `title` — last resort

It then fires the Language API and Azure OpenAI embedding call in `Promise.all()` (parallel, independent). The Language API call is batched at 10 documents per request (API limit) and returns sentiment (label + confidence scores), named entities (text, category, confidence), and key phrases. The OpenAI call generates a 1536-dimension vector using `text-embedding-ada-002` from `title + "\n\n" + body_snippet`.

Results are merged into a silver document and written to `articles-silver/{category}/{date}/{urlHash}.json`. The `hasPii` flag is set to `true` if Language API detected any `Person`, `PhoneNumber`, or `Email` entity — this is what Purview's classification rule targets.

On failure, individual articles are written to `articles-error/` for inspection and the function does not rethrow (preventing poison-message loops). Infrastructure failures (Storage unavailable) do rethrow so the queue retries. `maxDequeueCount: 5` before the message moves to `article-enrich-queue-poison`.

**Silver document schema:**
```
id, url, title, body_snippet, source, category, publishedAt (camelCase),
author, nlpStatus, nlpError, sentiment {label, scores}, entities [{text, category, confidenceScore}],
keyPhrases, hasPii, content_vector [1536], vectorStatus, vectorError,
ingestedAt, enrichedAt, contentTruncated
```

---

## Layer 3 — Batch Orchestration

**Components:** Azure Data Factory, Databricks (PySpark), fn-index-refresh

**Flow:**

ADF runs `nlp_pipeline_nightly` every day at 02:00 UTC. The pipeline has five activities in dependency order:

1. `CheckSilverCompleteness` (GetMetadata) — checks that the silver container has child items before proceeding
2. `FailIfSilverEmpty` (IfCondition) — short-circuits with a `SILVER_EMPTY` error code if the container is empty, alerting operators without wasting Databricks cluster startup time
3. `RunGoldAggregation` (DatabricksNotebook) — triggers `gold_aggregation.py` with yesterday's date and the ADLS paths as parameters. The notebook reads the last 7 days of silver data and computes three gold outputs:
   - `sentiment_trends/{date}/` — daily sentiment by category with 7-day rolling window, dominant sentiment label
   - `top_entities/{date}/` — top 20 entities per category by article frequency
   - `trending_keywords/{date}/` — top 30 key phrases ranked by `trend_score = current_count / (prior_count + 1)` over a 3-day rolling window, surfacing rising topics
4. `RefreshSearchIndex` (WebActivity, POST) — calls `fn-index-refresh` with yesterday's date. The function lists all silver blobs for that date, reads them concurrently (20 parallel), maps each to the Search index schema, and upserts in 1000-doc batches. Returns 200 on success, 207 on partial failure (ADF can alert on 207).
5. `CheckIndexRefreshResult` (IfCondition) — fails the pipeline if fn-index-refresh returned HTTP 4xx/5xx

All gold writes use `mode("overwrite")` with Delta Lake `REPLACE WHERE run_date = '<date>'` so re-running for the same date is safe.

---

## Layer 4 — Indexing

**Components:** Azure AI Search, `scripts/create-index.js`

**Index design:**

The `articles` index has 12 fields. Key design decisions:

- `id` (url_hash): key field, `searchable: false` — no inverted index needed, accidental keyword matches on hex strings are undesirable
- `title`, `body_snippet`: `en.microsoft` analyzer — handles English stemming, contractions, stop words better than standard Lucene
- `content_vector`: 1536-dim `Collection(Edm.Single)`, `retrievable: false` — 6KB per document never sent to clients
- `sentiment_score_positive`: stores `scores.positive` from Language API — named explicitly to avoid confusion with a general polarity score
- `entities`: `Collection(Edm.String)`, both `searchable` and `filterable` — supports `$filter=entities/any(e: e eq 'Apple')` and keyword search
- `published_at`: `Edm.DateTimeOffset`, `sortable` and `filterable` — enables recency sort and date-range queries
- `source`, `category`, `sentiment_label`: `facetable` — enables drill-down UX

**Hybrid search:** Queries run BM25 keyword + HNSW vector in parallel. AI Search merges ranked lists with Reciprocal Rank Fusion (RRF). `kNearestNeighborsCount = max(top×2, 50)` over-fetches from the vector index to give RRF a larger candidate pool.

**Semantic reranker:** Optional (`semantic=true` in fn-search-api). The cross-encoder re-scores the top-50 BM25+vector candidates. `scoringProfile: 'recency-boost'` is intentionally NOT applied when semantic is enabled — applying a freshness boost before the reranking window is built would push fresh-but-irrelevant articles into the top-50 at the expense of semantically-matched older ones.

**Index updates:** `create-index.js` uses `createOrUpdateIndex` (idempotent). Fields cannot be removed from a live index. For breaking changes, use `create-search-alias.js` to build a new versioned index and atomically swap the alias.

---

## Layer 5 — API Serving

**Components:** fn-search-api, APIM (inbound + outbound policies)

**Flow:**

Consumers call `GET https://<apim>.azure-api.net/search?q=...` with a Bearer JWT. APIM processes the request:

1. **Rate limit** (cheapest check first): 100 calls/60s per subscription key. Exposes `X-RateLimit-Remaining` header so clients can back off gracefully. `increment-condition` prevents the counter advancing on already-rejected 429 responses.
2. **JWT validation**: `validate-jwt` with `openid-config` auto-discovery from Azure AD. Validates audience (`api://<app-id-uri>`), issuer (tenant), expiry, and Bearer scheme.
3. **Strip Authorization header**: JWT removed before forwarding to the Function — no raw tokens in Function logs.
4. **fn-search-api**: validates all 9 query parameters, embeds the query text with ada-002 (parallel to the eventual Search call), calls AI Search with hybrid RRF query. If embedding fails, falls back to keyword-only search and adds a `warning` field to the response — the query still succeeds. Returns 200 with results, facets, and metadata.
5. **Response caching**: Outbound policy caches 200 responses for 60s keyed on all 9 query parameters. 400/5xx cached for 5s. `X-Cache: HIT/MISS` header.

**fn-search-api is `authLevel: anonymous`** — APIM is the security boundary. The Function trusts that APIM has already validated the caller.

---

## Layer 6 — Governance

**Components:** Microsoft Purview, `scripts/register-purview-lineage.js`

**Lineage graph:**

```
NewsAPI
  └─[Logic App]──► articles-bronze
       └─[fn-enrich]──► articles-silver          ← registered manually
            ├─[ADF/Databricks]──► articles-gold  ← auto-detected by Purview
            └─[fn-index-refresh]──► articles      ← registered manually
                                    (Search index)
```

ADF and Databricks lineage is auto-detected by Purview when both resources are in the same subscription. `fn-enrich` and `fn-index-refresh` are custom Functions — Purview has no visibility into them. `register-purview-lineage.js` uses the Purview Atlas REST API to register Process entities for both functions with their input/output data asset references.

**PII classification:**

Four custom classification rules in `purview/classification-rules.json`:
- `NLP_Pipeline_PII_Article`: scans silver JSON blobs for `"hasPii": true` — set by fn-enrich when Language API detects Person, PhoneNumber, or Email entities
- `NLP_Pipeline_Person_Entity`: scans for `"category": "Person"` in the entities array
- `NLP_Pipeline_Phone_Pattern`: regex for US/international phone number formats
- `NLP_Pipeline_Email_Pattern`: regex for RFC 5322 email addresses

Scans run nightly at 03:30 UTC (30 minutes after ADF finishes). Gold layer scan has no PII rules — aggregated data contains no individual article content.

---

## Data Flow Summary

| Stage | Container / Resource | Format | Key field |
|---|---|---|---|
| Bronze | articles-bronze | Raw NewsAPI JSON | urlHash (blob name) |
| Silver | articles-silver | Enriched JSON + vector | urlHash (blob name + silver.id) |
| Gold | articles-gold | Aggregated JSON (Delta) | run_date + category |
| Search index | articles | AI Search documents | id (urlHash) |
| Audit | articleAudit (Table) | Event log rows | urlHash + event + timestamp |
| Dedup | articleDedup (Table) | Presence marker | urlHash |