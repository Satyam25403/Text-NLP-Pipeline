'use strict';

/**
 * scripts/create-search-alias.js
 *
 * Zero-downtime index swap using Azure AI Search aliases.
 *
 * Use this when you need breaking index changes (type changes, field removal,
 * analyzer changes) that can't be done via createOrUpdateIndex.
 *
 * Strategy:
 *   1. Create a new versioned index: articles-v2
 *   2. Backfill it from silver layer (run create-index.js + test-pipeline.js)
 *   3. Run this script to atomically point the alias "articles" → "articles-v2"
 *   4. APIM/fn-search-api use the alias name — they see new index instantly
 *   5. Delete articles-v1 after confirming
 *
 * Usage:
 *   node scripts/create-search-alias.js --alias articles --target articles-v2
 *
 * Requires:
 *   SEARCH_ENDPOINT  SEARCH_API_KEY
 */

require('dotenv').config({ path: `${__dirname}/../functions/.env` });

const { SearchIndexClient, AzureKeyCredential } = require('@azure/search-documents');

const SEARCH_ENDPOINT = process.env.SEARCH_ENDPOINT;
const SEARCH_API_KEY  = process.env.SEARCH_API_KEY;

const args        = process.argv.slice(2);
const aliasFlag   = args.indexOf('--alias');
const targetFlag  = args.indexOf('--target');
const ALIAS_NAME  = aliasFlag  !== -1 ? args[aliasFlag + 1]  : null;
const TARGET_NAME = targetFlag !== -1 ? args[targetFlag + 1] : null;

if (!SEARCH_ENDPOINT || !SEARCH_API_KEY) {
  console.error('ERROR: SEARCH_ENDPOINT and SEARCH_API_KEY must be set'); process.exit(1);
}
if (!ALIAS_NAME || !TARGET_NAME) {
  console.error('Usage: node create-search-alias.js --alias <alias> --target <index>'); process.exit(1);
}

async function main() {
  const client = new SearchIndexClient(SEARCH_ENDPOINT, new AzureKeyCredential(SEARCH_API_KEY));

  console.log(`Alias  : ${ALIAS_NAME}`);
  console.log(`Target : ${TARGET_NAME}`);

  // Verify target index exists before swapping
  try {
    const idx = await client.getIndex(TARGET_NAME);
    console.log(`Target index confirmed: ${idx.name} (${idx.fields.length} fields)`);
  } catch (err) {
    if (err.statusCode === 404) {
      console.error(`ERROR: Target index "${TARGET_NAME}" does not exist — create and backfill it first`);
      process.exit(1);
    }
    throw err;
  }

  // Create or update alias atomically
  await client.createOrUpdateAlias({
    name:    ALIAS_NAME,
    indexes: [TARGET_NAME],
  });

  console.log(`Alias "${ALIAS_NAME}" now points to "${TARGET_NAME}"`);
  console.log('All clients using the alias name will see the new index immediately.');
  console.log('');
  console.log('When ready to clean up the old index:');
  console.log(`  az search index delete --service-name <name> -g <rg> --index-name <old-index> --yes`);
}

main().catch(err => {
  console.error('FATAL:', err.message ?? err);
  process.exit(1);
});