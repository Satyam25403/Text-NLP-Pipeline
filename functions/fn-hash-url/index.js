'use strict';

/**
 * fn-hash-url
 * Trigger: HTTP POST (called by Logic App once per article)
 *
 * Logic Apps have no native SHA-256 expression. This tiny function
 * fills that gap — it takes an article URL and returns the 16-char
 * hex hash used as the blob filename and dedup key throughout the pipeline.
 *
 * Request body:
 *   { "url": "https://www.theverge.com/2024/01/15/article" }
 *
 * Response:
 *   { "urlHash": "e9bca57a5f8d50f4", "url": "https://..." }
 *
 * Hash: SHA-256(url) → first 16 hex characters
 * Collision probability at 10,000 articles/day: negligible (~5.4×10⁻¹³)
 *
 * Called by Logic App "Compute_url_hash" action before writing each blob.
 * Auth: function-level key (stored in Logic App connection parameter).
 */

const crypto       = require('crypto');
const createLogger = require('../shared/logger');

const log = createLogger('fn-hash-url');

module.exports = async function (context, req) {
  const url = req.body?.url;

  if (!url || typeof url !== 'string' || url.trim().length === 0) {
    context.res = {
      status: 400,
      body:   { error: 'Request body must contain a non-empty "url" string' },
    };
    return;
  }

  const trimmedUrl = url.trim();
  const urlHash    = crypto
    .createHash('sha256')
    .update(trimmedUrl)
    .digest('hex')
    .substring(0, 16);

  log.debug('URL hashed', { urlHash, urlLength: trimmedUrl.length });

  context.res = {
    status: 200,
    body:   { urlHash, url: trimmedUrl },
  };
};