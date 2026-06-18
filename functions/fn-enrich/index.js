'use strict';

/**
 * fn-enrich
 * Trigger: Azure Storage Queue ("article-enrich-queue")
 *
 * Receives a single article reference per invocation (host.json batchSize=1
 * for simplicity — Language API batching is handled inside enrichArticles()).
 *
 * Pipeline per article:
 *   1. Parse queue message
 *   2. Check if already enriched (silver blob exists) → skip if so (idempotent)
 *   3. Read raw article from bronze blob
 *   4. Extract text (content → description fallback → title-only fallback)
 *   5. Call Language API + Azure OpenAI in PARALLEL
 *   6. Merge into silver schema
 *   7. Write silver blob to ADLS
 *   8. Mark dedup table as processed
 *   9. Write audit event
 *
 * On failure:
 *   - Article is written to error/ container with error metadata
 *   - Function does NOT rethrow — this prevents poison-message infinite loops
 *   - After maxDequeueCount (5) retries the queue SDK moves it to the poison queue
 *
 * Message shape (from fn-nlp-trigger):
 * {
 *   blobPath:   "technology/2024-01-15/abc123.json",
 *   urlHash:    "abc123",
 *   category:   "technology",
 *   ingestedAt: "2024-01-15T02:00:00Z"
 * }
 */

const { readJson, writeJson, exists, buildBlobPath } = require('../shared/blobClient');
const { enrichArticles, hasPii }                      = require('../shared/languageClient');
const { embedText, buildEmbeddingInput }              = require('../shared/openaiClient');
const { markIngested, logAuditEvent }                 = require('../shared/tableClient');
const { CONTAINERS }                                  = require('../shared/config');
const createLogger                                    = require('../shared/logger');

const log = createLogger('fn-enrich');

const BRONZE_CONTAINER = CONTAINERS.BRONZE;
const SILVER_CONTAINER = CONTAINERS.SILVER;
const ERROR_CONTAINER  = CONTAINERS.ERROR;

// Max chars to store as body_snippet in the silver layer + Search index
const BODY_SNIPPET_MAX = 500;

module.exports = async function (context, queueMessage) {
  // Queue messages arrive as a string — parse it
  let msg;
  try {
    msg = typeof queueMessage === 'string' ? JSON.parse(queueMessage) : queueMessage;
  } catch (err) {
    log.error('Unparseable queue message — dropping', { raw: queueMessage, error: err.message });
    return; // non-retryable
  }

  const { blobPath, urlHash, category, ingestedAt } = msg;

  if (!blobPath || !urlHash || !category) {
    log.error('Queue message missing required fields — dropping', { msg });
    return; // non-retryable
  }

  log.info('Enrichment started', { urlHash, category });

  // ── Idempotency: skip if silver already exists ──────────────────────────
  const silverPath = buildBlobPath(category, _dateFromBlobPath(blobPath), urlHash);
  try {
    const alreadyEnriched = await exists(SILVER_CONTAINER, silverPath);
    if (alreadyEnriched) {
      log.info('Silver blob already exists — skipping', { urlHash, silverPath });
      return;
    }
  } catch (err) {
    // Storage unavailable — let the queue retry
    log.error('Could not check silver existence', { urlHash, error: err.message });
    throw err;
  }

  // ── Read raw article from bronze ─────────────────────────────────────────
  let rawArticle;
  try {
    rawArticle = await readJson(BRONZE_CONTAINER, blobPath);
  } catch (err) {
    log.error('Failed to read bronze blob', { urlHash, blobPath, error: err.message });
    throw err; // let queue retry
  }

  if (!rawArticle) {
    log.error('Bronze blob not found — dropping message', { urlHash, blobPath });
    return;
  }

  // ── Extract text ─────────────────────────────────────────────────────────
  const articleText = _extractText(rawArticle);
  const bodySnippet = articleText.substring(0, BODY_SNIPPET_MAX);

  log.debug('Text extracted', {
    urlHash,
    textLength: articleText.length,
    truncated: articleText.length > BODY_SNIPPET_MAX,
    source: _textSource(rawArticle),
  });

  // ── NLP enrichment + embedding in PARALLEL ───────────────────────────────
  let nlpResult, embeddingResult;
  try {
    [nlpResult, embeddingResult] = await Promise.all([
      enrichArticles([{ id: urlHash, text: articleText }]).then(r => r[0]),
      embedText(buildEmbeddingInput(rawArticle.title, bodySnippet)),
    ]);
  } catch (err) {
    // Unexpected top-level failure (network down etc.) — write to error container
    log.error('Enrichment threw unexpectedly', { urlHash, error: err.message });
    await _writeError(urlHash, blobPath, category, { error: err.message, stage: 'enrichment' });
    return; // don't rethrow — individual article failure shouldn't poison the queue
  }

  // ── Build silver document ────────────────────────────────────────────────
  const silverDoc = _buildSilverDoc({
    rawArticle,
    urlHash,
    category,
    ingestedAt,
    bodySnippet,
    nlpResult,
    embeddingResult,
  });

  // ── Write silver blob ────────────────────────────────────────────────────
  try {
    await writeJson(SILVER_CONTAINER, silverPath, silverDoc);
    log.info('Silver blob written', { urlHash, silverPath });
  } catch (err) {
    log.error('Failed to write silver blob', { urlHash, error: err.message });
    throw err; // retryable — storage may be temporarily unavailable
  }

  // ── Mark dedup table as processed ───────────────────────────────────────
  markIngested(urlHash, {
    url:        rawArticle.url ?? '',
    category,
    ingestedAt: ingestedAt ?? new Date().toISOString(),
  }).catch(err => log.warn('markIngested failed (non-fatal)', { urlHash, error: err.message }));

  // ── Audit ────────────────────────────────────────────────────────────────
  logAuditEvent(urlHash, 'enrich_complete', {
    silverPath,
    nlpStatus:    nlpResult?.nlpStatus,
    vectorStatus: embeddingResult?.vectorStatus,
    hasPii:       silverDoc.hasPii,
  }).catch(err => log.warn('Audit log failed (non-fatal)', { urlHash, error: err.message }));

  log.info('Enrichment complete', {
    urlHash,
    nlpStatus:    nlpResult?.nlpStatus,
    vectorStatus: embeddingResult?.vectorStatus,
  });
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract the best available text from a raw NewsAPI article.
 *
 * NewsAPI free tier often truncates `content` at 200 chars with "[+N chars]".
 * Fallback chain: content (stripped) → description → title
 */
function _extractText(article) {
  if (article.content && article.content.trim().length > 0) {
    // Strip the "[+N chars]" truncation marker NewsAPI adds
    return article.content.replace(/\s*\[[\+\d]+ chars\]\s*$/, '').trim();
  }
  if (article.description && article.description.trim().length > 0) {
    return article.description.trim();
  }
  return article.title?.trim() ?? '';
}

/**
 * Returns which field was used as text source (for debug logging).
 */
function _textSource(article) {
  if (article.content?.trim()) return 'content';
  if (article.description?.trim()) return 'description';
  return 'title';
}

/**
 * Extract date string from blob path: "category/YYYY-MM-DD/hash.json" → "YYYY-MM-DD"
 */
function _dateFromBlobPath(blobPath) {
  return blobPath.split('/')[1] ?? new Date().toISOString().split('T')[0];
}

/**
 * Build the silver layer document from all enrichment results.
 */
function _buildSilverDoc({ rawArticle, urlHash, category, ingestedAt, bodySnippet, nlpResult, embeddingResult }) {
  return {
    // Identity
    id:          urlHash,
    url:         rawArticle.url         ?? null,
    title:       rawArticle.title       ?? null,
    body_snippet: bodySnippet           ?? null,
    source:      rawArticle.source?.name ?? rawArticle.source ?? null,
    category,
    publishedAt: rawArticle.publishedAt ?? null,
    author:      rawArticle.author       ?? null,

    // NLP
    nlpStatus:   nlpResult?.nlpStatus   ?? 'unknown',
    nlpError:    nlpResult?.nlpError    ?? null,
    sentiment: nlpResult?.sentiment ?? null,
    entities:    nlpResult?.entities    ?? [],
    keyPhrases:  nlpResult?.keyPhrases  ?? [],
    hasPii:      hasPii(nlpResult?.entities),

    // Embeddings
    content_vector: embeddingResult?.vector       ?? null,
    vectorStatus:   embeddingResult?.vectorStatus ?? 'unknown',
    vectorError:    embeddingResult?.vectorError  ?? null,

    // Metadata
    ingestedAt,
    enrichedAt: new Date().toISOString(),
    contentTruncated: !!(rawArticle.content?.includes('[+') && rawArticle.content?.includes('chars]')),
  };
}

/**
 * Write a failed article to the error container for later inspection/retry.
 */
async function _writeError(urlHash, blobPath, category, errorMeta) {
  try {
    const dateStr  = _dateFromBlobPath(blobPath);
    const errorPath = `${category}/${dateStr}/${urlHash}.json`;
    await writeJson(ERROR_CONTAINER, errorPath, {
      urlHash,
      blobPath,
      category,
      errorMeta,
      failedAt: new Date().toISOString(),
    });
  } catch (writeErr) {
    // Error container write failing is not worth crashing over
    log.warn('Could not write to error container', { urlHash, error: writeErr.message });
  }
}