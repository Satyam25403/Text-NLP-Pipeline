'use strict';

/**
 * fn-search-api
 * Trigger: HTTP GET — consumer-facing search endpoint
 *
 * Sits behind APIM which handles:
 *   - JWT validation (OAuth 2.0 client credentials)
 *   - Rate limiting (100 req/min per subscription key)
 *   - Response caching (60s TTL for identical query strings)
 *
 * This function is therefore authLevel: anonymous — APIM is the security boundary.
 *
 * Query parameters:
 *   q          {string}   search query text (required, max 500 chars)
 *   top        {number}   results to return, default 10, max 50
 *   category   {string}   filter: technology|business|science|health
 *   source     {string}   filter: exact source name (e.g. "BBC")
 *   sentiment  {string}   filter: positive|negative|neutral|mixed
 *   semantic   {boolean}  enable semantic reranker (default false — costs more Search units)
 *   vector     {boolean}  enable vector search (default true — requires embedding call)
 *   from       {string}   ISO date lower bound for published_at filter (YYYY-MM-DD)
 *   to         {string}   ISO date upper bound for published_at filter (YYYY-MM-DD)
 *
 * Response 200:
 * {
 *   query:    { q, top, filters, semantic, vector },
 *   count:    number,
 *   results:  [{ score, id, url, title, source, category, publishedAt,
 *                sentiment_label, sentiment_score_positive, entities, key_phrases }],
 *   facets:   { categories: [{value, count}], sentiments: [{value, count}] },
 *   durationMs: number
 * }
 *
 * Response 400: { error: string }
 * Response 500: { error: string }
 *
 * Architecture note on vector search:
 *   When vector=true, this function embeds the query text with Azure OpenAI
 *   (same ada-002 model used at index time) before calling AI Search.
 *   The Search SDK sends both the text query (BM25) and the vector query,
 *   AI Search merges them with Reciprocal Rank Fusion (RRF).
 *   If embedding fails, we fall back to keyword-only search and note it in the response.
 */

const { search }                       = require('../shared/searchClient');
const { embedText,
        buildEmbeddingInput }          = require('../shared/openaiClient');
const { INGEST_CATEGORIES }            = require('../shared/config');
const createLogger                     = require('../shared/logger');

const log = createLogger('fn-search-api');

const MAX_Q_LENGTH = 500;
const MAX_TOP      = 50;
const DEFAULT_TOP  = 10;

module.exports = async function (context, req) {
  const startedAt = Date.now();

  // ── Parse + validate query params ─────────────────────────────────────────
  const parsed = _parseParams(req.query);
  if (parsed.error) {
    context.res = { status: 400, body: { error: parsed.error } };
    return;
  }

  const { q, top, category, source, sentiment, semantic, vector, from, to } = parsed;

  log.info('Search request', { q, top, category, source, sentiment, semantic, vector });

  // ── Embed query if vector search is enabled ──────────────────────────────
  let queryVector   = null;
  let vectorWarning = null;

  if (vector) {
    try {
      const embResult = await embedText(buildEmbeddingInput(q, null));
      if (embResult.vectorStatus === 'ok') {
        queryVector = embResult.vector;
      } else {
        vectorWarning = `Vector embedding failed (${embResult.vectorStatus}) — falling back to keyword search`;
        log.warn(vectorWarning, { q });
      }
    } catch (err) {
      vectorWarning = 'Vector embedding threw unexpectedly — falling back to keyword search';
      log.error(vectorWarning, { q, error: err.message });
    }
  }

  // ── Build date filter ─────────────────────────────────────────────────────
  let dateFilter = null;
  if (from || to) {
    const parts = [];
    if (from) parts.push(`published_at ge ${from}T00:00:00Z`);
    if (to)   parts.push(`published_at le ${to}T23:59:59Z`);
    dateFilter = parts.join(' and ');
  }

  // ── Call Azure AI Search ──────────────────────────────────────────────────
  let searchResult;
  try {
    searchResult = await search({
      q,
      top,
      category,
      source,
      sentiment,
      semantic,
      vector:     queryVector,
      dateFilter,
    });
  } catch (err) {
    log.error('Search call failed', { q, error: err.message });
    context.res = {
      status: 500,
      body:   { error: 'Search service unavailable. Please try again shortly.' },
    };
    return;
  }

  // ── Build response ────────────────────────────────────────────────────────
  const response = {
    query: {
      q,
      top,
      filters:  { category: category ?? null, source: source ?? null, sentiment: sentiment ?? null, from: from ?? null, to: to ?? null },
      semantic,
      vector:   !!queryVector,
    },
    count:      searchResult.count,
    results:    searchResult.results.map(_formatResult),
    facets:     searchResult.facets ?? null,
    durationMs: Date.now() - startedAt,
  };

  if (vectorWarning) response.warning = vectorWarning;

  log.info('Search complete', {
    q,
    count:      searchResult.count,
    returned:   searchResult.results.length,
    durationMs: response.durationMs,
  });

  context.res = { status: 200, body: response };
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse and validate all query parameters.
 * Returns { error } on validation failure, otherwise the parsed params.
 */
function _parseParams(query = {}) {
  // q is required
  const q = (query.q ?? '').trim();
  if (!q) {
    return { error: 'Query parameter "q" is required' };
  }
  if (q.length > MAX_Q_LENGTH) {
    return { error: `Query parameter "q" must be ${MAX_Q_LENGTH} characters or fewer` };
  }

  // top — default 10, max 50
  let top = DEFAULT_TOP;
  if (query.top !== undefined) {
    top = parseInt(query.top, 10);
    if (isNaN(top) || top < 1) {
      return { error: '"top" must be a positive integer' };
    }
    if (top > MAX_TOP) {
      return { error: `"top" cannot exceed ${MAX_TOP}` };
    }
  }

  // category — must be one of the valid NewsAPI categories
  // Driven from shared/config.js — same source as fn-index-refresh and Databricks.
  // Adding a category to INGEST_CATEGORIES automatically makes it valid here.
  const VALID_CATEGORIES = new Set(INGEST_CATEGORIES);
  const category = query.category?.trim().toLowerCase() ?? null;
  if (category && !VALID_CATEGORIES.has(category)) {
    return { error: `"category" must be one of: ${[...VALID_CATEGORIES].join(', ')}` };
  }

  // sentiment — must be valid label
  const VALID_SENTIMENTS = new Set(['positive', 'negative', 'neutral', 'mixed']);
  const sentiment = query.sentiment?.trim().toLowerCase() ?? null;
  if (sentiment && !VALID_SENTIMENTS.has(sentiment)) {
    return { error: `"sentiment" must be one of: ${[...VALID_SENTIMENTS].join(', ')}` };
  }

  // source — free text, no validation needed (will just return empty results if wrong)
  const source = query.source?.trim() ?? null;

  // semantic — boolean flag
  const semantic = query.semantic === 'true' || query.semantic === '1';

  // vector — boolean flag, default true
  const vector = query.vector !== 'false' && query.vector !== '0';

  // date filters — validate ISO date format
  const from = query.from?.trim() ?? null;
  const to   = query.to?.trim()   ?? null;

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  if (from && !DATE_RE.test(from)) {
    return { error: '"from" must be in YYYY-MM-DD format' };
  }
  if (to && !DATE_RE.test(to)) {
    return { error: '"to" must be in YYYY-MM-DD format' };
  }
  if (from && to && from > to) {
    return { error: '"from" cannot be later than "to"' };
  }

  return { q, top, category, source, sentiment, semantic, vector, from, to };
}

/**
 * Format a raw Search result document for the API response.
 * Strips internal fields, normalises nulls, ensures consistent shape.
 */
function _formatResult(result) {
  return {
    score:           result.score         ?? null,
    id:              result.id            ?? null,
    url:             result.url           ?? null,
    title:           result.title         ?? null,
    source:          result.source        ?? null,
    category:        result.category      ?? null,
    publishedAt:     result.published_at  ?? null,  // Search index stores as published_at
    sentimentLabel:  result.sentiment_label ?? null,
    sentimentScore:  result.sentiment_score_positive ?? null,
    entities:        result.entities      ?? [],
    keyPhrases:      result.key_phrases   ?? [],
  };
}

// Export helpers for testing
module.exports._parseParams   = _parseParams;
module.exports._formatResult  = _formatResult;