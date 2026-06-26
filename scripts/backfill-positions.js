#!/usr/bin/env node
// Backfill positions.token_pair for closed positions by looking up Meteora pool-meta.
// Reason: positions ingested from Helius TX events (live path) didn't carry token_pair;
// positions ingested from Meteora PnL API only got it when pool-meta lookup happened at sync time.
// Many closed positions have token_pair=NULL as a result.
//
// Also: writes bin_step from pool-meta (if missing), and pulls pool-meta's
// token_x.{symbol,name} for downstream record-builder use.
//
// Usage:
//   node scripts/backfill-positions.js [--limit 500] [--concurrency 5]

import { openDb, getDb } from '../src/db/index.js';
import { fetchMeteoraPoolMeta, clearMetricsCache } from '../src/screener/metrics-fetcher.js';
import { log, logAction } from '../src/utils/logger.js';

function parseArgs(argv) {
  const args = { limit: null, concurrency: 5, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else if (argv[i] === '--concurrency') args.concurrency = Number(argv[++i]);
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node scripts/backfill-positions.js [--limit N] [--concurrency M] [--dry-run]');
      process.exit(0);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  openDb();
  clearMetricsCache();

  const db = getDb();
  console.log('=== backfill positions.token_pair from Meteora pool-meta ===\n');

  const total = db.prepare(`SELECT COUNT(*) AS n FROM positions WHERE token_pair IS NULL`).get().n;
  console.log(`positions with token_pair IS NULL: ${total}`);

  const pools = db.prepare(`
    SELECT DISTINCT pool_address
    FROM positions
    WHERE token_pair IS NULL
      AND pool_address IS NOT NULL
  `).all().map((r) => r.pool_address);
  const work = args.limit ? pools.slice(0, args.limit) : pools;
  console.log(`distinct pools to fetch: ${pools.length}, processing: ${work.length}`);
  console.log(`concurrency: ${args.concurrency}, dry-run: ${args.dryRun}\n`);

  const stats = {
    pools_processed: 0,
    pools_with_pair: 0,
    pools_failed: 0,
    positions_updated: 0,
    bin_step_updated: 0,
  };
  const t0 = Date.now();

  const queue = [...work];
  async function worker(id) {
    while (queue.length) {
      const pool = queue.shift();
      if (!pool) break;
      try {
        const meta = await fetchMeteoraPoolMeta(pool);
        if (!meta) { stats.pools_failed += 1; continue; }

        const symX = meta.token_x?.symbol;
        const symY = meta.token_y?.symbol;
        const newPair = (symX && symY) ? `${symX}/${symY}` : (meta.name || null);
        const newBinStep = meta.pool_config?.bin_step ?? meta.bin_step ?? null;

        if (newPair) {
          stats.pools_with_pair += 1;
          if (!args.dryRun) {
            const r = db.prepare(`UPDATE positions SET token_pair = ? WHERE pool_address = ? AND token_pair IS NULL`).run(newPair, pool);
            stats.positions_updated += r.changes;
            if (newBinStep != null) {
              const r2 = db.prepare(`UPDATE positions SET bin_step = ? WHERE pool_address = ? AND bin_step IS NULL`).run(newBinStep, pool);
              stats.bin_step_updated += r2.changes;
            }
          }
        } else {
          stats.pools_failed += 1;
        }
      } catch (err) {
        stats.pools_failed += 1;
        if (stats.pools_failed < 5) log('warn', 'backfill-positions: pool failed', { pool, error: err.message });
      }
      stats.pools_processed += 1;
      if (stats.pools_processed % 25 === 0) {
        console.log(`  worker ${id}: ${stats.pools_processed}/${work.length} (updated=${stats.positions_updated}, failed=${stats.pools_failed})`);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  const workers = Array.from({ length: args.concurrency }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  const remaining = db.prepare(`SELECT COUNT(*) AS n FROM positions WHERE token_pair IS NULL`).get().n;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log('\n=== results ===');
  console.log(`elapsed:                ${elapsed}s`);
  console.log(`pools processed:        ${stats.pools_processed}`);
  console.log(`  with token_pair:      ${stats.pools_with_pair}`);
  console.log(`  failed:               ${stats.pools_failed}`);
  console.log(`positions updated:      ${stats.positions_updated}`);
  console.log(`bin_step updated:       ${stats.bin_step_updated}`);
  console.log(`remaining NULL:         ${remaining}`);
  console.log();
  if (args.dryRun) console.log('(dry run — no DB writes)');
  if (remaining > 0) console.log(`  note: ${remaining} positions still have NULL token_pair (pools where meta returned no symbols)`);
  console.log('\nnext:');
  console.log('  node scripts/build-dataset.js --limit 5000    # rebuild training_records with token_pair');
  console.log('  node scripts/export-dataset.js                # export to CSV');

  if (!args.dryRun) logAction('backfill.positions.token_pair', stats);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});