# Search API Reference

## Endpoint

```
GET https://<apim-name>.azure-api.net/search
```

In local development (no APIM):
```
GET http://localhost:7071/api/fn-search-api
```

---

## Authentication

Production (via APIM): OAuth 2.0 client credentials flow.

```bash
# Get token from Azure AD
TOKEN=$(curl -s -X POST \
  "https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/token" \
  -d "grant_type=client_credentials" \
  -d "client_id=<client-id>" \
  -d "client_secret=<client-secret>" \
  -d "scope=api://<api-app-id-uri>/.default" \
  | jq -r '.access_token')

# Use token in request
curl "https://<apim>.azure-api.net/search?q=apple+earnings" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Ocp-Apim-Subscription-Key: <subscription-key>"
```

Local development: no auth required (Function is `authLevel: anonymous`).

---

## Query Parameters

| Parameter | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|
| `q` | string | **yes** | — | max 500 chars | Search query text |
| `top` | integer | no | 10 | 1–50 | Number of results to return |
| `category` | string | no | — | see below | Filter by news category |
| `source` | string | no | — | exact match | Filter by source name (e.g. `BBC`) |
| `sentiment` | string | no | — | see below | Filter by sentiment label |
| `semantic` | boolean | no | false | `true`/`false` | Enable semantic reranker |
| `vector` | boolean | no | true | `true`/`false` | Enable vector (embedding) search |
| `from` | string | no | — | `YYYY-MM-DD` | Published date lower bound (inclusive) |
| `to` | string | no | — | `YYYY-MM-DD` | Published date upper bound (inclusive) |

### Valid `category` values
`technology`, `business`, `science`, `health`

### Valid `sentiment` values
`positive`, `negative`, `neutral`, `mixed`

---

## Search Modes

| Mode | Parameters | Use case |
|---|---|---|
| Hybrid (default) | `vector=true` (default), `semantic=false` (default) | Best all-round: BM25 + vector RRF |
| Keyword only | `vector=false` | Exact match queries, faster response |
| Hybrid + semantic | `vector=true`, `semantic=true` | Highest precision, slower, costs Search units |
| Semantic only | `vector=false`, `semantic=true` | Pure cross-encoder reranking on BM25 |

**Note on scoring:** When `semantic=false`, the `recency-boost` scoring profile applies — articles from the last 7 days receive up to 2× relevance boost with logarithmic decay. When `semantic=true`, no scoring profile is applied — the cross-encoder reranker controls ordering.

---

## Response

### 200 OK

```json
{
  "query": {
    "q": "Apple earnings",
    "top": 10,
    "filters": {
      "category": "technology",
      "source": null,
      "sentiment": null,
      "from": null,
      "to": null
    },
    "semantic": false,
    "vector": true
  },
  "count": 42,
  "results": [
    {
      "score": 0.9421,
      "id": "e9bca57a5f8d50f4",
      "url": "https://www.theverge.com/2024/01/15/apple-q1-earnings",
      "title": "Apple reports record quarterly earnings",
      "source": "The Verge",
      "category": "technology",
      "publishedAt": "2024-01-15T17:09:12Z",
      "sentimentLabel": "positive",
      "sentimentScore": 0.9,
      "entities": ["Apple", "Tim Cook", "Cupertino"],
      "keyPhrases": ["record earnings", "quarterly results", "revenue growth"]
    }
  ],
  "facets": {
    "categories": [
      { "value": "technology", "count": 38 },
      { "value": "business",   "count": 4 }
    ],
    "sentiments": [
      { "value": "positive", "count": 30 },
      { "value": "neutral",  "count": 8 },
      { "value": "negative", "count": 4 }
    ]
  },
  "durationMs": 142,
  "warning": null
}
```

### Response Fields

| Field | Type | Description |
|---|---|---|
| `query` | object | Echo of the parsed request parameters — useful for client-side debugging |
| `query.vector` | boolean | `true` if vector embedding was successfully computed and used |
| `count` | integer | Total matching documents in the index (not just the returned page) |
| `results` | array | Ranked result documents |
| `results[].score` | number | RRF or semantic relevance score (not comparable across queries) |
| `results[].id` | string | URL hash — stable identifier for this article |
| `results[].publishedAt` | string | ISO 8601 UTC timestamp (camelCase — matches NewsAPI source) |
| `results[].sentimentLabel` | string | `positive` \| `negative` \| `neutral` \| `mixed` |
| `results[].sentimentScore` | number | Positive sentiment confidence (0.0–1.0) |
| `results[].entities` | string[] | Named entities detected by Language API |
| `results[].keyPhrases` | string[] | Key phrases extracted by Language API |
| `facets` | object | Category and sentiment breakdowns for drill-down UI |
| `durationMs` | integer | End-to-end function execution time in milliseconds |
| `warning` | string \| null | Present when vector embedding failed and keyword fallback was used |

### 400 Bad Request

```json
{ "error": "Query parameter \"q\" is required" }
{ "error": "\"category\" must be one of: technology, business, science, health" }
{ "error": "\"from\" cannot be later than \"to\"" }
```

### 401 Unauthorized (APIM only)

```json
{ "statusCode": 401, "message": "Unauthorized: valid Bearer token required" }
```

### 429 Too Many Requests (APIM only)

```json
{ "statusCode": 429, "message": "Rate limit is exceeded." }
```
Headers: `Retry-After: <seconds>`, `X-RateLimit-Remaining: 0`

### 500 Internal Server Error

```json
{ "error": "Search service unavailable. Please try again shortly." }
```

---

## Examples

### Basic keyword search

```bash
curl "https://<apim>.azure-api.net/search?q=Apple+earnings" \
  -H "Authorization: Bearer $TOKEN"
```

### Category filter + recency sort (default)

```bash
curl "https://<apim>.azure-api.net/search?q=electric+vehicles&category=technology&top=5"
```

### Semantic search (highest precision)

```bash
curl "https://<apim>.azure-api.net/search?q=climate+policy+impact+on+agriculture&semantic=true&top=10"
```

### Sentiment filter — negative business news

```bash
curl "https://<apim>.azure-api.net/search?q=layoffs&category=business&sentiment=negative"
```

### Date range query

```bash
curl "https://<apim>.azure-api.net/search?q=interest+rates&from=2024-01-01&to=2024-01-31"
```

### Keyword-only (no vector embedding, faster)

```bash
curl "https://<apim>.azure-api.net/search?q=Tim+Cook&vector=false"
```

### Combined filters

```bash
curl "https://<apim>.azure-api.net/search?q=AI&category=technology&sentiment=positive&from=2024-01-10&top=20"
```

---

## Rate Limits

| Limit | Value |
|---|---|
| Calls per minute per subscription | 100 |
| Response cache TTL (200 OK) | 60 seconds |
| Response cache TTL (4xx/5xx) | 5 seconds |
| Max `top` per query | 50 |
| Max `q` length | 500 characters |

---

## Response Headers

| Header | Description |
|---|---|
| `X-RateLimit-Remaining` | Remaining calls in the current 60s window |
| `Retry-After` | Seconds to wait before retrying (present on 429) |
| `X-Cache` | `HIT` (served from cache) or `MISS` (called Function) |
| `Access-Control-Allow-Origin` | CORS header — tighten in production |

---

## Caching Behaviour

Responses are cached in APIM for 60 seconds. Two requests with identical query strings within 60 seconds will return the same response (`X-Cache: HIT`). Any change to any of the 9 query parameters produces a cache miss.

**Implication:** Articles indexed by the nightly ADF run will not appear in search results until the 60s cache expires for the affected query pattern.