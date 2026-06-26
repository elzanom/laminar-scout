#!/usr/bin/env node
// Backfill positions.{pnl_sol, pnl_sol_pct, pool_active_bin_id, is_out_of_range, fee_per_tvl_24h}
// by querying Meteora /positions/{pool}/pnl for every (wallet, pool) combo where these fields are null.
//
// Usage:
//   node scripts/backfill-pnl-all.js [--concurrency 3] [--rate 0.8] [--max-pages 3]

import { openDb, getDb } from '../src/db/index.js';
import { fetchDlmmPnlForPool } from '../src/collector/meteora-pnl.js';
import { log, logAction } from '../src/utils/logger.js';

function parseArgs(argv) {
  const args = { concurrency: 3, rate: 0.8, maxPages: 3, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--concurrency') args.concurrency = Number(argv[++i]);
    else if (argv[i] === '--rate') args.rate = Number(argv[++i]);
    else if (argv[i] === '--max-pages') args.maxPages = Number(argv[++i]);
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node scripts/backfill-pnl-all.js [--concurrency N] [--rate SEC] [--max-pages M] [--dry-run]');
      process.exit(0);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  openDb();
  const db = getDb();

  console.log('=== backfill Meteora PnL fields for all wallet+pool combos ===\n');
  console.log(`concurrency: ${args.concurrency}`);
  console.log(`rate:        ${args.rate}s between requests`);
  console.log(`max-pages:   ${args.maxPages} per (wallet,pool)`);
  console.log(`dry-run:     ${args.dryRun}\n`);

  const pairs = db.prepare(`
    SELECT DISTINCT wallet_address, pool_address
    FROM positions
    WHERE status = 'closed'
      AND pool_active_bin_id IS NULL
      AND wallet_address IS NOT NULL
      AND pool_address IS NOT NULL
  `).all();
  console.log(`(wallet, pool) pairs needing backfill: ${pairs.length}`);
  if (pairs.length === 0) { console.log('(nothing to do)'); return; }

  const stats = { updated: 0, pairs_failed: 0, positions_updated: 0 };
  const t0 = Date.now();
  let done = 0;

  const queue = [...pairs];
  async function worker(id) {
    while (queue.length) {
      const item = queue.shift();
      if (!item) break;
      try {
        const r = await fetchDlmmPnlForPool(item.pool_address, item.wallet_address, {
          status: 'closed',
          pageSize: 100,
          maxPages: args.maxPages,
        });
        const list = r.byPosition
          ? Object.values(r.byPosition)
          : (r.positions || []);
        const updates = [];
        for (const pnl of list) {
          const pos = db.prepare(`SELECT id FROM positions WHERE id = ?`).get(pnl.positionAddress);
          if (!pos) continue;
          const poolActiveBin = pnl.poolActiveBinId != null ? Number(pnl.poolActiveBinId) : null;
          updates.push({
            id: pnl.positionAddress,
            pnl_sol: Number(pnl.pnlSol || 0),
            pnl_sol_pct: Number(pnl.pnlSolPctChange || 0),
            pool_active_bin_id: poolActiveBin,
            is_out_of_range: pnl.isOutOfRange ? 1 : 0,
            fee_per_tvl_24h: Number(pnl.feePerTvl24h || 0),
          });
        }
        if (!args.dryRun && updates.length) {
          const stmt = db.prepare(`
            UPDATE positions SET
              pnl_sol = ?, pnl_sol_pct = ?, pool_active_bin_id = ?,
              is_out_of_range = ?, fee_per_tvl_24h = ?
            WHERE id = ?
          `);
          const tx = db.transaction(() => {
            for (const u of updates) stmt.run(u.pnl_sol, u.pnl_sol_pct, u.pool_active_bin_id, u.is_out_of_range, u.fee_per_tvl_24h, u.id);
          });
          tx();
          stats.positions_updated += updates.length;
        }
      } catch (err) {
        stats.pairs_failed += 1;
        if (stats.pairs_failed < 5) log('warn', 'backfill-pnl-all: pair failed', { pair: `${item.wallet_address.slice(0, 8)}/${item.pool_address.slice(0, 8)}`, error: err.message });
      }
      done += 1;
      if (done % 25 === 0) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        const rate = (done / elapsed).toFixed(2);
        console.log(`  worker ${id}: ${done}/${pairs.length} (${rate}/s, updated=${stats.positions_updated}, failed=${stats.pairs_failed})`);
      }
      await new Promise((r) => setTimeout(r, args.rate * 1000));
    }
  }

  const workers = Array.from({ length: args.concurrency }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const remaining = db.prepare(`SELECT COUNT(DISTINCT wallet_address || '/' || pool_address) AS n FROM positions WHERE status='closed' AND pool_active_bin_id IS NULL`).get().n;

  console.log('\n=== results ===');
  console.log(`elapsed:             ${elapsed}s`);
  console.log(`pairs processed:     ${done}`);
  console.log(`pairs failed:        ${stats.pairs_failed}`);
  console.log(`positions updated:   ${stats.positions_updated}`);
  console.log(`pairs still null:    ${remaining}`);
  if (args.dryRun) console.log('(dry run — no DB writes)');
  if (!args.dryRun) logAction('backfill.pnl_all', { ...stats, elapsed_s: Number(elapsed), remaining });
  console.log('\nnext: node scripts/build-dataset.js --limit 5000 && node scripts/export-dataset.js');
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });