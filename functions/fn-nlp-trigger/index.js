'use strict';

/**
 * fn-nlp-trigger
 * Trigger: Event Grid (BlobCreated on articles-bronze container)
 *
 * Responsibilities:
 *   1. Parse the BlobCreated event to extract blob path + url hash
 *   2. Check dedup table — skip if already queued/processed
 *   3. Enqueue the article reference onto the enrichment queue
 *   4. Write an audit event
 *
 * Event Grid sends one event per blob. This function is idempotent:
 * if it fires twice for the same blob, the dedup check catches it.
 *
 * Event shape (Azure Blob Storage Event Grid schema):
 * {
 *   eventType: "Microsoft.Storage.BlobCreated",
 *   subject:   "/blobServices/default/containers/articles-bronze/blobs/technology/2024-01-15/abc123.json",
 *   data: {
 *     url:            "https://<account>.blob.core.windows.net/articles-bronze/technology/2024-01-15/abc123.json",
 *     contentType:    "application/json",
 *     contentLength:  1234
 *   }
 * }
 */

const { enqueueArticle }             = require('../shared/queueClient');
const { isDuplicate, markIngested,
        logAuditEvent }              = require('../shared/tableClient');
const { CONTAINERS }                 = require('../shared/config');
const createLogger                   = require('../shared/logger');

const log = createLogger('fn-nlp-trigger');

const BRONZE_CONTAINER = CONTAINERS.BRONZE;

module.exports = async function (context, eventGridEvent) {
  const event = eventGridEvent;

  log.info('Event Grid event received', {
    eventType: event.eventType,
    subject:   event.subject,
  });

  // Only handle BlobCreated events
  if (event.eventType !== 'Microsoft.Storage.BlobCreated') {
    log.info('Ignoring non-BlobCreated event', { eventType: event.eventType });
    return;
  }

  // Extract blob path from subject
  // subject = "/blobServices/default/containers/{container}/blobs/{blobPath}"
  const subjectParts   = event.subject.split('/blobs/');
  if (subjectParts.length < 2) {
    log.error('Could not parse blob path from subject', { subject: event.subject });
    return;
  }

  const blobPath = subjectParts[1]; // e.g. "technology/2024-01-15/abc123.json"

  // Validate it's from our bronze container
  const containerMatch = event.subject.match(/containers\/([^/]+)\//);
  if (!containerMatch || containerMatch[1] !== BRONZE_CONTAINER) {
    log.info('Blob not in bronze container — ignoring', { subject: event.subject });
    return;
  }

  // Validate path structure: {category}/{date}/{urlHash}.json
  const pathParts = blobPath.split('/');
  if (pathParts.length !== 3 || !pathParts[2].endsWith('.json')) {
    log.warn('Unexpected blob path structure — skipping', { blobPath });
    return;
  }

  const category    = pathParts[0];
  const dateStr     = pathParts[1];
  const urlHash     = pathParts[2].replace('.json', '');
  const ingestedAt  = event.eventTime ?? new Date().toISOString();

  log.info('Processing blob', { category, dateStr, urlHash });

  // Dedup check — skip if already queued
  let alreadyQueued;
  try {
    alreadyQueued = await isDuplicate(urlHash);
  } catch (err) {
    // If dedup check fails, proceed anyway (enrich-idempotency handles duplicates too)
    log.warn('Dedup check failed — proceeding anyway', { urlHash, error: err.message });
    alreadyQueued = false;
  }

  if (alreadyQueued) {
    log.info('Duplicate blob — skipping enqueue', { urlHash });
    return;
  }

  // Write dedup entry BEFORE enqueueing.
  // If we crash after enqueue without this, Event Grid retries would re-enqueue.
  // fn-enrich's silver-exists check is a second safety net, but this is cleaner.
  try {
    await markIngested(urlHash, { url: '', category, ingestedAt });
  } catch (err) {
    // Dedup write failed — proceed anyway; fn-enrich idempotency will cover it
    log.warn('markIngested pre-enqueue failed (non-fatal)', { urlHash, error: err.message });
  }

  // Enqueue for enrichment
  try {
    await enqueueArticle({ blobPath, urlHash, category, ingestedAt });
    log.info('Article enqueued for enrichment', { urlHash, category });
  } catch (err) {
    log.error('Failed to enqueue article', { urlHash, error: err.message });
    throw err; // re-throw so Event Grid retries
  }

  // Audit log (fire-and-forget — don't block or fail on audit errors)
  logAuditEvent(urlHash, 'enrich_queued', { blobPath, category, dateStr }).catch(err => {
    log.warn('Audit log write failed', { urlHash, error: err.message });
  });
};