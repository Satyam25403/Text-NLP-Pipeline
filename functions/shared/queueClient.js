'use strict';

/**
 * queueClient.js
 * Wraps @azure/storage-queue for the article enrichment queue.
 *
 * Queue: QUEUE_ENRICH (default: "article-enrich-queue")
 *
 * Message shape (JSON):
 * {
 *   blobPath:    "technology/2024-01-15/abc123.json",
 *   urlHash:     "abc123",
 *   category:    "technology",
 *   ingestedAt:  "2024-01-15T02:00:00Z"
 * }
 *
 * Azure Storage Queue limits:
 *   - Max message size: 64 KB
 *   - Max TTL: 7 days (default)
 *   - Visibility timeout used for processing lock
 */

const { QueueClient } = require('@azure/storage-queue');
const createLogger = require('./logger');

const log = createLogger('queueClient');

const QUEUE_NAME = process.env.QUEUE_ENRICH ?? 'article-enrich-queue';

// Visibility timeout for processing: 5 minutes
// If fn-enrich crashes, the message reappears after this window
const VISIBILITY_TIMEOUT_SECS = 300;

let _client = null;

async function getClient() {
  if (_client) return _client;

  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connStr) throw new Error('AZURE_STORAGE_CONNECTION_STRING is not set');

  const client = new QueueClient(connStr, QUEUE_NAME);
  await client.createIfNotExists();
  _client = client;
  return _client;
}

// ─── Enqueue ──────────────────────────────────────────────────────────────────

/**
 * Enqueue a single article reference for enrichment.
 * The message is base64-encoded automatically by the SDK.
 */
async function enqueueArticle({ blobPath, urlHash, category, ingestedAt }) {
  const client  = await getClient();
  const message = JSON.stringify({ blobPath, urlHash, category, ingestedAt });

  const result = await client.sendMessage(message);
  log.debug('Enqueued article', { urlHash, messageId: result.messageId });
  return result.messageId;
}

/**
 * Enqueue multiple articles at once.
 * Fires all sends in parallel (respects Queue's 20 concurrent connection limit
 * at our volume — max 100 articles/day is well within bounds).
 */
async function enqueueArticles(articles) {
  const results = await Promise.allSettled(articles.map(enqueueArticle));

  const failed = results.filter(r => r.status === 'rejected');
  if (failed.length > 0) {
    log.error('Some enqueue operations failed', {
      total:  articles.length,
      failed: failed.length,
      errors: failed.map(r => r.reason?.message),
    });
  }

  return {
    total:    articles.length,
    enqueued: results.filter(r => r.status === 'fulfilled').length,
    failed:   failed.length,
  };
}

// ─── Receive (for testing / manual drain) ────────────────────────────────────

/**
 * Peek at messages without dequeuing (for monitoring/debug).
 * Returns up to 32 messages (Queue max).
 */
async function peekMessages(count = 10) {
  const client = await getClient();
  const result = await client.peekMessages({ numberOfMessages: Math.min(count, 32) });
  return result.peekedMessageItems.map(m => {
    try {
      return JSON.parse(Buffer.from(m.messageText, 'base64').toString('utf-8'));
    } catch {
      return m.messageText;
    }
  });
}

/**
 * Get approximate queue depth (useful for monitoring).
 */
async function getQueueDepth() {
  const client     = await getClient();
  const properties = await client.getProperties();
  return properties.approximateMessagesCount ?? 0;
}

module.exports = {
  enqueueArticle,
  enqueueArticles,
  peekMessages,
  getQueueDepth,
  VISIBILITY_TIMEOUT_SECS,
  QUEUE_NAME,
};