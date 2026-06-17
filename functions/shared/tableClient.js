'use strict';

/**
 * tableClient.js
 * Azure Table Storage wrapper for two tables:
 *
 *   articleDedup  → idempotency guard before writing bronze blobs
 *     PartitionKey = first 2 chars of urlHash (for spread)
 *     RowKey       = full urlHash
 *     Fields       : url, category, ingestedAt
 *
 *   articleAudit  → immutable event log per article
 *     PartitionKey = dateStr (YYYY-MM-DD)
 *     RowKey       = `${urlHash}_${event}` e.g. "abc123_ingested"
 *     Fields       : event, category, url, details (JSON string), ts
 */

const { TableClient, TableServiceClient, odata } = require('@azure/data-tables');
const createLogger = require('./logger');

const log = createLogger('tableClient');

const DEDUP_TABLE  = process.env.TABLE_DEDUP  ?? 'articleDedup';
const AUDIT_TABLE  = process.env.TABLE_AUDIT  ?? 'articleAudit';

// Lazy clients
const _clients = {};

function getClient(tableName) {
  if (_clients[tableName]) return _clients[tableName];

  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connStr) throw new Error('AZURE_STORAGE_CONNECTION_STRING is not set');

  _clients[tableName] = TableClient.fromConnectionString(connStr, tableName);
  return _clients[tableName];
}

/**
 * Ensure tables exist. Call once at function cold start.
 */
async function ensureTables() {
  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connStr) throw new Error('AZURE_STORAGE_CONNECTION_STRING is not set');

  const svc = TableServiceClient.fromConnectionString(connStr);
  for (const name of [DEDUP_TABLE, AUDIT_TABLE]) {
    try {
      await svc.createTable(name);
      log.info('Table created', { name });
    } catch (err) {
      // TableAlreadyExists is expected — not an error
      if (!err.message?.includes('TableAlreadyExists') && err.statusCode !== 409) {
        throw err;
      }
    }
  }
}

// ─── Dedup ────────────────────────────────────────────────────────────────────

/**
 * Check if an article (by urlHash) has already been ingested.
 * Returns true if it exists (→ skip), false if new (→ proceed).
 */
async function isDuplicate(urlHash) {
  const client = getClient(DEDUP_TABLE);
  const pk = urlHash.substring(0, 2);

  try {
    await client.getEntity(pk, urlHash);
    return true; // entity exists → duplicate
  } catch (err) {
    if (err.statusCode === 404) return false;
    throw err;
  }
}

/**
 * Mark an article as ingested in the dedup table.
 */
async function markIngested(urlHash, { url, category, ingestedAt }) {
  const client = getClient(DEDUP_TABLE);
  const pk = urlHash.substring(0, 2);

  await client.upsertEntity(
    {
      partitionKey: pk,
      rowKey:       urlHash,
      url,
      category,
      ingestedAt,
    },
    'Replace',
  );

  log.debug('Marked ingested', { urlHash });
}

// ─── Audit ────────────────────────────────────────────────────────────────────

/**
 * Append an audit event for an article.
 *
 * @param {string} urlHash
 * @param {string} event   e.g. 'ingested' | 'enrich_started' | 'enrich_complete' | 'enrich_failed' | 'indexed'
 * @param {object} details - arbitrary metadata to log
 */
async function logAuditEvent(urlHash, event, details = {}) {
  const client  = getClient(AUDIT_TABLE);
  const dateStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const rowKey  = `${urlHash}_${event}_${Date.now()}`;    // unique per event

  await client.upsertEntity(
    {
      partitionKey: dateStr,
      rowKey,
      urlHash,
      event,
      details:      JSON.stringify(details),
      ts:           new Date().toISOString(),
    },
    'Replace',
  );

  log.debug('Audit event written', { urlHash, event });
}

/**
 * Query audit events for a specific date.
 * Returns an array of entities.
 */
async function getAuditsByDate(dateStr) {
  const client   = getClient(AUDIT_TABLE);
  const filter   = odata`PartitionKey eq ${dateStr}`;
  const entities = [];

  for await (const entity of client.listEntities({ queryOptions: { filter } })) {
    entities.push(entity);
  }

  return entities;
}

module.exports = {
  ensureTables,
  isDuplicate,
  markIngested,
  logAuditEvent,
  getAuditsByDate,
};