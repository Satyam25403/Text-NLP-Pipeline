'use strict';

/**
 * schemaUtils.js
 * Shared utilities for Azure AI Search index schema manipulation.
 * Used by create-index.js (at deploy time) and tests.
 */

/**
 * Recursively remove all `comment` fields from a schema object before
 * sending to the Azure AI Search REST API.
 * The API is strict — unknown properties return a 400 error.
 *
 * @param {*} obj - any value (object, array, primitive)
 * @returns cleaned copy with no `comment` keys at any depth
 */
function stripComments(obj) {
  if (Array.isArray(obj)) {
    return obj.map(stripComments);
  }
  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj)
        .filter(([k]) => k !== 'comment')
        .map(([k, v]) => [k, stripComments(v)]),
    );
  }
  return obj;
}

module.exports = { stripComments };