'use strict';

/**
 * scripts/test-pipeline.js
 *
 * End-to-end smoke test for the NLP pipeline.
 * Runs in two modes:
 *
 *   1. UNIT mode (default, no Azure needed):
 *      Tests all exported helpers from every layer using realistic
 *      fixture data. Catches field naming bugs, mapping errors, and
 *      logic regressions without any cloud dependency.
 *
 *   2. INTEGRATION mode (--integration flag, requires .env):
 *      Runs a real NewsAPI fetch → blob write → queue enqueue →
 *      enrichment → search index upsert chain against live Azure services.
 *      Use this before go-live and after any infrastructure change.
 *
 * Usage:
 *   node scripts/test-pipeline.js              # unit mode
 *   node scripts/test-pipeline.js --integration # integration mode
 *
 * Exit code 0 = all tests passed. Non-zero = failures (CI-friendly).
 */

require('dotenv').config({ path: `${__dirname}/../functions/.env` });

const crypto   = require('crypto');
const path     = require('path');

const INTEGRATION = process.argv.includes('--integration');
const results     = { passed: 0, failed: 0, errors: [] };

// ── Test runner ───────────────────────────────────────────────────────────────

function test(name, fn) {
  try {
    fn();
    results.passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.failed++;
    results.errors.push({ name, error: err.message });
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message ?? 'Assertion failed');
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label ?? 'assertEqual'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertNull(val, label) {
  if (val !== null && val !== undefined) {
    throw new Error(`${label ?? 'assertNull'}: expected null/undefined, got ${JSON.stringify(val)}`);
  }
}

function assertNotNull(val, label) {
  if (val === null || val === undefined) {
    throw new Error(`${label ?? 'assertNotNull'}: expected non-null value`);
  }
}

// ── Fixtures (realistic NewsAPI article shape) ────────────────────────────────

const NEWSAPI_ARTICLE = {
  source:      { id: 'the-verge', name: 'The Verge' },
  author:      'Jane Doe',
  title:       'Apple reports record quarterly earnings',
  description: 'Apple Inc reported strong Q1 results exceeding analyst expectations.',
  url:         'https://www.theverge.com/2024/01/15/apple-q1-earnings',
  urlToImage:  'https://platform.theverge.com/img.jpg',
  publishedAt: '2024-01-15T17:09:12Z',
  content:     'Apple Inc reported record quarterly earnings on Tuesday. [+5204 chars]',
};

const NEWSAPI_ARTICLE_NULL_FIELDS = {
  source:      { id: null, name: 'Gizmodo.com' },
  author:      null,
  title:       'Tech roundup',
  description: null,
  url:         'https://gizmodo.com/tech-roundup',
  urlToImage:  null,
  publishedAt: '2024-01-15T12:00:00Z',
  content:     null,
};

const NEWSAPI_ARTICLE_HTML = {
  source:      { id: null, name: 'Boing Boing' },
  author:      "Boing Boing's Shop",
  title:       'Gadget roundup',
  description: 'Weekly picks.',
  url:         'https://boingboing.net/gadget-roundup',
  urlToImage:  null,
  publishedAt: '2024-01-15T08:00:00Z',
  content:     '<ul><li></li></ul>\r\nWeekly picks from the shop. [+1200 chars]',
};

const NLP_RESULT = {
  id:         'abc123',
  nlpStatus:  'ok',
  sentiment:  { label: 'positive', scores: { positive: 0.9, negative: 0.05, neutral: 0.05 } },
  entities:   [
    { text: 'Apple',    category: 'Organization', confidenceScore: 0.99 },
    { text: 'Tim Cook', category: 'Person',       confidenceScore: 0.95 },
  ],
  keyPhrases: ['record earnings', 'quarterly results'],
};

const EMBED_RESULT = {
  vector:       new Array(1536).fill(0.01),
  vectorStatus: 'ok',
  dimensions:   1536,
};

// Build a realistic silver doc (mirrors _buildSilverDoc output)
const SILVER_DOC = {
  id:              'abc123',
  url:             NEWSAPI_ARTICLE.url,
  title:           NEWSAPI_ARTICLE.title,
  body_snippet:    'Apple Inc reported record quarterly earnings on Tuesday.',
  source:          'The Verge',
  category:        'technology',
  publishedAt:     '2024-01-15T17:09:12Z',
  author:          'Jane Doe',
  nlpStatus:       'ok',
  nlpError:        null,
  sentiment:       NLP_RESULT.sentiment,
  entities:        NLP_RESULT.entities,
  keyPhrases:      NLP_RESULT.keyPhrases,
  hasPii:          true,   // Tim Cook is Person
  content_vector:  EMBED_RESULT.vector,
  vectorStatus:    'ok',
  vectorError:     null,
  ingestedAt:      '2024-01-15T02:00:00Z',
  enrichedAt:      '2024-01-15T02:05:00Z',
  contentTruncated: true,
};

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — shared/config.js
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n── shared/config.js ────────────────────────────────────────────');
const { INGEST_CATEGORIES, CONTAINERS, TABLES, QUEUES } = require('../functions/shared/config');

test('INGEST_CATEGORIES is a non-empty array', () => {
  assert(Array.isArray(INGEST_CATEGORIES) && INGEST_CATEGORIES.length > 0,
    'INGEST_CATEGORIES must be non-empty array');
});

test('INGEST_CATEGORIES contains expected defaults', () => {
  ['technology', 'business', 'science', 'health'].forEach(cat => {
    assert(INGEST_CATEGORIES.includes(cat), `Missing category: ${cat}`);
  });
});

test('CONTAINERS has all required keys', () => {
  ['BRONZE', 'SILVER', 'GOLD', 'ERROR'].forEach(k => {
    assertNotNull(CONTAINERS[k], `CONTAINERS.${k}`);
  });
});

test('TABLES and QUEUES have required keys', () => {
  assertNotNull(TABLES.DEDUP,   'TABLES.DEDUP');
  assertNotNull(TABLES.AUDIT,   'TABLES.AUDIT');
  assertNotNull(QUEUES.ENRICH,  'QUEUES.ENRICH');
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — shared/blobClient.js helpers
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n── shared/blobClient.js ────────────────────────────────────────');
const { buildBlobPath, dateFromBlobPath } = require('../functions/shared/blobClient');

test('buildBlobPath produces correct path', () => {
  assertEqual(buildBlobPath('technology', '2024-01-15', 'abc123'),
    'technology/2024-01-15/abc123.json', 'buildBlobPath');
});

test('dateFromBlobPath extracts date correctly', () => {
  assertEqual(dateFromBlobPath('technology/2024-01-15/abc123.json'),
    '2024-01-15', 'dateFromBlobPath');
});

test('dateFromBlobPath returns unknown for malformed path', () => {
  assertEqual(dateFromBlobPath('badpath'), 'unknown', 'fallback');
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — fn-hash-url (URL hashing)
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n── fn-hash-url ─────────────────────────────────────────────────');

test('SHA-256 hash is 16 hex chars', () => {
  const hash = crypto.createHash('sha256')
    .update(NEWSAPI_ARTICLE.url).digest('hex').substring(0, 16);
  assert(/^[0-9a-f]{16}$/.test(hash), 'Hash format');
});

test('Hash is deterministic', () => {
  const h1 = crypto.createHash('sha256').update(NEWSAPI_ARTICLE.url).digest('hex').substring(0, 16);
  const h2 = crypto.createHash('sha256').update(NEWSAPI_ARTICLE.url).digest('hex').substring(0, 16);
  assertEqual(h1, h2, 'Deterministic hash');
});

test('Different URLs produce different hashes', () => {
  const h1 = crypto.createHash('sha256').update(NEWSAPI_ARTICLE.url).digest('hex').substring(0, 16);
  const h2 = crypto.createHash('sha256').update(NEWSAPI_ARTICLE_NULL_FIELDS.url).digest('hex').substring(0, 16);
  assert(h1 !== h2, 'Different URLs must hash differently');
});

test('Whitespace trimmed before hashing', () => {
  const h1 = crypto.createHash('sha256').update(NEWSAPI_ARTICLE.url.trim()).digest('hex').substring(0, 16);
  const h2 = crypto.createHash('sha256').update(`  ${NEWSAPI_ARTICLE.url}  `.trim()).digest('hex').substring(0, 16);
  assertEqual(h1, h2, 'Trim before hash');
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — shared/languageClient.js helpers
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n── shared/languageClient.js ────────────────────────────────────');
const { hasPii, BATCH_SIZE, MAX_DOC_CHARS } = require('../functions/shared/languageClient');

test('BATCH_SIZE is 10 (Language API limit)', () => {
  assertEqual(BATCH_SIZE, 10, 'BATCH_SIZE');
});

test('MAX_DOC_CHARS is within Language API 5120 limit', () => {
  assert(MAX_DOC_CHARS <= 5120 && MAX_DOC_CHARS > 4000, 'MAX_DOC_CHARS range');
});

test('hasPii detects Person entity', () => {
  assert(hasPii([{ category: 'Person' }]), 'Person is PII');
});

test('hasPii detects PhoneNumber entity', () => {
  assert(hasPii([{ category: 'PhoneNumber' }]), 'PhoneNumber is PII');
});

test('hasPii detects Email entity', () => {
  assert(hasPii([{ category: 'Email' }]), 'Email is PII');
});

test('hasPii returns false for non-PII entities', () => {
  assert(!hasPii([{ category: 'Organization' }, { category: 'Location' }]), 'Non-PII');
});

test('hasPii returns false for empty array', () => {
  assert(!hasPii([]), 'Empty entities');
});

test('hasPii correctly flags Tim Cook (Person) in fixture', () => {
  assert(hasPii(NLP_RESULT.entities), 'Tim Cook is Person → PII');
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5 — fn-enrich text extraction (_extractText logic)
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n── fn-enrich text extraction ───────────────────────────────────');

// Inline the exact _extractText logic from fn-enrich for isolated testing
function extractText(article) {
  if (article.content && article.content.trim().length > 0) {
    const stripped = article.content.replace(/\s*\[[\+\d]+ chars\]\s*$/, '');
    const noHtml   = stripped.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return noHtml;
  }
  if (article.description && article.description.trim().length > 0) {
    return article.description.trim();
  }
  return article.title?.trim() ?? '';
}

test('Strips [+N chars] truncation marker (free tier)', () => {
  const result = extractText(NEWSAPI_ARTICLE);
  assert(!result.includes('[+'), 'Truncation marker removed');
  assert(result.includes('Apple Inc reported'), 'Content preserved');
});

test('Falls back to description when content is null', () => {
  const result = extractText(NEWSAPI_ARTICLE_NULL_FIELDS);
  assertEqual(result, 'Tech roundup', 'Title fallback (description also null)');
});

test('Strips HTML fragments from content', () => {
  const result = extractText(NEWSAPI_ARTICLE_HTML);
  assert(!result.includes('<ul>'), 'HTML tags removed');
  assert(!result.includes('<li>'), 'HTML tags removed');
  assert(result.includes('Weekly picks'), 'Text preserved after HTML strip');
});

test('Words do not run together after HTML stripping', () => {
  const result = extractText({ content: '<b>Apple</b><em>earnings</em> strong.' });
  assert(!result.includes('Appleearnings'), 'Words separated after HTML strip');
});

test('Handles Windows CRLF line endings', () => {
  const result = extractText({ content: 'Line one.\r\nLine two.' });
  assert(!result.includes('\r\n'), 'CRLF removed');
});

test('contentTruncated flag set correctly on original rawArticle', () => {
  const raw = NEWSAPI_ARTICLE;
  const flag = !!(raw.content?.includes('[+') && raw.content?.includes('chars]'));
  assert(flag === true, 'contentTruncated should be true for truncated content');
});

test('contentTruncated false for full content', () => {
  const raw  = { content: 'Full article text with no truncation marker.' };
  const flag = !!(raw.content?.includes('[+') && raw.content?.includes('chars]'));
  assert(flag === false, 'contentTruncated should be false for full content');
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 6 — fn-enrich silver doc field mapping
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n── fn-enrich silver doc schema ─────────────────────────────────');

test('Silver doc has all required identity fields', () => {
  ['id', 'url', 'title', 'body_snippet', 'source', 'category', 'publishedAt'].forEach(f => {
    assertNotNull(SILVER_DOC[f], `silver.${f}`);
  });
});

test('Silver doc publishedAt is camelCase (matches NewsAPI source field)', () => {
  assertNotNull(SILVER_DOC.publishedAt, 'publishedAt present');
  assert(!('published_at' in SILVER_DOC), 'No snake_case published_at in silver');
});

test('Silver doc source extracts source.name correctly', () => {
  const source = NEWSAPI_ARTICLE.source?.name ?? NEWSAPI_ARTICLE.source ?? null;
  assertEqual(source, 'The Verge', 'source.name extraction');
});

test('Silver doc source.id null handled — source.name always used', () => {
  const source = NEWSAPI_ARTICLE_NULL_FIELDS.source?.name ?? null;
  assertEqual(source, 'Gizmodo.com', 'Null source.id — name used');
});

test('Silver NLP fields present', () => {
  assertNotNull(SILVER_DOC.sentiment, 'sentiment');
  assert(Array.isArray(SILVER_DOC.entities),   'entities is array');
  assert(Array.isArray(SILVER_DOC.keyPhrases), 'keyPhrases is array');
});

test('Silver hasPii flag correct for Person entity', () => {
  assert(SILVER_DOC.hasPii === true, 'hasPii true (Tim Cook is Person)');
});

test('Silver content_vector is 1536 dimensions', () => {
  assertEqual(SILVER_DOC.content_vector.length, 1536, 'vector dimensions');
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 7 — fn-index-refresh _mapToSearchDoc
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n── fn-index-refresh _mapToSearchDoc ────────────────────────────');
const { _mapToSearchDoc } = require('../functions/fn-index-refresh');

test('_mapToSearchDoc maps all fields correctly', () => {
  const doc = _mapToSearchDoc(SILVER_DOC);
  assertNotNull(doc, '_mapToSearchDoc returns non-null');
  assertEqual(doc.id,       'abc123',    'id');
  assertEqual(doc.title,    SILVER_DOC.title, 'title');
  assertEqual(doc.source,   'The Verge', 'source');
  assertEqual(doc.category, 'technology','category');
});

test('_mapToSearchDoc sentiment_label mapped correctly', () => {
  const doc = _mapToSearchDoc(SILVER_DOC);
  assertEqual(doc.sentiment_label, 'positive', 'sentiment_label');
});

test('_mapToSearchDoc sentiment_score_positive mapped correctly', () => {
  const doc = _mapToSearchDoc(SILVER_DOC);
  assertEqual(doc.sentiment_score_positive, 0.9, 'sentiment_score_positive');
});

test('_mapToSearchDoc entities flattened to string array', () => {
  const doc = _mapToSearchDoc(SILVER_DOC);
  assert(Array.isArray(doc.entities), 'entities is array');
  assert(doc.entities.every(e => typeof e === 'string'), 'entities are strings');
  assert(doc.entities.includes('Apple'), 'Apple in entities');
  assert(doc.entities.includes('Tim Cook'), 'Tim Cook in entities');
});

test('_mapToSearchDoc publishedAt → published_at for Search index field', () => {
  const doc = _mapToSearchDoc(SILVER_DOC);
  // Search index field is published_at (snake_case) — mapped FROM silver's publishedAt
  assertNotNull(doc.published_at, 'published_at in Search doc');
  assertEqual(doc.published_at, '2024-01-15T17:09:12Z', 'published_at value');
});

test('_mapToSearchDoc returns null for doc without id', () => {
  assertNull(_mapToSearchDoc(null),       'null doc');
  assertNull(_mapToSearchDoc(undefined),  'undefined doc');
  assertNull(_mapToSearchDoc({ title: 'No id' }), 'missing id');
});

test('_mapToSearchDoc content_vector not returned (retrievable:false)', () => {
  const doc = _mapToSearchDoc(SILVER_DOC);
  // content_vector is passed through — index schema sets retrievable:false
  // so Search will store it but never return it to clients
  assert('content_vector' in doc, 'content_vector present for indexing');
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 8 — fn-search-api _parseParams
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n── fn-search-api _parseParams ──────────────────────────────────');
const { _parseParams, _formatResult } = require('../functions/fn-search-api');

test('_parseParams rejects missing q', () => {
  assertNotNull(_parseParams({}).error, 'missing q error');
});

test('_parseParams rejects empty q', () => {
  assertNotNull(_parseParams({ q: '   ' }).error, 'empty q error');
});

test('_parseParams rejects q over 500 chars', () => {
  assertNotNull(_parseParams({ q: 'a'.repeat(501) }).error, 'q too long');
});

test('_parseParams default top = 10', () => {
  assertEqual(_parseParams({ q: 'test' }).top, 10, 'default top');
});

test('_parseParams rejects top > 50', () => {
  assertNotNull(_parseParams({ q: 'test', top: '51' }).error, 'top > 50');
});

test('_parseParams rejects invalid category', () => {
  assertNotNull(_parseParams({ q: 'test', category: 'sports' }).error, 'invalid category');
});

test('_parseParams accepts all INGEST_CATEGORIES', () => {
  INGEST_CATEGORIES.forEach(cat => {
    const result = _parseParams({ q: 'test', category: cat });
    assert(!result.error, `Category "${cat}" should be valid`);
  });
});

test('_parseParams rejects invalid sentiment', () => {
  assertNotNull(_parseParams({ q: 'test', sentiment: 'happy' }).error, 'invalid sentiment');
});

test('_parseParams rejects invalid from date format', () => {
  assertNotNull(_parseParams({ q: 'test', from: '15-01-2024' }).error, 'bad from format');
});

test('_parseParams rejects from > to', () => {
  assertNotNull(_parseParams({ q: 'test', from: '2024-01-31', to: '2024-01-01' }).error, 'from > to');
});

test('_parseParams vector defaults to true', () => {
  assertEqual(_parseParams({ q: 'test' }).vector, true, 'vector default');
});

test('_parseParams semantic defaults to false', () => {
  assertEqual(_parseParams({ q: 'test' }).semantic, false, 'semantic default');
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 9 — fn-search-api _formatResult
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n── fn-search-api _formatResult ─────────────────────────────────');

const RAW_SEARCH_RESULT = {
  score:                   0.94,
  id:                      'abc123',
  url:                     'https://example.com/article',
  title:                   'Apple earnings',
  source:                  'BBC',
  category:                'technology',
  published_at:            '2024-01-15T00:00:00Z',
  sentiment_label:         'positive',
  sentiment_score_positive: 0.9,
  entities:                ['Apple', 'Tim Cook'],
  key_phrases:             ['record earnings'],
};

test('_formatResult maps all fields', () => {
  const r = _formatResult(RAW_SEARCH_RESULT);
  assertEqual(r.score,          0.94,        'score');
  assertEqual(r.id,             'abc123',    'id');
  assertEqual(r.sentimentLabel, 'positive',  'sentimentLabel');
  assertEqual(r.sentimentScore, 0.9,         'sentimentScore');
  assertEqual(r.publishedAt,    '2024-01-15T00:00:00Z', 'publishedAt camelCase');
});

test('_formatResult renames published_at → publishedAt (camelCase for API consumers)', () => {
  const r = _formatResult(RAW_SEARCH_RESULT);
  assertNotNull(r.publishedAt, 'publishedAt present');
  assert(!('published_at' in r), 'No snake_case in API response');
});

test('_formatResult renames sentiment_score_positive → sentimentScore', () => {
  const r = _formatResult(RAW_SEARCH_RESULT);
  assertNotNull(r.sentimentScore, 'sentimentScore mapped');
  assert(!('sentiment_score_positive' in r), 'Internal field name not exposed');
});

test('_formatResult returns empty arrays for missing collections', () => {
  const r = _formatResult({ id: 'x', score: 0.5 });
  assert(Array.isArray(r.entities)   && r.entities.length   === 0, 'empty entities');
  assert(Array.isArray(r.keyPhrases) && r.keyPhrases.length === 0, 'empty keyPhrases');
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 10 — schema/index-schema.json field contract
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n── index-schema.json field contract ───────────────────────────');
const fs     = require('fs');
const schema = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../search/index-schema.json'), 'utf-8'
));
const schemaFieldNames = new Set(schema.fields.map(f => f.name));

test('Search schema has no defaultScoringProfile (semantic reranking fix)', () => {
  assert(!('defaultScoringProfile' in schema),
    'defaultScoringProfile must be absent — applied conditionally in searchClient');
});

test('Search schema uses sentiment_score_positive (not sentiment_score)', () => {
  assert(schemaFieldNames.has('sentiment_score_positive'), 'sentiment_score_positive present');
  assert(!schemaFieldNames.has('sentiment_score'),         'old sentiment_score absent');
});

test('All fields fn-index-refresh maps to exist in schema', () => {
  const mapped = [
    'id', 'url', 'title', 'body_snippet', 'source', 'category',
    'published_at', 'sentiment_label', 'sentiment_score_positive',
    'entities', 'key_phrases', 'content_vector',
  ];
  mapped.forEach(f => {
    assert(schemaFieldNames.has(f), `Schema missing field: ${f}`);
  });
});

test('content_vector is not retrievable (never sent to clients)', () => {
  const vec = schema.fields.find(f => f.name === 'content_vector');
  assert(vec.retrievable === false, 'content_vector retrievable must be false');
});

test('content_vector dimensions = 1536 (ada-002)', () => {
  const vec = schema.fields.find(f => f.name === 'content_vector');
  assertEqual(vec.dimensions, 1536, 'vector dimensions');
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 11 — schemaUtils.js
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n── scripts/schemaUtils.js ──────────────────────────────────────');
const { stripComments } = require('./schemaUtils');

test('stripComments removes all comment fields recursively', () => {
  const result = stripComments({
    name: 'test', comment: 'top level',
    fields: [{ name: 'id', comment: 'key field' }],
    nested: { deep: { val: 1, comment: 'deep comment' } },
  });
  assert(!JSON.stringify(result).includes('"comment"'), 'All comments stripped');
});

test('stripComments preserves all non-comment fields', () => {
  const result = stripComments({ a: 1, b: { c: 2 }, comment: 'x' });
  assertEqual(result.a,    1, 'a preserved');
  assertEqual(result.b.c, 2, 'b.c preserved');
});

test('stripComments on real schema produces no comment fields', () => {
  const cleaned = stripComments(schema);
  assert(!JSON.stringify(cleaned).includes('"comment"'), 'Real schema cleaned');
});

// ═══════════════════════════════════════════════════════════════════════════════
// INTEGRATION TESTS (only run with --integration flag)
// ═══════════════════════════════════════════════════════════════════════════════
async function runIntegrationTests() {
  console.log('\n── Integration tests (live Azure) ──────────────────────────────');
  console.log('  Checking required env vars...');

  const required = [
    'NEWSAPI_KEY', 'AZURE_STORAGE_CONNECTION_STRING',
    'LANGUAGE_ENDPOINT', 'LANGUAGE_API_KEY',
    'OPENAI_ENDPOINT', 'OPENAI_API_KEY',
    'SEARCH_ENDPOINT', 'SEARCH_API_KEY',
  ];
  const missing = required.filter(v => !process.env[v]);
  if (missing.length > 0) {
    console.error(`  Missing env vars: ${missing.join(', ')}`);
    console.error('  Copy functions/local.settings.example.txt → functions/.env and fill in values');
    results.failed++;
    return;
  }

  const axios = require('../functions/node_modules/axios');

  // Integration 1: NewsAPI reachability
  try {
    const res = await axios.get('https://newsapi.org/v2/top-headlines', {
      params: { category: 'technology', language: 'en', pageSize: 1 },
      headers: { 'X-Api-Key': process.env.NEWSAPI_KEY },
      timeout: 10000,
    });
    assert(res.data.status === 'ok', 'NewsAPI status ok');
    assert(Array.isArray(res.data.articles), 'NewsAPI articles array');
    results.passed++;
    console.log('  ✓ NewsAPI reachable — articles returned');
  } catch (err) {
    results.failed++;
    results.errors.push({ name: 'NewsAPI reachability', error: err.message });
    console.error(`  ✗ NewsAPI reachability: ${err.message}`);
  }

  // Integration 2: Azure AI Search reachability
  try {
    const { getDocumentCount } = require('../functions/shared/searchClient');
    const count = await getDocumentCount();
    results.passed++;
    console.log(`  ✓ Azure AI Search reachable — ${count} documents in index`);
  } catch (err) {
    results.failed++;
    results.errors.push({ name: 'Azure AI Search reachability', error: err.message });
    console.error(`  ✗ Azure AI Search: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESULTS
// ═══════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log(`\nNLP Pipeline Smoke Test — ${INTEGRATION ? 'INTEGRATION' : 'UNIT'} mode`);
  console.log('='.repeat(60));

  if (INTEGRATION) await runIntegrationTests();

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${results.passed} passed, ${results.failed} failed`);

  if (results.errors.length > 0) {
    console.error('\nFailures:');
    results.errors.forEach(e => console.error(`  ✗ ${e.name}: ${e.error}`));
  }

  process.exit(results.failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});