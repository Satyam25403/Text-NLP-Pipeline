'use strict';

/**
 * scripts/register-purview-lineage.js
 *
 * Registers the custom data lineage graph in Microsoft Purview via the Atlas REST API.
 *
 * WHY THIS IS NEEDED:
 *   Purview auto-detects lineage for ADF pipelines and Databricks notebooks.
 *   But fn-enrich (Azure Function: bronze → silver) is custom code — Purview
 *   has no visibility into it. Without this script, the lineage graph has a gap:
 *     raw JSON ──?──► silver ──(ADF/Databricks auto)──► gold ──► Search
 *   After running this script:
 *     raw JSON ──(fn-enrich)──► silver ──(ADF/Databricks)──► gold ──► Search
 *
 * WHAT IT REGISTERS:
 *   1. Process entity: "fn-enrich — NLP Enrichment"
 *      Represents the Azure Function that enriches articles.
 *   2. Process entity: "fn-index-refresh — Search Index Refresh"
 *      Represents the ADF-triggered function that pushes silver → Search.
 *   3. Lineage edges:
 *      articles-bronze ──[fn-enrich]──► articles-silver
 *      articles-silver ──[fn-index-refresh]──► articles (Search index)
 *
 * HOW TO RUN:
 *   node scripts/register-purview-lineage.js
 *
 * REQUIRED ENV VARS:
 *   PURVIEW_ENDPOINT   https://<account>.purview.azure.com
 *   PURVIEW_CLIENT_ID  Azure AD app registration client ID
 *   PURVIEW_CLIENT_SECRET
 *   PURVIEW_TENANT_ID
 *   STORAGE_ACCOUNT_NAME
 *   SEARCH_SERVICE_NAME
 *
 * IDEMPOTENT: safe to re-run — Atlas upserts entities by qualifiedName.
 */

require('dotenv').config({ path: `${__dirname}/../functions/.env` });
const axios = require('../functions/node_modules/axios');

const PURVIEW_ENDPOINT    = process.env.PURVIEW_ENDPOINT;
const CLIENT_ID           = process.env.PURVIEW_CLIENT_ID;
const CLIENT_SECRET       = process.env.PURVIEW_CLIENT_SECRET;
const TENANT_ID           = process.env.PURVIEW_TENANT_ID;
const STORAGE_ACCOUNT     = process.env.STORAGE_ACCOUNT_NAME;
const SEARCH_SERVICE      = process.env.SEARCH_SERVICE_NAME;
const BRONZE_CONTAINER    = process.env.BLOB_CONTAINER_BRONZE ?? 'articles-bronze';
const SILVER_CONTAINER    = process.env.BLOB_CONTAINER_SILVER ?? 'articles-silver';
const SEARCH_INDEX        = process.env.SEARCH_INDEX_NAME    ?? 'articles';

// ── Validation ────────────────────────────────────────────────────────────────
const REQUIRED = {
  PURVIEW_ENDPOINT:     PURVIEW_ENDPOINT,
  PURVIEW_CLIENT_ID:    CLIENT_ID,
  PURVIEW_CLIENT_SECRET: CLIENT_SECRET,
  PURVIEW_TENANT_ID:    TENANT_ID,
  STORAGE_ACCOUNT_NAME: STORAGE_ACCOUNT,
  SEARCH_SERVICE_NAME:  SEARCH_SERVICE,
};

const missing = Object.entries(REQUIRED)
  .filter(([, v]) => !v)
  .map(([k]) => k);

if (missing.length > 0) {
  console.error('Missing required env vars:', missing.join(', '));
  process.exit(1);
}

// ── Auth: get Azure AD token for Purview ──────────────────────────────────────
async function getToken() {
  const url  = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope:         'https://purview.azure.net/.default',
  });

  const res = await axios.post(url, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  return res.data.access_token;
}

// ── Atlas API helpers ─────────────────────────────────────────────────────────
function atlasClient(token) {
  const base = axios.create({
    baseURL: `${PURVIEW_ENDPOINT}/catalog/api/atlas/v2`,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  return base;
}

/**
 * Upsert one or more Atlas entities.
 * Atlas identifies entities by (typeName + qualifiedName) — re-running is safe.
 */
async function upsertEntities(client, entities) {
  const res = await client.post('/entity/bulk', { entities });
  return res.data;
}

// ── Entity builders ───────────────────────────────────────────────────────────

/**
 * Build an Azure Blob container entity (bronze or silver).
 * qualifiedName format matches what Purview auto-generates when it scans Storage.
 */
function blobContainerEntity(containerName) {
  return {
    typeName: 'azure_datalake_gen2_filesystem',
    attributes: {
      qualifiedName: `https://${STORAGE_ACCOUNT}.dfs.core.windows.net/${containerName}`,
      name:          containerName,
      description:   containerName === BRONZE_CONTAINER
        ? 'Raw NewsAPI article JSON — ingested by Logic App every 6 hours'
        : 'Enriched articles with NLP sentiment, entities, key phrases, and embeddings',
    },
  };
}

/**
 * Build a generic external source entity for NewsAPI.
 * No Azure resource ID — represented as a generic DataSet.
 */
function newsApiEntity() {
  return {
    typeName: 'DataSet',
    attributes: {
      qualifiedName: 'https://newsapi.org/v2/top-headlines',
      name:          'NewsAPI Top Headlines',
      description:   'External news data source — polled every 6 hours by Logic App for categories: technology, business, science, health',
    },
  };
}

/**
 * Build an Azure AI Search index entity.
 */
function searchIndexEntity() {
  return {
    typeName: 'azure_search_index',
    attributes: {
      qualifiedName: `https://${SEARCH_SERVICE}.search.windows.net/indexes/${SEARCH_INDEX}`,
      name:          SEARCH_INDEX,
      description:   'Hybrid search index — BM25 keyword + HNSW vector (ada-002), semantic reranker optional',
    },
  };
}

/**
 * Build a Process entity representing a custom Azure Function.
 * Process entities represent data transformation steps in the lineage graph.
 */
function processEntity({ name, qualifiedName, description, inputs, outputs }) {
  return {
    typeName: 'Process',
    attributes: {
      qualifiedName,
      name,
      description,
      inputs,
      outputs,
      // operationType removed — not a standard Atlas Process attribute; causes strict-mode 400
    },
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Purview Lineage Registration');
  console.log('='.repeat(50));
  console.log(`Purview endpoint : ${PURVIEW_ENDPOINT}`);
  console.log(`Storage account  : ${STORAGE_ACCOUNT}`);
  console.log(`Search service   : ${SEARCH_SERVICE}`);
  console.log('');

  // Step 1: Authenticate
  console.log('Step 1: Authenticating with Azure AD...');
  let token;
  try {
    token = await getToken();
    console.log('  ✓ Token acquired');
  } catch (err) {
    console.error('  ✗ Auth failed:', err.response?.data ?? err.message);
    process.exit(1);
  }

  const client = atlasClient(token);

  // Step 2: Upsert data asset entities
  console.log('\nStep 2: Registering data asset entities...');
  const bronze      = blobContainerEntity(BRONZE_CONTAINER);
  const silver      = blobContainerEntity(SILVER_CONTAINER);
  const searchIndex = searchIndexEntity();

  try {
    await upsertEntities(client, [bronze, silver, searchIndex]);
    console.log('  ✓ articles-bronze entity registered');
    console.log('  ✓ articles-silver entity registered');
    console.log('  ✓ articles (Search index) entity registered');
  } catch (err) {
    console.error('  ✗ Entity upsert failed:', err.response?.data ?? err.message);
    process.exit(1);
  }

  // Step 3: Register Logic App lineage (NewsAPI → bronze)
  console.log('\nStep 3: Registering Logic App lineage (NewsAPI → bronze)...');
  const newsApi = newsApiEntity();

  try {
    await upsertEntities(client, [newsApi]);
    console.log('  ✓ NewsAPI source entity registered');
  } catch (err) {
    console.error('  ✗ NewsAPI entity failed:', err.response?.data ?? err.message);
    process.exit(1);
  }

  const logicAppProcess = processEntity({
    name:          'Logic App — NewsAPI Ingestion',
    qualifiedName: 'nlp-pipeline://logic-app-ingestor',
    description:   [
      'Azure Logic App that polls NewsAPI /v2/top-headlines every 6 hours.',
      'Iterates categories: technology, business, science, health.',
      'Computes SHA-256(url)[0:16] via fn-hash-url for dedup key.',
      'Writes individual article JSON blobs to articles-bronze/{category}/{date}/{urlHash}.json.',
      'Uses Managed Identity authentication to Azure Blob Storage.',
    ].join(' '),
    inputs:  [{ typeName: newsApi.typeName,  uniqueAttributes: { qualifiedName: newsApi.attributes.qualifiedName } }],
    outputs: [{ typeName: bronze.typeName,   uniqueAttributes: { qualifiedName: bronze.attributes.qualifiedName } }],
  });

  try {
    await upsertEntities(client, [logicAppProcess]);
    console.log('  ✓ Logic App process entity registered');
    console.log('    NewsAPI ──[Logic App]──► articles-bronze');
  } catch (err) {
    console.error('  ✗ Logic App lineage failed:', err.response?.data ?? err.message);
    process.exit(1);
  }

  // Step 4: Register fn-enrich lineage (bronze → silver)
  console.log('\nStep 4: Registering fn-enrich lineage (bronze → silver)...');
  console.log('\nStep 3: Registering fn-enrich lineage (bronze → silver)...');
  const fnEnrichProcess = processEntity({
    name:          'fn-enrich — NLP Enrichment',
    qualifiedName: 'nlp-pipeline://fn-enrich',
    description:   [
      'Azure Function triggered by Storage Queue (article-enrich-queue).',
      'Reads raw article JSON from articles-bronze.',
      'Calls Azure Cognitive Services Language API (sentiment, NER, key phrases).',
      'Calls Azure OpenAI text-embedding-ada-002 for 1536-dim content vector.',
      'Writes enriched silver document to articles-silver.',
      'Sets hasPii=true if Language API detects Person, PhoneNumber, or Email entities.',
    ].join(' '),
    inputs:  [{ typeName: bronze.typeName, uniqueAttributes: { qualifiedName: bronze.attributes.qualifiedName } }],
    outputs: [{ typeName: silver.typeName, uniqueAttributes: { qualifiedName: silver.attributes.qualifiedName } }],
  });

  try {
    await upsertEntities(client, [fnEnrichProcess]);
    console.log('  ✓ fn-enrich process entity registered');
    console.log(`    articles-bronze ──[fn-enrich]──► articles-silver`);
  } catch (err) {
    console.error('  ✗ fn-enrich lineage failed:', err.response?.data ?? err.message);
    process.exit(1);
  }

  // Step 5: Register fn-index-refresh lineage (silver → Search)
  console.log('\nStep 5: Registering fn-index-refresh lineage (silver → Search index)...');
  const fnIndexProcess = processEntity({
    name:          'fn-index-refresh — Search Index Refresh',
    qualifiedName: 'nlp-pipeline://fn-index-refresh',
    description:   [
      'Azure Function triggered by ADF WebActivity at end of nightly pipeline.',
      'Lists silver layer blobs for a given date and category.',
      'Maps silver documents to Azure AI Search index schema.',
      'Upserts documents to the articles Search index using mergeOrUpload semantics.',
      'Returns 207 on partial failure so ADF can alert.',
    ].join(' '),
    inputs:  [{ typeName: silver.typeName,      uniqueAttributes: { qualifiedName: silver.attributes.qualifiedName } }],
    outputs: [{ typeName: searchIndex.typeName, uniqueAttributes: { qualifiedName: searchIndex.attributes.qualifiedName } }],
  });

  try {
    await upsertEntities(client, [fnIndexProcess]);
    console.log('  ✓ fn-index-refresh process entity registered');
    console.log(`    articles-silver ──[fn-index-refresh]──► articles (Search index)`);
  } catch (err) {
    console.error('  ✗ fn-index-refresh lineage failed:', err.response?.data ?? err.message);
    process.exit(1);
  }

  // Step 6: Summary
  console.log('\n' + '='.repeat(50));
  console.log('Lineage registration complete (5 steps).');
  console.log('');
  console.log('Full lineage graph:');
  console.log('  NewsAPI (https://newsapi.org)');
  console.log('    └─[Logic App]──────────► articles-bronze');
  console.log('         └─[fn-enrich]──────► articles-silver');
  console.log('              ├─[ADF/Databricks]──► articles-gold');
  console.log('              └─[fn-index-refresh]──► articles (Search index)');
  console.log('');
  console.log('View in Purview portal:');
  console.log(`  ${PURVIEW_ENDPOINT}/governance/catalog`);
  console.log('  Data Map → Browse → Azure Data Lake Storage Gen2 → articles-silver → Lineage');
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});