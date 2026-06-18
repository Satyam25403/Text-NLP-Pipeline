# Logic App — NewsAPI Ingestion

## What it does

Polls NewsAPI `/v2/top-headlines` every 6 hours (00:00, 06:00, 12:00, 18:00 UTC),
one request per category, and writes each article as an individual JSON blob to the
bronze layer in Azure Blob Storage.

## Rate limit math

| Constraint | Value |
|---|---|
| NewsAPI free tier | 100 req/day |
| Categories polled | 4 (technology, business, science, health) |
| Polls per day | 4 (every 6h) |
| **Total requests/day** | **4 × 4 = 16** |
| Articles per request | up to 100 |
| **Max articles/day** | **~1,600** |

16 requests/day is well under the 100/day limit, leaving headroom to add categories.

## Key design decisions

### Why `/v2/top-headlines` not `/v2/everything`?

`/v2/everything` does **not** support the `category` parameter — only
`/v2/top-headlines` does. We use `category` as the primary dimension for
organizing bronze blobs and gold aggregations, so `top-headlines` is the
correct endpoint.

### Why `X-Api-Key` header not `apiKey` query param?

Security — header keeps the key out of server logs and HTTP access logs.
The Logic App stores the key as a `securestring` parameter (backed by Key Vault
in production) and passes it as a header.

### Why one blob per article, not one blob per API response?

The Event Grid subscription fires on `BlobCreated`. If we wrote the entire API
response as one blob, a single Event Grid event would need to fan out to 100
articles in the trigger — that's the enrichment function's job, not the trigger's.
One blob per article keeps the event-driven chain clean and each function
single-responsibility.

### Why fn-hash-url as a separate function?

Logic Apps have no native SHA-256 expression. The only built-in hash option is
`base64()` which is not a cryptographic hash — collisions are likely at scale.
`fn-hash-url` is a tiny HTTP-triggered function that computes SHA-256(url)[0:16]
and is called once per article. It adds one HTTP round-trip per article but
guarantees correct, collision-resistant dedup keys.

### Blob path format

```
{bronzeContainer}/{category}/{YYYY-MM-DD}/{urlHash}.json
e.g. articles-bronze/technology/2024-01-15/e9bca57a5f8d50f4.json
```

The date comes from `utcNow('yyyy-MM-dd')` at write time (not `publishedAt`) so
blobs are partitioned by ingestion date, not publication date. ADF's nightly run
scans yesterday's ingestion date to catch all articles ingested in the prior 24h.

### Idempotency

The blob write is a `PUT` — writing the same urlHash twice overwrites the
previous blob. This means Logic App re-runs (e.g. after a transient failure)
are safe. The dedup table in `fn-nlp-trigger` prevents re-enrichment.

### Error handling

- NewsAPI 429 (rate limited): Logic App HTTP action has exponential retry (3×).
  If all retries fail, the category is skipped for that poll cycle and the
  error is logged via the `Log_API_error` Compose action.
- Individual article write failure: article is skipped, others continue.
  No cross-article dependency.
- `status !== "ok"`: the `Check_API_status` If condition gates the article loop.
  Error code and message are logged.

## Deployment

### Parameters to set in Azure portal or deployment script

| Parameter | Description |
|---|---|
| `newsApiKey` | Raw NewsAPI key (no prefix, no whitespace) |
| `storageConnectionString` | Azure Storage connection string |
| `bronzeContainer` | Blob container name (default: `articles-bronze`) |
| `ingestCategories` | Comma-separated categories (default: `technology,business,science,health`) |
| `hashFunctionUrl` | Full URL of fn-hash-url Function (e.g. `https://<app>.azurewebsites.net/api/fn-hash-url`) |
| `hashFunctionKey` | Function-level key for fn-hash-url |

### Deploy via Azure CLI

```bash
az logic workflow create \
  --resource-group <rg> \
  --name nlp-pipeline-ingestor \
  --definition @logic-app/workflow.json \
  --parameters newsApiKey=<key> \
               storageConnectionString="<conn>" \
               hashFunctionUrl=https://<app>.azurewebsites.net/api/fn-hash-url \
               hashFunctionKey=<fn-key>
```

### Test manually

Trigger a single run from the Azure portal Logic Apps → Run Trigger → Run Now,
then check:
1. Bronze blobs appear at `articles-bronze/{category}/{today}/`
2. Event Grid fires and `fn-nlp-trigger` logs show articles enqueued
3. Queue depth increases
4. Silver blobs appear after `fn-enrich` processes the queue

## Monitoring

- Logic App run history: Azure portal → Logic Apps → Run History
- Failed runs show which action failed and the exact HTTP response
- Key metrics to watch: `ActionsCompleted`, `ActionsFailed`, `RunsSucceeded`