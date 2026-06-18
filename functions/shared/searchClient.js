'use strict';

/**
 * searchClient.js
 * Wraps @azure/search-documents for two operations:
 *   1. upsertDocuments   — called by fn-index-refresh to push enriched articles
 *   2. search            — called by fn-search-api for hybrid queries
 *
 * Index: SEARCH_INDEX_NAME (default: "articles")
 *
 * Batch upsert limits:
 *   - Max 1,000 documents per batch
 *   - We chunk at 1,000 and upsert sequentially
 *
 * Search strategy: hybrid (BM25 keyword + HNSW vector) with optional semantic reranking
 */

const { SearchClient, AzureKeyCredential, SearchIndexClient } = require('@azure/search-documents');
const createLogger = require('./logger');

const log = createLogger('searchClient');

const INDEX_NAME  = process.env.SEARCH_INDEX_NAME ?? 'articles';
const UPSERT_BATCH_SIZE = 1000;

let _searchClient = null;
let _indexClient  = null;

function getSearchClient() {
  if (_searchClient) return _searchClient;

  const endpoint = process.env.SEARCH_ENDPOINT;
  const apiKey   = process.env.SEARCH_API_KEY;

  if (!endpoint) throw new Error('SEARCH_ENDPOINT is not set');
  if (!apiKey)   throw new Error('SEARCH_API_KEY is not set');

  _searchClient = new SearchClient(endpoint, INDEX_NAME, new AzureKeyCredential(apiKey));
  return _searchClient;
}

function getIndexClient() {
  if (_indexClient) return _indexClient;

  const endpoint = process.env.SEARCH_ENDPOINT;
  const apiKey   = process.env.SEARCH_API_KEY;

  if (!endpoint) throw new Error('SEARCH_ENDPOINT is not set');
  if (!apiKey)   throw new Error('SEARCH_API_KEY is not set');

  _indexClient = new SearchIndexClient(endpoint, new AzureKeyCredential(apiKey));
  return _indexClient;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// ─── Upsert ───────────────────────────────────────────────────────────────────

/**
 * Upsert (merge-or-upload) documents into the Search index.
 * Key field is `id` (the url_hash).
 *
 * @param {Array<object>} documents - silver layer article objects
 * @returns {{ total, succeeded, failed, errors }}
 */
async function upsertDocuments(documents) {
  const client  = getSearchClient();
  const batches = chunk(documents, UPSERT_BATCH_SIZE);

  let succeeded = 0;
  let failed    = 0;
  const errors  = [];

  for (const [i, batch] of batches.entries()) {
    try {
      const result = await client.mergeOrUploadDocuments(batch);
      const batchSucceeded = result.results.filter(r => r.succeeded).length;
      const batchFailed    = result.results.filter(r => !r.succeeded);

      succeeded += batchSucceeded;
      failed    += batchFailed.length;

      batchFailed.forEach(r => errors.push({ key: r.key, error: r.errorMessage }));

      log.info('Upsert batch complete', {
        batchIndex: i,
        batchSize:  batch.length,
        succeeded:  batchSucceeded,
        failed:     batchFailed.length,
      });
    } catch (err) {
      log.error('Upsert batch threw', { batchIndex: i, error: err.message });
      failed += batch.length;
      errors.push({ batchIndex: i, error: err.message });
    }
  }

  return { total: documents.length, succeeded, failed, errors };
}

// ─── Search ───────────────────────────────────────────────────────────────────

/**
 * Perform a hybrid search (keyword + vector + optional semantic reranking).
 *
 * @param {object} params
 *   q           {string}   - user query text
 *   top         {number}   - max results (default 10)
 *   category    {string?}  - filter by category facet
 *   source      {string?}  - filter by source facet
 *   sentiment   {string?}  - filter by sentiment_label
 *   semantic    {boolean}  - enable semantic reranker (default false)
 *   vector      {number[]?}- pre-computed query vector (caller provides)
 *
 * @returns {{ count, results: SearchResult[] }}
 */
async function search({ q, top = 10, category, source, sentiment, semantic = false, vector, dateFilter }) {
  const client = getSearchClient();

  // Build OData filter
  const filterParts = [];
  if (category)    filterParts.push(`category eq '${category.replace(/'/g, "''")}'`);
  if (source)      filterParts.push(`source eq '${source.replace(/'/g, "''")}'`);
  if (sentiment)   filterParts.push(`sentiment_label eq '${sentiment.replace(/'/g, "''")}'`);
  if (dateFilter)  filterParts.push(dateFilter);
  const filter = filterParts.length > 0 ? filterParts.join(' and ') : undefined;

  const searchOptions = {
    top,
    filter,
    select: [
      'id', 'url', 'title', 'body_snippet', 'source', 'category',
      'published_at', 'sentiment_label', 'sentiment_score_positive',
      'entities', 'key_phrases',
    ],
    facets: ['category,count:10', 'sentiment_label,count:5'],
    includeTotalCount: true,
  };

  // Hybrid: add vector query if a vector was provided
  if (vector && Array.isArray(vector)) {
    searchOptions.vectorSearchOptions = {
      queries: [{
        kind:          'vector',
        fields:        ['content_vector'],
        vector,
        kNearestNeighborsCount: Math.max(top * 2, 50), // over-fetch for RRF
      }],
    };
  }

  // Semantic reranking (optional, costs extra Search units)
  if (semantic) {
    searchOptions.queryType    = 'semantic';
    searchOptions.semanticSearchOptions = {
      configurationName: 'semantic-config',
    };
    searchOptions.queryLanguage = 'en-us';
    // Do NOT apply scoringProfile when semantic=true.
    // The semantic cross-encoder re-scores the top-50 BM25+vector candidates.
    // If a freshness boost fires before that window is built, fresh-but-irrelevant
    // articles crowd out semantically-matched older ones before the ranker sees them.
  } else {
    // Apply recency boost only for non-semantic (keyword/vector) queries
    searchOptions.scoringProfile = 'recency-boost';
  }

  const response = await client.search(q, searchOptions);

  const results = [];
  for await (const result of response.results) {
    results.push({
      score:  result.score,
      ...result.document,
    });
  }

  // Collect facets from response
  const facets = {};
  if (response.facets) {
    const categoryFacets  = response.facets['category'];
    const sentimentFacets = response.facets['sentiment_label'];
    if (categoryFacets)  facets.categories  = categoryFacets.map(f => ({ value: f.value, count: f.count }));
    if (sentimentFacets) facets.sentiments  = sentimentFacets.map(f => ({ value: f.value, count: f.count }));
  }

  return {
    count:   response.count ?? results.length,
    results,
    facets:  Object.keys(facets).length > 0 ? facets : null,
  };
}

/**
 * Get the document count in the index (for monitoring).
 */
async function getDocumentCount() {
  const client = getSearchClient();
  return client.getDocumentsCount();
}

module.exports = {
  upsertDocuments,
  search,
  getDocumentCount,
  getSearchClient,
  getIndexClient,
};