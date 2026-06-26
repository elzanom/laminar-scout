#!/usr/bin/env node
// Backfill training_records.pool_launchpad for records where it's currently NULL.
// Re-fetches Meteora pool-meta to get latest launchpad field. If pool-meta returns
// non-null launchpad, UPDATE the records. Otherwise leave as-is (older pools may not
// have launchpad metadata).
//
// Usage:
//   node scripts/backfill-pool-launchpad.js [--rate 0.4] [--dry-run]

import { openDb, getDb } from '../src/db/index.js';
import { fetchMeteoraPoolMeta, clearMetricsCache } from '../src/screener/metrics-fetcher.js';
import { log, logAction } from '../src/utils/logger.js';

function parseArgs(argv) {
  const args = { rate: 0.4, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--rate') args.rate = Number(argv[++i]);
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node scripts/backfill-pool-launchpad.js [--rate SEC] [--dry-run]');
      process.exit(0);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  clearMetricsCache();
  openDb();
  const db = getDb();

  console.log('=== backfill training_records.pool_launchpad ===\n');
  console.log(`rate:    ${args.rate}s/request`);
  console.log(`dry-run: ${args.dryRun}\n`);

  const pools = db.prepare(`
    SELECT DISTINCT pool_address FROM training_records
    WHERE pool_launchpad IS NULL
  `).all().map((r) => r.pool_address);
  console.log(`distinct pools needing launchpad: ${pools.length}`);
  if (pools.length === 0) { console.log('(nothing to do)'); return; }

  const stats = { updated: 0, still_null: 0, failed: 0 };
  const t0 = Date.now();

  for (let i = 0; i < pools.length; i++) {
    const pool = pools[i];
    try {
      const meta = await fetchMeteoraPoolMeta(pool);
      const lp = meta?.launchpad || null;
      if (lp) {
        if (!args.dryRun) {
          db.prepare(`UPDATE training_records SET pool_launchpad = ? WHERE pool_address = ?`).run(lp, pool);
        }
        stats.updated += 1;
      } else {
        stats.still_null += 1;
      }
    } catch (err) {
      stats.failed += 1;
      if (stats.failed < 5) log('warn', 'backfill-pool-launchpad: pool failed', { pool, error: err.message });
    }
    if ((i + 1) % 25 === 0) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      const rate = (i + 1 / elapsed).toFixed(2);
      console.log(`  ${i + 1}/${pools.length} (${rate}/s, updated=${stats.updated}, null=${stats.still_null}, failed=${stats.failed})`);
    }
    await new Promise((r) => setTimeout(r, args.rate * 1000));
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n=== results ===');
  console.log(`elapsed:    ${elapsed}s`);
  console.log(`updated:    ${stats.updated}`);
  console.log(`still null: ${stats.still_null}`);
  console.log(`failed:     ${stats.failed}`);
  console.log(`dry-run:    ${args.dryRun}`);
  if (!args.dryRun) logAction('backfill.pool_launchpad', { ...stats, elapsed_s: Number(elapsed) });
  console.log('\nnext: node scripts/build-dataset.js --limit 5000 && node scripts/export-dataset.js');
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });