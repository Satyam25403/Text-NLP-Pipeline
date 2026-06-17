# NewsAPI.org — Complete Agent Reference

> **Purpose:** This document is a complete, unambiguous reference for an AI agent or automated system consuming the NewsAPI.org REST API. It covers every endpoint, every request parameter, every response field, data types, constraints, edge cases, and real-world examples drawn from live API responses.

---

## 1. Overview

NewsAPI.org is a JSON REST API that aggregates news articles from over 150,000 sources worldwide. It exposes three endpoints:

| Endpoint | Path | Use case |
|---|---|---|
| Everything | `GET /v2/everything` | Full-text search across all articles from the past 5 years |
| Top Headlines | `GET /v2/top-headlines` | Live breaking headlines by country, category, or source |
| Sources | `GET /v2/top-headlines/sources` | Enumerate available publisher sources |

**Base URL:** `https://newsapi.org`

**Protocol:** HTTPS only. HTTP requests are not supported.

**Authentication:** Every request must include an API key, passed either as a query parameter (`apiKey=YOUR_KEY`) or as an HTTP header (`X-Api-Key: YOUR_KEY`). The header method is preferred for security — it keeps the key out of server logs and browser history.

**Response format:** All responses are `Content-Type: application/json`. There is no XML or CSV option.

**Rate limits (free tier):** 100 requests per day, 100 articles per request, developer use only (no production deployment). The `from` date parameter is limited to articles published within the past month.

---

## 2. Authentication

### Query parameter method
```
GET https://newsapi.org/v2/top-headlines?country=us&apiKey=YOUR_KEY
```

### HTTP header method (preferred)
```
GET https://newsapi.org/v2/top-headlines?country=us
X-Api-Key: YOUR_KEY
```

### Authentication errors

If the key is missing, invalid, or malformed (e.g. the key value accidentally contains the variable name like `NEWSAPI_KEY=abc123` instead of just `abc123`), the API returns:

```json
{
  "status": "error",
  "code": "apiKeyInvalid",
  "message": "Your API key is invalid."
}
```

Common key mistakes to avoid:
- Doubled prefix: `apiKey=NEWSAPI_KEY=abc123` — sends the literal string `NEWSAPI_KEY=abc123` as the key value, which is rejected.
- Trailing whitespace or newline characters in the key value.
- Passing the key in the request body — it must be in the query string or header.

---

## 3. Shared Response Envelope

Every response from all three endpoints shares this outer envelope:

```json
{
  "status": "ok",
  "totalResults": 6645,
  "articles": [ ... ]
}
```

| Field | Type | Always present | Description |
|---|---|---|---|
| `status` | string | yes | `"ok"` on success, `"error"` on failure |
| `totalResults` | integer | on success | Total articles matching the query across all pages. Only a subset is returned per page — use the `page` parameter to paginate. |
| `articles` | array | on success | The current page of article objects (see Section 5) |
| `code` | string | on error only | Machine-readable error code (e.g. `"apiKeyInvalid"`, `"rateLimited"`) |
| `message` | string | on error only | Human-readable description of the error |

The `sources` endpoint returns `sources` instead of `articles` — see Section 7.

---

## 4. Endpoint: Everything — `/v2/everything`

### Purpose

Full-text search across all indexed articles from the past 5 years (or past month on the free tier). Use this for news analysis, article discovery, trend monitoring, and keyword tracking.

### Request

```
GET https://newsapi.org/v2/everything
```

### Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `apiKey` | string | yes* | — | Your API key. Omit if using `X-Api-Key` header. |
| `q` | string | no | — | Keywords or phrase to search in article title, description, and content. Max 500 chars (URL-encoded). Supports advanced syntax (see below). |
| `searchIn` | string | no | all fields | Restrict `q` search to specific fields. Comma-separated from: `title`, `description`, `content`. E.g. `title,content`. |
| `sources` | string | no | — | Comma-separated list of source IDs (max 20). E.g. `bbc-news,the-verge`. Cannot be combined with `country` or `category`. |
| `domains` | string | no | — | Comma-separated domains to restrict results to. E.g. `techcrunch.com,wired.com`. |
| `excludeDomains` | string | no | — | Comma-separated domains to exclude. E.g. `example.com`. |
| `from` | string | no | oldest available | ISO 8601 date/datetime for the oldest article to return. E.g. `2026-06-17` or `2026-06-17T21:04:51`. |
| `to` | string | no | newest available | ISO 8601 date/datetime for the newest article to return. |
| `language` | string | no | all | 2-letter ISO-639-1 language code. Options: `ar de en es fr he it nl no pt ru sv ud zh`. |
| `sortBy` | string | no | `publishedAt` | Sort order. Options: `relevancy` (closest keyword match first), `popularity` (most-read sources first), `publishedAt` (newest first). |
| `pageSize` | integer | no | `100` | Articles per page. Max `100`. |
| `page` | integer | no | `1` | Page number for pagination. First page is `1`. |

### Advanced query syntax for `q`

| Syntax | Effect | Example |
|---|---|---|
| `"phrase"` | Exact phrase match | `"bitcoin halving"` |
| `+word` | Word must appear | `+bitcoin` |
| `-word` | Word must not appear | `-ethereum` |
| `AND` | Both terms required | `crypto AND regulation` |
| `OR` | Either term | `ethereum OR litecoin` |
| `NOT` | Exclude term | `crypto NOT bitcoin` |
| `(grouping)` | Logical grouping | `crypto AND (ethereum OR litecoin) NOT bitcoin` |

### Example requests

```
# All English articles about bitcoin, newest first
GET https://newsapi.org/v2/everything?q=bitcoin&language=en&sortBy=publishedAt&apiKey=KEY

# Articles from specific domains about AI
GET https://newsapi.org/v2/everything?q=artificial+intelligence&domains=wired.com,techcrunch.com&apiKey=KEY

# Exact phrase search within title only
GET https://newsapi.org/v2/everything?q="climate+change"&searchIn=title&apiKey=KEY

# Articles between specific dates
GET https://newsapi.org/v2/everything?q=bitcoin&from=2026-06-01&to=2026-06-17&apiKey=KEY
```

---

## 5. Endpoint: Top Headlines — `/v2/top-headlines`

### Purpose

Returns live breaking headlines. Articles are sorted by publication date, newest first. Designed for news tickers, dashboards, and real-time monitoring. Coverage is limited to a curated subset of major publishers (see `/v2/top-headlines/sources`).

### Request

```
GET https://newsapi.org/v2/top-headlines
```

### Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `apiKey` | string | yes* | — | Your API key. |
| `country` | string | no | — | 2-letter ISO 3166-1 country code. Currently only `us` is fully supported. Cannot be combined with `sources`. |
| `category` | string | no | — | News category. Options: `business`, `entertainment`, `general`, `health`, `science`, `sports`, `technology`. Cannot be combined with `sources`. |
| `sources` | string | no | — | Comma-separated source IDs. Cannot be combined with `country` or `category`. |
| `q` | string | no | — | Keywords to search within headlines. |
| `pageSize` | integer | no | `20` | Articles per page. Max `100`. Note: default is 20 here, unlike `/v2/everything` where default is 100. |
| `page` | integer | no | `1` | Page number for pagination. |

### Parameter exclusivity rules

The following combinations are **invalid** and will return an error:

- `country` + `sources` — cannot mix
- `category` + `sources` — cannot mix
- `country` + `category` + `sources` — cannot mix

Valid combinations:

- `country` alone
- `category` alone
- `country` + `category`
- `sources` alone
- `q` with any of the above
- No geo/category filter at all (returns global headlines)

### Example requests

```
# US technology headlines
GET https://newsapi.org/v2/top-headlines?country=us&category=technology&apiKey=KEY

# Headlines from specific sources
GET https://newsapi.org/v2/top-headlines?sources=bbc-news,the-verge&apiKey=KEY

# Search within all headlines
GET https://newsapi.org/v2/top-headlines?q=bitcoin&apiKey=KEY
```

---

## 6. Article Object — Full Field Reference

Every item in the `articles` array has this shape. Fields apply identically to both `/v2/everything` and `/v2/top-headlines` responses.

```json
{
  "source": {
    "id": "the-verge",
    "name": "The Verge"
  },
  "author": "Robert Hart",
  "title": "I went looking for the AI weed vape that gives you Bitcoin for smoking",
  "description": "The crypto weed vape found me on 4/20...",
  "url": "https://www.theverge.com/ai-artificial-intelligence/933916/...",
  "urlToImage": "https://platform.theverge.com/wp-content/uploads/...",
  "publishedAt": "2026-05-29T17:09:12Z",
  "content": "Gudtrip is the most ridiculous AI/crypto/weed product... [+9574 chars]"
}
```

### Field-by-field breakdown

#### `source` (object, always present)

A nested object identifying the publisher.

| Sub-field | Type | Nullable | Description |
|---|---|---|---|
| `source.id` | string | **yes — frequently null** | The source's machine-readable identifier in the NewsAPI system. Matches the `id` field from the `/v2/top-headlines/sources` endpoint. Is `null` for sources that are indexed by NewsAPI but not in their curated sources list (e.g. Gizmodo, Slashdot, Boing Boing). Never rely on this being non-null. |
| `source.name` | string | no | Human-readable name of the publisher. Always present. E.g. `"The Verge"`, `"Gizmodo.com"`, `"Wired"`. |

**Critical:** `source.id` is `null` for a large proportion of articles in practice. Example from live response:

```json
{ "id": null, "name": "Gizmodo.com" }   // very common
{ "id": "the-verge", "name": "The Verge" }  // only for curated sources
```

When storing this, always use `source.name` as the display value. Only use `source.id` for filtering or lookup, and always null-check it first.

---

#### `author` (string, nullable)

The byline of the article. Frequently `null`, especially for wire services, aggregator republications, and some outlets. Examples from live data:

```
"author": "Robert Hart"          // normal byline
"author": "Kyle Torpey"          // normal byline
"author": "EditorDavid"          // pseudonym / handle
"author": "Boing Boing's Shop"   // publication name used as author
"author": null                   // very common — no byline available
```

Do not assume `author` will be a person's name. It may be a team name, shop name, or null. Always null-check before use.

---

#### `title` (string, always present)

The headline of the article. Always present. May include the source name appended after a dash, e.g.:

```
"Victims ID'd in B-52 bomber crash that killed 8 at Edwards Air Force Base - CBS News"
"Struggling JetBlue shuts down key Newark, LaGuardia operations - New York Post"
```

Some publishers append their brand to the title. Strip trailing ` - Source Name` if you need a clean headline.

---

#### `description` (string, nullable)

A short excerpt or summary of the article, typically 1–3 sentences. Usually the article's meta description. May be `null` for some sources. Safe to use as a fallback text source when `content` is truncated.

---

#### `url` (string, always present)

The canonical URL of the full article. Always an HTTPS link. Use this as the unique identifier for deduplication alongside a hash — the URL itself is the natural primary key.

---

#### `urlToImage` (string, nullable)

URL of a representative image for the article. May be `null`. Can point to CDN-hosted images, publisher image servers, or generic placeholder images (some publishers reuse a generic social image). Do not assume the image is article-specific.

---

#### `publishedAt` (string, always present)

Publication timestamp in ISO 8601 format, always UTC (`Z` suffix). Format: `YYYY-MM-DDTHH:MM:SSZ`.

```
"publishedAt": "2026-05-29T17:09:12Z"
"publishedAt": "2026-06-14T11:34:00Z"
```

**Always camelCase: `publishedAt`.** Never `published_at`. This is the field name as returned by the API — do not expect snake_case.

Parse with any ISO 8601 parser. In JavaScript: `new Date(article.publishedAt)`. In Python: `datetime.fromisoformat(article['publishedAt'].replace('Z', '+00:00'))`.

---

#### `content` (string, nullable)

The article body text, **truncated to approximately 200 characters** on the free tier. The truncation point is marked with a suffix in this format:

```
"content": "Gudtrip is the most ridiculous AI/crypto/weed product to ever touch the internet... [+9574 chars]"
"content": "Earlier this week, someone burned 107 bitcoin... [+5204 chars]"
"content": "While previous bitcoin selloffs were often followed by large rebounds... [+896 chars]"
```

The `[+N chars]` suffix tells you how many additional characters exist in the full article that were not returned. Strip this suffix before using the content for NLP or display. Regex to strip: `/\s*\[[\+\d]+ chars\]\s*$/`

The `content` field may also contain:
- HTML fragments: `"<ul><li></li></ul>\r\nGudtrip is the..."` — some publishers send partial HTML
- Windows-style line endings: `\r\n`
- `null` for some sources

**Fallback chain for article text (recommended):**
1. `content` — strip `[+N chars]` suffix, strip HTML tags
2. `description` — if content is null or too short
3. `title` — last resort

---

### Complete article field summary table

| Field | Type | Nullable | Notes |
|---|---|---|---|
| `source` | object | no | Always present |
| `source.id` | string | **yes** | Null for non-curated sources — very common |
| `source.name` | string | no | Always present |
| `author` | string | yes | Often null; may be team name or handle |
| `title` | string | no | May include ` - Source Name` suffix |
| `description` | string | yes | Article meta description / snippet |
| `url` | string | no | Canonical article URL; use as dedup key |
| `urlToImage` | string | yes | May be null or generic placeholder |
| `publishedAt` | string | no | ISO 8601 UTC; always `publishedAt` camelCase |
| `content` | string | yes | Truncated ~200 chars; has `[+N chars]` suffix |

---

## 7. Endpoint: Sources — `/v2/top-headlines/sources`

### Purpose

Returns the curated list of publishers available for top headlines. Use this to discover valid `source.id` values for use in the `sources` parameter of `/v2/top-headlines` and `/v2/everything`.

### Request

```
GET https://newsapi.org/v2/top-headlines/sources
```

### Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `apiKey` | string | yes* | — | Your API key. |
| `category` | string | no | all | Filter by category: `business`, `entertainment`, `general`, `health`, `science`, `sports`, `technology`. |
| `language` | string | no | all | Filter by language (2-letter ISO-639-1). |
| `country` | string | no | all | Filter by country (2-letter ISO 3166-1). |

### Response

```json
{
  "status": "ok",
  "sources": [
    {
      "id": "abc-news",
      "name": "ABC News",
      "description": "Your trusted source for breaking news...",
      "url": "https://abcnews.go.com",
      "category": "general",
      "language": "en",
      "country": "us"
    }
  ]
}
```

### Source object fields

| Field | Type | Nullable | Description |
|---|---|---|---|
| `id` | string | no | Machine-readable identifier. Use as the `sources` parameter value in other endpoints. E.g. `"abc-news"`, `"the-verge"`, `"wired"`. |
| `name` | string | no | Display name. E.g. `"ABC News"`, `"The Verge"`, `"Wired"`. |
| `description` | string | no | Short description of the publication. |
| `url` | string | no | Homepage URL of the publication. |
| `category` | string | no | Primary news category: `business`, `entertainment`, `general`, `health`, `science`, `sports`, `technology`. |
| `language` | string | no | Language code (ISO-639-1). E.g. `"en"`, `"de"`, `"ar"`. |
| `country` | string | no | Country code (ISO 3166-1). E.g. `"us"`, `"gb"`, `"au"`. |

**Note:** Only sources that appear in this list will have a non-null `source.id` in article objects. The majority of articles in the wild come from sources that are indexed but not in this curated list — those will always have `source.id: null`.

---

## 8. Pagination

Both `/v2/everything` and `/v2/top-headlines` paginate results.

```
totalResults = 6645     (total matching articles)
pageSize     = 100      (articles per page, max 100)
page         = 1        (first page)

Total pages  = ceil(6645 / 100) = 67
```

### Pagination pattern

```
# Page 1
GET /v2/everything?q=bitcoin&pageSize=100&page=1&apiKey=KEY

# Page 2
GET /v2/everything?q=bitcoin&pageSize=100&page=2&apiKey=KEY

# Page N
GET /v2/everything?q=bitcoin&pageSize=100&page=N&apiKey=KEY
```

### Pagination limits

- Free tier: only first page accessible (developer plan limitation).
- `totalResults` reflects the total count in the index, but you may not be able to retrieve all pages depending on your plan.
- If `page` × `pageSize` exceeds the available results, the `articles` array will be empty or shorter than `pageSize`.

---

## 9. Error Responses

All errors return a JSON body with `status: "error"`, a `code`, and a `message`.

```json
{
  "status": "error",
  "code": "apiKeyInvalid",
  "message": "Your API key is invalid. Head to https://newsapi.org to create your API key."
}
```

### Common error codes

| HTTP status | `code` | Cause |
|---|---|---|
| 401 | `apiKeyInvalid` | Key is missing, wrong, or malformed |
| 401 | `apiKeyDisabled` | Key has been disabled |
| 429 | `rateLimited` | Too many requests (free tier: 100/day) |
| 400 | `parameterInvalid` | A parameter value is invalid (e.g. bad date format) |
| 400 | `parametersMissing` | Required parameter absent |
| 400 | `sourcesTooMany` | More than 20 sources specified |
| 400 | `sourceDoesNotExist` | A specified source ID does not exist |
| 426 | `upgradePlan` | Request requires a higher plan |
| 500 | `unexpectedError` | Server-side error; retry with backoff |

---

## 10. Known Data Quality Issues and Edge Cases

These are real patterns observed in live API responses. An agent must handle all of them.

### `source.id` is null for most articles

The majority of indexed articles come from publishers not in the curated sources list. `source.id` will be `null` for these. **Never use `source.id` as a primary identifier for articles or sources.**

```json
{ "id": null, "name": "Gizmodo.com" }
{ "id": null, "name": "Slashdot.org" }
{ "id": null, "name": "Boing Boing" }
```

### `content` contains HTML fragments

Some publishers return partial HTML in `content`. Strip HTML tags before NLP processing:

```json
"content": "<ul><li></li></ul>\r\nGudtrip is the most ridiculous AI/crypto/weed product..."
```

### `content` is always truncated on free tier

Free tier truncates `content` to ~200 characters and appends `[+N chars]`. The full article is not available via the API — you must fetch the article URL directly for the complete text.

```json
"content": "While previous bitcoin selloffs... [+896 chars]"
```

### `author` may be a shop, team, or pseudonym

```json
"author": "Boing Boing's Shop"   // not a person
"author": "EditorDavid"           // handle, not real name
"author": null                    // very common
```

### `title` may include source name suffix

```json
"title": "Victims ID'd in B-52 crash that killed 8 - CBS News"
```

Strip trailing ` - Source Name` if you need a clean title. Regex: `/\s*-\s*[^-]+$/`

### `urlToImage` may be a generic placeholder

Some publishers use a single shared image for all articles when no article-specific image is available:

```json
"urlToImage": "https://gizmodo.com/app/uploads/2025/10/gizmodo-social-1200x675-1.jpg"
```

This image is reused across many articles. Do not assume `urlToImage` is article-specific.

### `publishedAt` is always camelCase

The field is always `publishedAt`, never `published_at`. This is a common mistake when building schemas that convert to snake_case — the source field name from the API is camelCase and must be handled explicitly in any field mapping.

### Date-restricted content on free tier

The `/v2/everything` endpoint on the free tier only returns articles from the past 30 days. Setting `from` to a date older than 30 days will return empty results or an upgrade error, not historical data.

---

## 11. Deduplication Strategy

NewsAPI can return the same article across multiple requests (e.g. if you poll hourly). Use this approach to deduplicate:

1. Compute a hash of `article.url` (e.g. SHA-256, take first 16 hex chars).
2. Use `urlHash` as the storage key.
3. Before processing, check if `urlHash` already exists in your store.
4. The `publishedAt` + `url` combination is always unique per article.

Do not use `title` alone for deduplication — the same story often appears with slightly different titles across syndications.

---

## 12. Quick Reference — Field Types at a Glance

```
Response envelope:
  status         string    "ok" | "error"
  totalResults   integer   total matching articles
  articles       array     list of article objects
  code           string    error code (error responses only)
  message        string    error description (error responses only)

Article object:
  source.id      string?   nullable — curated sources only
  source.name    string    always present
  author         string?   nullable — often null
  title          string    always present
  description    string?   nullable
  url            string    always present — use as dedup key
  urlToImage     string?   nullable — may be generic
  publishedAt    string    ISO 8601 UTC — always camelCase
  content        string?   nullable — truncated ~200 chars on free tier

Source object (from /sources endpoint):
  id             string    source identifier
  name           string    display name
  description    string    publication description
  url            string    homepage URL
  category       string    business|entertainment|general|health|science|sports|technology
  language       string    ISO-639-1 code
  country        string    ISO 3166-1 code
```

---

## 13. Integration Checklist for Agents

Before calling the API:
- [ ] API key is the raw key value only — no variable name prefix, no extra characters
- [ ] Key is passed as `apiKey` query param or `X-Api-Key` header, not in the body
- [ ] Parameter combinations are valid (no `sources` + `country/category`)
- [ ] `q` value is URL-encoded if passed in query string
- [ ] Date values use ISO 8601 format (`YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SS`)

When processing the response:
- [ ] Check `status === "ok"` before accessing `articles`
- [ ] Null-check `source.id` before using it — assume it is null
- [ ] Null-check `author`, `description`, `urlToImage`, `content` before use
- [ ] Strip `[+N chars]` suffix from `content` before NLP processing
- [ ] Strip HTML tags from `content` before NLP processing
- [ ] Use `article.url` (or its hash) as the dedup key, not `title`
- [ ] Parse `publishedAt` as ISO 8601 UTC — field is camelCase
- [ ] Implement fallback chain: `content` → `description` → `title` for article text

---

*Generated from the NewsAPI.org official documentation and verified against live API responses as of June 2026.*