'use strict';

/**
 * languageClient.js
 * Wraps @azure/ai-text-analytics for the NLP enrichment step.
 *
 * Calls made per batch of articles:
 *   1. analyzeSentiment    → label (positive/negative/neutral/mixed) + confidence scores
 *   2. recognizeEntities   → named entities with category, subcategory, confidence
 *   3. extractKeyPhrases   → key phrases array
 *
 * Language API batch limits:
 *   - Max 10 documents per request   ← we chunk at 10
 *   - Max 5,120 characters per document
 *   - We truncate article text to 5,000 chars before sending
 *
 * Error handling:
 *   - Per-document errors are captured individually (partial failure)
 *   - A document that fails NLP still gets an embedding — we store it
 *     with nlpStatus: 'failed' and nlpError: <message>
 */

const { TextAnalyticsClient, AzureKeyCredential } = require('@azure/ai-text-analytics');
const createLogger = require('./logger');

const log = createLogger('languageClient');

const MAX_DOC_CHARS  = 5000;   // API limit is 5,120 — leave a small buffer
const BATCH_SIZE     = 10;     // API limit per request

let _client = null;

function getClient() {
  if (_client) return _client;

  const endpoint = process.env.LANGUAGE_ENDPOINT;
  const apiKey   = process.env.LANGUAGE_API_KEY;

  if (!endpoint) throw new Error('LANGUAGE_ENDPOINT is not set');
  if (!apiKey)   throw new Error('LANGUAGE_API_KEY is not set');

  _client = new TextAnalyticsClient(endpoint, new AzureKeyCredential(apiKey));
  return _client;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Truncate text to MAX_DOC_CHARS, preferring a word boundary.
 */
function truncateText(text) {
  if (!text || text.length <= MAX_DOC_CHARS) return text ?? '';
  const truncated = text.substring(0, MAX_DOC_CHARS);
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > MAX_DOC_CHARS * 0.8 ? truncated.substring(0, lastSpace) : truncated;
}

/**
 * Chunk an array into groups of `size`.
 */
function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// ─── Core enrichment ──────────────────────────────────────────────────────────

/**
 * Enrich a batch of articles with sentiment, entities, and key phrases.
 *
 * @param {Array<{ id: string, text: string, language?: string }>} articles
 *   id   - the url_hash (used to correlate results back)
 *   text - the article text to analyze (will be truncated if needed)
 *
 * @returns {Array<NlpResult>} — one result per input article, in same order
 *
 * NlpResult shape:
 * {
 *   id:           string,
 *   nlpStatus:    'ok' | 'failed',
 *   nlpError?:    string,
 *   sentiment: {
 *     label:       'positive' | 'negative' | 'neutral' | 'mixed',
 *     scores:      { positive: number, negative: number, neutral: number }
 *   },
 *   entities: [{ text, category, subcategory, confidenceScore }],
 *   keyPhrases:   string[]
 * }
 */
async function enrichArticles(articles) {
  const client  = getClient();
  const results = new Map(); // id → result

  // Prepare documents — truncate text, default language to English
  const docs = articles.map(a => ({
    id:       a.id,
    text:     truncateText(a.text),
    language: a.language ?? 'en',
  }));

  // Process in batches of 10
  const batches = chunk(docs, BATCH_SIZE);

  for (const batch of batches) {
    await Promise.all([
      _runSentiment(client, batch, results),
      _runEntities(client, batch, results),
      _runKeyPhrases(client, batch, results),
    ]);
  }

  // Return in original order, filling in any missing results with error state
  return articles.map(a => results.get(a.id) ?? {
    id:        a.id,
    nlpStatus: 'failed',
    nlpError:  'No result returned from Language API',
    sentiment: null,
    entities:  [],
    keyPhrases: [],
  });
}

async function _runSentiment(client, batch, results) {
  try {
    const response = await client.analyzeSentiment(batch);
    for (const doc of response) {
      _ensureResult(results, doc.id);
      if (doc.error) {
        results.get(doc.id).nlpStatus = 'failed';
        results.get(doc.id).nlpError  = doc.error.message;
      } else {
        results.get(doc.id).sentiment = {
          label:  doc.sentiment,
          scores: doc.confidenceScores,
        };
      }
    }
  } catch (err) {
    log.error('analyzeSentiment batch failed', { error: err.message });
    batch.forEach(d => {
      _ensureResult(results, d.id);
      results.get(d.id).nlpStatus = 'failed';
      results.get(d.id).nlpError  = err.message;
    });
  }
}

async function _runEntities(client, batch, results) {
  try {
    const response = await client.recognizeEntities(batch);
    for (const doc of response) {
      _ensureResult(results, doc.id);
      if (!doc.error) {
        results.get(doc.id).entities = doc.entities.map(e => ({
          text:            e.text,
          category:        e.category,
          subcategory:     e.subCategory ?? null,
          confidenceScore: e.confidenceScore,
        }));
      }
    }
  } catch (err) {
    log.error('recognizeEntities batch failed', { error: err.message });
    // Non-fatal — sentiment and key phrases may still be ok
    batch.forEach(d => {
      _ensureResult(results, d.id);
      if (!results.get(d.id).entities) results.get(d.id).entities = [];
    });
  }
}

async function _runKeyPhrases(client, batch, results) {
  try {
    const response = await client.extractKeyPhrases(batch);
    for (const doc of response) {
      _ensureResult(results, doc.id);
      if (!doc.error) {
        results.get(doc.id).keyPhrases = doc.keyPhrases;
      }
    }
  } catch (err) {
    log.error('extractKeyPhrases batch failed', { error: err.message });
    batch.forEach(d => {
      _ensureResult(results, d.id);
      if (!results.get(d.id).keyPhrases) results.get(d.id).keyPhrases = [];
    });
  }
}

function _ensureResult(results, id) {
  if (!results.has(id)) {
    results.set(id, {
      id,
      nlpStatus:  'ok',
      sentiment:  null,
      entities:   [],
      keyPhrases: [],
    });
  }
}

/**
 * Check if PII entities are present (for Purview classification hook).
 * Returns true if any entity is of category Person, PhoneNumber, or Email.
 */
function hasPii(entities = []) {
  const PII_CATEGORIES = new Set(['Person', 'PhoneNumber', 'Email']);
  return entities.some(e => PII_CATEGORIES.has(e.category));
}

module.exports = {
  enrichArticles,
  hasPii,
  BATCH_SIZE,
  MAX_DOC_CHARS,
};