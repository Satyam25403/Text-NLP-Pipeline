'use strict';

/**
 * logger.js
 * Structured logger. Outputs JSON to stdout (Application Insights picks this up
 * automatically when running in Azure Functions). Falls back to plain console locally.
 *
 * Usage:
 *   const log = require('./logger')('fn-enrich');
 *   log.info('Processing article', { urlHash: 'abc123' });
 *   log.error('Language API failed', { urlHash, error: err.message });
 */

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

const MIN_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LOG_LEVELS.info;

function createLogger(component) {
  function write(level, message, meta = {}) {
    if (LOG_LEVELS[level] < MIN_LEVEL) return;

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      component,
      message,
      ...meta,
    };

    // Azure Functions captures stdout as traces
    const line = JSON.stringify(entry);
    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  return {
    debug: (msg, meta) => write('debug', msg, meta),
    info:  (msg, meta) => write('info',  msg, meta),
    warn:  (msg, meta) => write('warn',  msg, meta),
    error: (msg, meta) => write('error', msg, meta),
  };
}

module.exports = createLogger;