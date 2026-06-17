'use strict';

/**
 * openaiClient.js
 * Calls Azure OpenAI to generate a vector embedding per article.
 *
 * Model: text-embedding-ada-002 (1536 dimensions, cosine similarity)
 *
 * We call one article at a time (not batched) because:
 *   - This runs in parallel alongside Language API calls in fn-enrich
 *   - Our volume (max 100 articles/day) doesn't justify batching complexity
 *   - ada-002 is cheap: ~$0.0001 per 1K tokens
 *
 * Edge cases:
 *   - Empty or null text: skip embedding, return { vector: null, vectorStatus: 'empty_content' }
 *   - API timeout / 429: retry up to 3 times with exponential backoff
 *   - Text too long: truncate to 8191 tokens (ada-002 limit) — we truncate chars as a proxy
 */

const axios       = require('axios');
const createLogger = require('./logger');

const log = createLogger('openaiClient');

// ada-002 token limit ≈ 8191 tokens. At ~4 chars/token, 32,000 chars is a safe proxy.
const MAX_INPUT_CHARS = 32000;

// Retry config
const MAX_RETRIES   = 3;
const BASE_DELAY_MS = 500;

/**
 * Generate a vector embedding for a single piece of text.
 *
 * @param {string} text - article text (title + body_snippet recommended)
 * @returns {{ vector: number[]|null, vectorStatus: string, dimensions: number|null }}
 */
async function embedText(text) {
  if (!text || text.trim().length === 0) {
    log.warn('Skipping embedding — empty text');
    return { vector: null, vectorStatus: 'empty_content', dimensions: null };
  }

  const endpoint   = process.env.OPENAI_ENDPOINT;
  const apiKey     = process.env.OPENAI_API_KEY;
  const deployment = process.env.OPENAI_EMBEDDING_DEPLOYMENT ?? 'text-embedding-ada-002';

  if (!endpoint) throw new Error('OPENAI_ENDPOINT is not set');
  if (!apiKey)   throw new Error('OPENAI_API_KEY is not set');

  // Truncate if needed
  const input = text.length > MAX_INPUT_CHARS ? text.substring(0, MAX_INPUT_CHARS) : text;

  const url = `${endpoint.replace(/\/$/, '')}/openai/deployments/${deployment}/embeddings?api-version=2023-05-15`;

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.post(
        url,
        { input, model: deployment },
        {
          headers: {
            'api-key':      apiKey,
            'Content-Type': 'application/json',
          },
          timeout: 30000, // 30s
        },
      );

      const vector = response.data?.data?.[0]?.embedding;
      if (!vector || !Array.isArray(vector)) {
        throw new Error('Unexpected response shape from OpenAI embeddings API');
      }

      log.debug('Embedding generated', { dimensions: vector.length, attempt });
      return { vector, vectorStatus: 'ok', dimensions: vector.length };

    } catch (err) {
      lastError = err;
      const status = err.response?.status;

      // Don't retry on auth errors
      if (status === 401 || status === 403) {
        log.error('OpenAI auth error — not retrying', { status, error: err.message });
        break;
      }

      // Rate limit (429) or server error (5xx) → retry with backoff
      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        log.warn('Embedding attempt failed, retrying', { attempt, delay, status, error: err.message });
        await sleep(delay);
      }
    }
  }

  log.error('All embedding attempts failed', { error: lastError?.message });
  return {
    vector:       null,
    vectorStatus: 'failed',
    dimensions:   null,
    vectorError:  lastError?.message,
  };
}

/**
 * Build the text input for embedding from an article.
 * Combines title + body for richer semantic representation.
 * Format: "{title}\n\n{body_snippet}"
 */
function buildEmbeddingInput(title, bodySnippet) {
  const parts = [title, bodySnippet].filter(Boolean);
  return parts.join('\n\n');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  embedText,
  buildEmbeddingInput,
  MAX_INPUT_CHARS,
};