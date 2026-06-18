'use strict';

/**
 * config.js
 * Single source of truth for shared configuration values used across
 * multiple functions and scripts. Import from here — never hardcode.
 *
 * To add a new category: add it here. fn-index-refresh, Databricks,
 * and Logic App all drive from INGEST_CATEGORIES.
 */

/**
 * NewsAPI categories we ingest.
 * Must match exactly what the Logic App polls and what Databricks reads.
 * Override at runtime with INGEST_CATEGORIES env var (comma-separated).
 */
const INGEST_CATEGORIES = process.env.INGEST_CATEGORIES
  ? process.env.INGEST_CATEGORIES.split(',').map(s => s.trim()).filter(Boolean)
  : ['technology', 'business', 'science', 'health'];

/**
 * Container names — single source of truth.
 */
const CONTAINERS = {
  BRONZE: process.env.BLOB_CONTAINER_BRONZE ?? 'articles-bronze',
  SILVER: process.env.BLOB_CONTAINER_SILVER ?? 'articles-silver',
  GOLD:   process.env.ADLS_CONTAINER_GOLD   ?? 'articles-gold',
  ERROR:  'articles-error',
};

/**
 * Table names.
 */
const TABLES = {
  DEDUP:  process.env.TABLE_DEDUP  ?? 'articleDedup',
  AUDIT:  process.env.TABLE_AUDIT  ?? 'articleAudit',
};

/**
 * Queue names.
 */
const QUEUES = {
  ENRICH: process.env.QUEUE_ENRICH ?? 'article-enrich-queue',
};

module.exports = { INGEST_CATEGORIES, CONTAINERS, TABLES, QUEUES };