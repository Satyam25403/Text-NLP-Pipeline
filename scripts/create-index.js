'use strict';

/**
 * scripts/create-index.js
 *
 * Creates or updates the Azure AI Search index from search/index-schema.json.
 * Safe to re-run — uses createOrUpdateIndex which is idempotent.
 *
 * IMPORTANT FIELD CHANGE RULES (Azure AI Search constraint):
 *   - You CAN add new fields to an existing index
 *   - You CANNOT change a field's type, analyzer, or key status
 *   - You CANNOT remove fields
 *   - To do breaking changes: create a new index + alias swap (see create-search-alias.js)
 *
 * Usage:
 *   node scripts/create-index.js
 *   node scripts/create-index.js --delete   # drops and recreates (WARNING: loses all data)
 *
 * Requires env vars:
 *   SEARCH_ENDPOINT   https://<name>.search.windows.net
 *   SEARCH_API_KEY    <admin key>
 *   SEARCH_INDEX_NAME articles  (optional, defaults to "articles")
 */

require('dotenv').config({ path: `${__dirname}/../functions/.env` });

const { SearchIndexClient, AzureKeyCredential } = require('@azure/search-documents');
const fs   = require('fs');
const path = require('path');

const SEARCH_ENDPOINT  = process.env.SEARCH_ENDPOINT;
const SEARCH_API_KEY   = process.env.SEARCH_API_KEY;
const INDEX_NAME       = process.env.SEARCH_INDEX_NAME ?? 'articles';
const SCHEMA_PATH      = path.join(__dirname, '../search/index-schema.json');
const FORCE_DELETE     = process.argv.includes('--delete');

// ── Validation ────────────────────────────────────────────────────────────────
if (!SEARCH_ENDPOINT) { console.error('ERROR: SEARCH_ENDPOINT not set'); process.exit(1); }
if (!SEARCH_API_KEY)  { console.error('ERROR: SEARCH_API_KEY not set');  process.exit(1); }

// ── Load schema ───────────────────────────────────────────────────────────────
let schema;
try {
  schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
} catch (err) {
  console.error(`ERROR: Could not read schema from ${SCHEMA_PATH}: ${err.message}`);
  process.exit(1);
}

// Override name from env (schema file has "articles" but env may differ)
schema.name = INDEX_NAME;

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const client = new SearchIndexClient(SEARCH_ENDPOINT, new AzureKeyCredential(SEARCH_API_KEY));

  console.log(`Search endpoint : ${SEARCH_ENDPOINT}`);
  console.log(`Index name      : ${INDEX_NAME}`);
  console.log(`Schema file     : ${SCHEMA_PATH}`);
  console.log(`Force delete    : ${FORCE_DELETE}`);
  console.log('');

  // ── Optional hard delete ──────────────────────────────────────────────────
  if (FORCE_DELETE) {
    try {
      await client.deleteIndex(INDEX_NAME);
      console.log(`Deleted index: ${INDEX_NAME}`);
    } catch (err) {
      if (err.statusCode === 404) {
        console.log('Index did not exist — skipping delete');
      } else {
        throw err;
      }
    }
  }

  // ── Check existing index ──────────────────────────────────────────────────
  let existingIndex = null;
  try {
    existingIndex = await client.getIndex(INDEX_NAME);
    console.log(`Index exists — updating (${existingIndex.fields.length} fields currently)`);
  } catch (err) {
    if (err.statusCode === 404) {
      console.log('Index does not exist — creating fresh');
    } else {
      throw err;
    }
  }

  // ── Warn if adding fields would shrink (not allowed) ─────────────────────
  if (existingIndex) {
    const existingFieldNames = new Set(existingIndex.fields.map(f => f.name));
    const schemaFieldNames   = new Set(schema.fields.map(f => f.name));
    const removed = [...existingFieldNames].filter(n => !schemaFieldNames.has(n));
    if (removed.length > 0) {
      console.warn(`WARNING: Schema removes existing fields: [${removed.join(', ')}]`);
      console.warn('Azure AI Search does not allow removing fields from a live index.');
      console.warn('Use --delete to recreate, or use create-search-alias.js for zero-downtime swap.');
      console.warn('Proceeding anyway — Search will ignore the removal attempt.');
    }
  }

  // ── Create or update ──────────────────────────────────────────────────────
  // Strip comment fields — Search API will reject unknown properties
  const cleanSchema = _stripComments(schema);

  const result = await client.createOrUpdateIndex(cleanSchema);
  console.log('');
  console.log('Index created/updated successfully');
  console.log(`  Name   : ${result.name}`);
  console.log(`  Fields : ${result.fields.length}`);
  console.log(`  Vector profiles : ${result.vectorSearch?.profiles?.length ?? 0}`);
  console.log(`  Semantic configs: ${result.semantic?.configurations?.length ?? 0}`);
  console.log(`  Scoring profiles: ${result.scoringProfiles?.length ?? 0}`);

  // ── Stats ─────────────────────────────────────────────────────────────────
  try {
    const stats = await client.getIndexStatistics(INDEX_NAME);
    console.log(`  Document count  : ${stats.documentCount}`);
    console.log(`  Storage bytes   : ${stats.storageSize}`);
  } catch {
    // Stats may not be immediately available after creation
    console.log('  (stats not yet available)');
  }
}

const { stripComments: _stripComments } = require('./schemaUtils');

main().catch(err => {
  console.error('FATAL:', err.message ?? err);
  process.exit(1);
});