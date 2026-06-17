'use strict';

/**
 * blobClient.js
 * Wraps @azure/storage-blob for the NLP pipeline.
 *
 * Layers:
 *   bronze  → raw JSON from NewsAPI          (container: BLOB_CONTAINER_BRONZE)
 *   silver  → enriched articles              (container: BLOB_CONTAINER_SILVER)
 *   error   → articles that failed enrichment (container: articles-error)
 *
 * Blob naming convention:
 *   {category}/{YYYY-MM-DD}/{urlHash}.json
 */

const { BlobServiceClient } = require('@azure/storage-blob');
const createLogger = require('./logger');

const log = createLogger('blobClient');

// Lazy singleton — created once on first use
let _client = null;

function getClient() {
  if (_client) return _client;

  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connStr) throw new Error('AZURE_STORAGE_CONNECTION_STRING is not set');

  _client = BlobServiceClient.fromConnectionString(connStr);
  return _client;
}

/**
 * Returns a ContainerClient, creating the container if it doesn't exist.
 * Safe to call repeatedly — uses createIfNotExists which is idempotent.
 */
async function getContainer(containerName) {
  const client = getClient();
  const container = client.getContainerClient(containerName);
  await container.createIfNotExists();
  return container;
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Write a JSON object as a blob.
 * @param {string} containerName
 * @param {string} blobPath  e.g. "technology/2024-01-15/abc123.json"
 * @param {object} data
 */
async function writeJson(containerName, blobPath, data) {
  const container = await getContainer(containerName);
  const blockBlob  = container.getBlockBlobClient(blobPath);
  const content    = JSON.stringify(data, null, 2);

  await blockBlob.upload(content, Buffer.byteLength(content), {
    blobHTTPHeaders: { blobContentType: 'application/json' },
  });

  log.debug('Blob written', { containerName, blobPath, bytes: Buffer.byteLength(content) });
  return blobPath;
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Read a JSON blob and parse it.
 * Returns null if the blob does not exist (instead of throwing).
 */
async function readJson(containerName, blobPath) {
  const container = await getContainer(containerName);
  const blockBlob  = container.getBlockBlobClient(blobPath);

  try {
    const downloadResponse = await blockBlob.download(0);
    const chunks = [];
    for await (const chunk of downloadResponse.readableStreamBody) {
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.statusCode === 404) {
      log.warn('Blob not found', { containerName, blobPath });
      return null;
    }
    throw err;
  }
}

// ─── List ─────────────────────────────────────────────────────────────────────

/**
 * List blob paths under a prefix (e.g. "technology/2024-01-15/").
 * Returns an array of blob name strings.
 */
async function listBlobs(containerName, prefix = '') {
  const container = await getContainer(containerName);
  const names = [];

  for await (const blob of container.listBlobsFlat({ prefix })) {
    names.push(blob.name);
  }

  return names;
}

// ─── Exists ───────────────────────────────────────────────────────────────────

/**
 * Check if a blob exists without downloading it.
 */
async function exists(containerName, blobPath) {
  const container = await getContainer(containerName);
  const blockBlob  = container.getBlockBlobClient(blobPath);
  return blockBlob.exists();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a standard blob path from parts.
 * e.g. buildBlobPath('technology', '2024-01-15', 'abc123') → "technology/2024-01-15/abc123.json"
 */
function buildBlobPath(category, dateStr, urlHash) {
  return `${category}/${dateStr}/${urlHash}.json`;
}

/**
 * Extract the date string from a blob path.
 * e.g. "technology/2024-01-15/abc123.json" → "2024-01-15"
 */
function dateFromBlobPath(blobPath) {
  const parts = blobPath.split('/');
  return parts[1] ?? 'unknown';
}

module.exports = {
  writeJson,
  readJson,
  listBlobs,
  exists,
  buildBlobPath,
  dateFromBlobPath,
};