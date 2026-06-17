'use strict';

/**
 * fn-audit-logger
 * Trigger: Event Grid (same BlobCreated subscription as fn-nlp-trigger)
 *
 * Responsibilities:
 *   - Write an immutable audit record for every blob that lands in bronze
 *   - Captures: blob path, content length, event time, category, url hash
 *
 * This function never throws — audit logging is best-effort.
 * A failed audit write must NOT cause Event Grid to retry and re-ingest.
 *
 * Why separate from fn-nlp-trigger:
 *   - Single-responsibility: trigger does routing, logger does auditing
 *   - Event Grid fans out to both independently — one failure doesn't affect the other
 *   - Audit table provides a complete record even if enrichment is later skipped (dedup)
 */

const { logAuditEvent } = require('../shared/tableClient');
const createLogger      = require('../shared/logger');

const log = createLogger('fn-audit-logger');

const BRONZE_CONTAINER = process.env.BLOB_CONTAINER_BRONZE ?? 'articles-bronze';

module.exports = async function (context, eventGridEvent) {
  const event = eventGridEvent;

  // Only audit BlobCreated events on our bronze container
  if (event.eventType !== 'Microsoft.Storage.BlobCreated') return;

  const containerMatch = event.subject.match(/containers\/([^/]+)\//);
  if (!containerMatch || containerMatch[1] !== BRONZE_CONTAINER) return;

  const subjectParts = event.subject.split('/blobs/');
  const blobPath     = subjectParts[1] ?? 'unknown';
  const pathParts    = blobPath.split('/');
  const urlHash      = pathParts[2]?.replace('.json', '') ?? 'unknown';
  const category     = pathParts[0] ?? 'unknown';

  try {
    await logAuditEvent(urlHash, 'blob_created', {
      blobPath,
      category,
      contentLength: event.data?.contentLength ?? null,
      blobUrl:       event.data?.url ?? null,
      eventTime:     event.eventTime ?? new Date().toISOString(),
    });
    log.info('Audit record written', { urlHash, category });
  } catch (err) {
    // Log but never rethrow — audit failures must not cause retries
    log.error('Audit write failed (non-fatal)', { urlHash, error: err.message });
  }
};