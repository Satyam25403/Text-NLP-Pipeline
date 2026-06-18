'use strict';

/**
 * fn-index-refresh
 * Trigger: HTTP POST (called by ADF as the last activity in the nightly pipeline)
 *
 * What it does:
 *   1. Accepts an optional { date, category } body to scope the refresh
 *      - If date is omitted → uses yesterday's date (standard nightly run)
 *      - If category is omitted → refreshes all categories
 *   2. Lists silver blobs matching the scope
 *   3. Reads each silver doc, maps it to the Search index schema
 *   4. Upserts to Azure AI Search in batches of 1000
 *   5. Returns a JSON summary { processed, succeeded, failed, errors[] }
 *
 * Called by ADF Web Activity:
 *   POST https://<fn-app>.azurewebsites.net/api/fn-index-refresh?code=<key>
 *   Body: { "date": "2024-01-15", "category": "technology" }   (both optional)
 *
 * Auth: function-level key (ADF stores it in Key Vault linked service)
 *
 * Idempotent: mergeOrUpload means running twice for the same date is safe.
 * Documents are keyed on `id` (url_hash) so re-runs overwrite not duplicate.
 */

const { listBlobs, readJson }          = require('../shared/blobClient');
const { upsertDocuments }              = require('../shared/searchClient');
const { INGEST_CATEGORIES, CONTAINERS } = require('../shared/config');
const createLogger                     = require('../shared/logger');

const log = createLogger('fn-index-refresh');

const SILVER_CONTAINER = CONTAINERS.SILVER;

// Driven by shared config — add categories there, not here
const ALL_CATEGORIES = INGEST_CATEGORIES;

module.exports = async function (context, req) {
  const startedAt = Date.now();
  log.info('Index refresh triggered', { body: req.body });

  // ── Parse request body ───────────────────────────────────────────────────
  const body     = req.body ?? {};
  const date     = body.date     ?? _yesterday();
  const category = body.category ?? null; // null → all categories

  if (!_isValidDate(date)) {
    context.res = {
      status: 400,
      body:   { error: `Invalid date format: "${date}". Expected YYYY-MM-DD.` },
    };
    return;
  }

  const categories = category ? [category] : ALL_CATEGORIES;
  log.info('Refresh scope', { date, categories });

  // ── Collect all silver blob paths for this scope ─────────────────────────
  let allBlobPaths = [];
  for (const cat of categories) {
    const prefix = `${cat}/${date}/`;
    try {
      const paths = await listBlobs(SILVER_CONTAINER, prefix);
      log.info('Listed silver blobs', { category: cat, date, count: paths.length });
      allBlobPaths = allBlobPaths.concat(paths);
    } catch (err) {
      log.error('Failed to list silver blobs', { category: cat, date, error: err.message });
      context.res = {
        status: 502,
        body:   { error: `Failed to list silver blobs for ${cat}/${date}: ${err.message}` },
      };
      return;
    }
  }

  if (allBlobPaths.length === 0) {
    log.info('No silver blobs found for scope', { date, categories });
    context.res = {
      status: 200,
      body:   { processed: 0, succeeded: 0, failed: 0, errors: [], date, categories, durationMs: Date.now() - startedAt },
    };
    return;
  }

  log.info('Total silver blobs to index', { count: allBlobPaths.length });

  // ── Read each silver doc and map to Search schema ────────────────────────
  const documents = [];
  const readErrors = [];

  // Read blobs concurrently in chunks of 20 to avoid hammering Storage
  const READ_CONCURRENCY = 20;
  for (let i = 0; i < allBlobPaths.length; i += READ_CONCURRENCY) {
    const chunk   = allBlobPaths.slice(i, i + READ_CONCURRENCY);
    const results = await Promise.allSettled(
      chunk.map(blobPath => readJson(SILVER_CONTAINER, blobPath)),
    );

    results.forEach((result, idx) => {
      const blobPath = chunk[idx];
      if (result.status === 'rejected') {
        log.warn('Failed to read silver blob', { blobPath, error: result.reason?.message });
        readErrors.push({ blobPath, error: result.reason?.message });
        return;
      }
      const doc = result.value;
      if (!doc) {
        readErrors.push({ blobPath, error: 'Blob returned null' });
        return;
      }
      const mapped = _mapToSearchDoc(doc);
      if (mapped) documents.push(mapped);
    });
  }

  log.info('Silver docs read', { total: allBlobPaths.length, mapped: documents.length, readErrors: readErrors.length });

  // ── Upsert to Azure AI Search ────────────────────────────────────────────
  let upsertResult = { total: 0, succeeded: 0, failed: 0, errors: [] };
  if (documents.length > 0) {
    try {
      upsertResult = await upsertDocuments(documents);
      log.info('Upsert complete', upsertResult);
    } catch (err) {
      log.error('Upsert threw unexpectedly', { error: err.message });
      context.res = {
        status: 502,
        body:   { error: `Search upsert failed: ${err.message}` },
      };
      return;
    }
  }

  // ── Build response ────────────────────────────────────────────────────────
  const allErrors = [...readErrors, ...upsertResult.errors];
  const response  = {
    date,
    categories,
    processed:  allBlobPaths.length,
    succeeded:  upsertResult.succeeded,
    failed:     readErrors.length + upsertResult.failed,
    errors:     allErrors.slice(0, 50), // cap at 50 to keep response reasonable
    durationMs: Date.now() - startedAt,
  };

  const status = upsertResult.failed > 0 || readErrors.length > 0 ? 207 : 200;
  // 207 Multi-Status signals ADF that partial failure occurred (pipeline can alert on this)

  log.info('Index refresh complete', response);
  context.res = { status, body: response };
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Map a silver layer document to the Azure AI Search index schema.
 * Drops any fields the index doesn't know about.
 * Returns null if the doc is missing the required `id` field.
 */
function _mapToSearchDoc(doc) {
  if (!doc?.id) return null;

  return {
    id:              doc.id,
    url:             doc.url             ?? null,
    title:           doc.title           ?? null,
    body_snippet:    doc.body_snippet    ?? null,
    source:          doc.source          ?? null,
    category:        doc.category        ?? null,
    published_at:    doc.publishedAt     ?? doc.published_at ?? null,
    sentiment_label: doc.sentiment?.label ?? null,
    sentiment_score: doc.sentiment?.scores?.positive ?? null,
    entities:        (doc.entities ?? []).map(e => e.text),   // Search stores string[]
    key_phrases:     doc.keyPhrases      ?? [],
    content_vector:  doc.content_vector  ?? null,             // null → field not set in index
  };
}

/**
 * Returns yesterday's date as YYYY-MM-DD (default scope for nightly run).
 */
function _yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

/**
 * Validates that a string matches YYYY-MM-DD format.
 */
function _isValidDate(str) {
  return /^\d{4}-\d{2}-\d{2}$/.test(str) && !isNaN(Date.parse(str));
}

// Export helpers for testing
module.exports._mapToSearchDoc  = _mapToSearchDoc;
module.exports._yesterday       = _yesterday;
module.exports._isValidDate     = _isValidDate;
module.exports._ALL_CATEGORIES  = ALL_CATEGORIES;