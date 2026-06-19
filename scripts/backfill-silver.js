'use strict';

/**
 * scripts/backfill-silver.js
 *
 * Re-enriches bronze articles that are missing from the silver layer.
 * Use this when:
 *   - fn-enrich was down for a period and articles piled up un-enriched
 *   - Language API or OpenAI keys were rotated and enrichment failed silently
 *   - You want to re-run enrichment after a schema change (e.g. adding a new field)
 *   - You need to populate silver for a new category added to INGEST_CATEGORIES
 *
 * HOW IT WORKS:
 *   1. Lists all bronze blobs for a given date range and category
 *   2. Checks whether the corresponding silver blob already exists
 *   3. For each bronze blob with no silver counterpart, enqueues it onto
 *      the article-enrich-queue so fn-enrich processes it normally
 *   4. Reports counts: total, already_enriched, queued, failed
 *
 * WHY QUEUE NOT DIRECT ENRICH:
 *   Calling the Language API and OpenAI directly from this script would bypass
 *   fn-enrich's error handling, retry logic, and audit logging. Enqueueing
 *   lets fn-enrich handle each article exactly as it would in normal operation.
 *
 * RATE LIMITING:
 *   Enqueues in batches of 10 with a 500ms pause between batches to avoid
 *   overwhelming fn-enrich on a cold start. Adjust --batch-size and --delay-ms
 *   based on your Language API tier throughput.
 *
 * USAGE:
 *   node scripts/backfill-silver.js --date 2024-01-15
 *   node scripts/backfill-silver.js --from 2024-01-01 --to 2024-01-15
 *   node scripts/backfill-silver.js --from 2024-01-01 --to 2024-01-15 --category technology
 *   node scripts/backfill-silver.js --date 2024-01-15 --dry-run
 *   node scripts/backfill-silver.js --from 2024-01-01 --to 2024-01-15 --force
 *
 * FLAGS:
 *   --date <YYYY-MM-DD>       Single date (shorthand for --from X --to X)
 *   --from <YYYY-MM-DD>       Start of date range (inclusive)
 *   --to   <YYYY-MM-DD>       End of date range (inclusive)
 *   --category <name>         Single category (default: all INGEST_CATEGORIES)
 *   --dry-run                 List what would be queued without actually enqueueing
 *   --force                   Re-enrich even if silver blob already exists
 *   --batch-size <n>          Enqueue batch size (default: 10)
 *   --delay-ms <n>            Delay between batches in ms (default: 500)
 *
 * REQUIRES: functions/.env with AZURE_STORAGE_CONNECTION_STRING
 */

require('dotenv').config({ path: `${__dirname}/../functions/.env` });

const { listBlobs, exists, buildBlobPath } = require('../functions/shared/blobClient');
const { enqueueArticles }                  = require('../functions/shared/queueClient');
const { INGEST_CATEGORIES, CONTAINERS }    = require('../functions/shared/config');

const BRONZE_CONTAINER = CONTAINERS.BRONZE;
const SILVER_CONTAINER = CONTAINERS.SILVER;

// ── Parse CLI args ─────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const getArg  = (flag, def = null) => {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : def;
};
const hasFlag = flag => args.includes(flag);

const dateArg    = getArg('--date');
const fromArg    = getArg('--from', dateArg);
const toArg      = getArg('--to',   dateArg);
const categoryArg = getArg('--category');
const DRY_RUN    = hasFlag('--dry-run');
const FORCE      = hasFlag('--force');
const BATCH_SIZE = parseInt(getArg('--batch-size', '10'), 10);
const DELAY_MS   = parseInt(getArg('--delay-ms',   '500'), 10);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

if (!fromArg || !toArg) {
  console.error('Usage: node backfill-silver.js --date YYYY-MM-DD');
  console.error('       node backfill-silver.js --from YYYY-MM-DD --to YYYY-MM-DD');
  process.exit(1);
}
if (!DATE_RE.test(fromArg) || !DATE_RE.test(toArg)) {
  console.error('Dates must be in YYYY-MM-DD format');
  process.exit(1);
}
if (fromArg > toArg) {
  console.error('--from must be on or before --to');
  process.exit(1);
}

const categories = categoryArg ? [categoryArg] : INGEST_CATEGORIES;

// ── Date range generator ───────────────────────────────────────────────────────
function* dateRange(from, to) {
  const current = new Date(from + 'T00:00:00Z');
  const end     = new Date(to   + 'T00:00:00Z');
  while (current <= end) {
    yield current.toISOString().split('T')[0];
    current.setUTCDate(current.getUTCDate() + 1);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('NLP Pipeline — Silver Backfill');
  console.log('='.repeat(50));
  console.log(`Date range  : ${fromArg} → ${toArg}`);
  console.log(`Categories  : ${categories.join(', ')}`);
  console.log(`Dry run     : ${DRY_RUN}`);
  console.log(`Force       : ${FORCE} (re-enrich even if silver exists)`);
  console.log(`Batch size  : ${BATCH_SIZE}`);
  console.log(`Delay       : ${DELAY_MS}ms between batches`);
  console.log('');

  const stats = { total: 0, alreadyEnriched: 0, queued: 0, failed: 0 };
  const toEnqueue = [];

  // ── Step 1: Collect bronze blobs missing a silver counterpart ──────────────
  console.log('Step 1: Scanning bronze layer...');

  for (const category of categories) {
    for (const dateStr of dateRange(fromArg, toArg)) {
      const prefix      = `${category}/${dateStr}/`;
      let   bronzeBlobs;

      try {
        bronzeBlobs = await listBlobs(BRONZE_CONTAINER, prefix);
      } catch (err) {
        console.error(`  ✗ Failed to list ${prefix}: ${err.message}`);
        stats.failed++;
        continue;
      }

      if (bronzeBlobs.length === 0) continue;

      for (const blobPath of bronzeBlobs) {
        stats.total++;
        const urlHash    = blobPath.split('/')[2]?.replace('.json', '');
        if (!urlHash) { stats.failed++; continue; }

        const silverPath = buildBlobPath(category, dateStr, urlHash);

        // Check silver existence (skip if already enriched, unless --force)
        if (!FORCE) {
          try {
            const silverExists = await exists(SILVER_CONTAINER, silverPath);
            if (silverExists) {
              stats.alreadyEnriched++;
              continue;
            }
          } catch (err) {
            console.warn(`  ⚠ Could not check silver for ${urlHash}: ${err.message} — will re-enqueue`);
          }
        }

        toEnqueue.push({
          blobPath,
          urlHash,
          category,
          ingestedAt: new Date().toISOString(),
        });
      }
    }
  }

  console.log(`  Bronze blobs found  : ${stats.total}`);
  console.log(`  Already enriched    : ${stats.alreadyEnriched}`);
  console.log(`  To enqueue          : ${toEnqueue.length}`);
  console.log('');

  if (toEnqueue.length === 0) {
    console.log('Nothing to backfill — all bronze articles already have silver counterparts.');
    return;
  }

  // ── Step 2: Enqueue in batches ─────────────────────────────────────────────
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would enqueue ${toEnqueue.length} articles. Sample:`);
    toEnqueue.slice(0, 5).forEach(a => console.log(`  ${a.blobPath}`));
    if (toEnqueue.length > 5) console.log(`  ... and ${toEnqueue.length - 5} more`);
    return;
  }

  console.log(`Step 2: Enqueueing ${toEnqueue.length} articles in batches of ${BATCH_SIZE}...`);

  for (let i = 0; i < toEnqueue.length; i += BATCH_SIZE) {
    const batch    = toEnqueue.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const total    = Math.ceil(toEnqueue.length / BATCH_SIZE);

    try {
      const result = await enqueueArticles(batch);
      stats.queued  += result.enqueued;
      stats.failed  += result.failed;
      console.log(`  Batch ${batchNum}/${total}: ${result.enqueued} queued, ${result.failed} failed`);
    } catch (err) {
      console.error(`  Batch ${batchNum}/${total}: FAILED — ${err.message}`);
      stats.failed += batch.length;
    }

    if (i + BATCH_SIZE < toEnqueue.length) await sleep(DELAY_MS);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('');
  console.log('='.repeat(50));
  console.log(`Total bronze blobs   : ${stats.total}`);
  console.log(`Already enriched     : ${stats.alreadyEnriched}`);
  console.log(`Queued for enrichment: ${stats.queued}`);
  console.log(`Failed               : ${stats.failed}`);
  console.log('');

  if (stats.queued > 0) {
    console.log(`✓ ${stats.queued} articles enqueued. fn-enrich will process them from article-enrich-queue.`);
    console.log('  Monitor progress in Azure portal → Storage → Queues → article-enrich-queue');
    console.log('  Or check Application Insights for fn-enrich "Enrichment complete" traces.');
  }

  if (stats.failed > 0) {
    console.error(`✗ ${stats.failed} failures. Check logs above and re-run for the affected date range.`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});