#!/usr/bin/env node
// Backfill positions.{organic_score, fdv} from Meteora pool-discovery summary API.
// Single paginated fetch (~9 pages × 50 pools = 414 pools), then match by pool_address.
//
// Usage:
//   node scripts/backfill-meteora-summary.js [--page-size 50]

import { openDb, getDb } from '../src/db/index.js';
import { fetchJson } from '../src/utils/retry.js';
import { clearMetricsCache } from '../src/screener/metrics-fetcher.js';
import { log, logAction } from '../src/utils/logger.js';

const METEORA_POOL_DISCOVERY = 'https://pool-discovery-api.datapi.meteora.ag/pools';

function parseArgs(argv) {
  const args = { pageSize: 50, maxPages: 100, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--page-size') args.pageSize = Number(argv[++i]);
    else if (argv[i] === '--max-pages') args.maxPages = Number(argv[++i]);
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node scripts/backfill-meteora-summary.js [--page-size 50] [--max-pages 100] [--dry-run]');
      process.exit(0);
    }
  }
  return args;
}

async function fetchMeteoraDiscoveryPage(page, pageSize) {
  const q = new URLSearchParams();
  q.set('page_size', String(pageSize));
  q.set('page', String(page));
  q.set('filter_by', 'pool_type=dlmm');
  q.set('timeframe', '24h');
  const url = `${METEORA_POOL_DISCOVERY}?${q.toString()}`;
  return fetchJson(url, {}, {}, `meteora-discovery-page-${page}`);
}

async function main() {
  const args = parseArgs(process.argv);
  clearMetricsCache();
  openDb();
  const db = getDb();

  console.log('=== backfill positions.{organic_score, fdv} from Meteora pool-discovery ===\n');
  console.log(`page size: ${args.pageSize}`);
  console.log(`dry-run:   ${args.dryRun}\n`);

  const poolAddresses = db.prepare(`
    SELECT DISTINCT pool_address FROM training_records
    WHERE pool_address IS NOT NULL
      AND (token_x_organic_score IS NULL OR token_x_fdv IS NULL)
  `).all().map((r) => r.pool_address);
  console.log(`distinct pools needing summary: ${poolAddresses.length}`);
  if (poolAddresses.length === 0) { console.log('(nothing to do)'); return; }

  console.log('  paginating through pool-discovery API…');
  const summaryByAddr = new Map();
  let page = 1;
  let totalFetched = 0;
  while (true) {
    try {
      const data = await fetchMeteoraDiscoveryPage(page, args.pageSize);
      const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
      if (!list.length) break;
      for (const p of list) {
        if (!p.pool_address && !p.address) continue;
        const addr = p.pool_address || p.address;
        const tx = p.token_x || p.base || {};
        summaryByAddr.set(addr, {
          organic_score: Number(p.organic_score ?? p.base_token_organic_score ?? tx.organic_score ?? 0) || null,
          fdv: Number(tx.fdv ?? p.base_token_fdv ?? 0) || null,
        });
      }
      totalFetched += list.length;
      console.log(`    page ${page}: +${list.length} (total ${totalFetched}, summary cache ${summaryByAddr.size})`);
      page += 1;
      if (list.length < args.pageSize) break;
      if (page > args.maxPages) break;
      await new Promise((r) => setTimeout(r, 250));
    } catch (err) {
      console.error(`  page ${page} fetch failed:`, err.message);
      break;
    }
  }

  console.log(`\n  unique pools in summary: ${summaryByAddr.size}`);
  console.log(`  matching against ${poolAddresses.length} needed pools…`);

  let updated = 0;
  let noMatch = 0;
  for (const pool of poolAddresses) {
    const info = summaryByAddr.get(pool);
    if (!info) { noMatch += 1; continue; }
    const r = db.prepare(`
      UPDATE training_records
      SET token_x_organic_score = COALESCE(?, token_x_organic_score),
          token_x_fdv           = COALESCE(?, token_x_fdv)
      WHERE pool_address = ?
        AND (token_x_organic_score IS NULL OR token_x_fdv IS NULL)
    `).run(info.organic_score, info.fdv, pool);
    updated += r.changes;
  }

  console.log(`\n=== results ===`);
  console.log(`summary cache:    ${summaryByAddr.size} pools`);
  console.log(`positions updated:${updated}`);
  console.log(`no match:         ${noMatch} pools (not in summary — likely older delisted)`);
  console.log(`dry-run:          ${args.dryRun}`);

  if (!args.dryRun) logAction('backfill.meteora_summary', { updated, noMatch, summarySize: summaryByAddr.size });
  console.log('\nnext: node scripts/build-dataset.js --limit 5000 && node scripts/export-dataset.js');
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });