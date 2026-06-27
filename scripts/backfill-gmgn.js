#!/usr/bin/env node
// Backfill training_records token-level fields via gmgn-cli:
//   - token_num_holders              (NEW — from gmgn token info holder_count)
//   - token_holder_concentration     (NEW — top 10 holder concentration ratio)
//   - token_x_circ_supply            (fills NULLs — Meteora doesn't expose; GMGN does)
//   - token_x_created_at             (fills NULLs — gmgn creation_timestamp)
//
// Requires:
//   - gmgn-cli on PATH (apt: npm i -g gmgn-cli; uses GMGN_API_KEY from .env)
//   - GMGN_API_KEY in .env
//
// Usage:
//   node scripts/backfill-gmgn.js [--rate 2] [--concurrency 1] [--limit 0] [--dry-run]
//
// Defaults (--rate 2 --concurrency 1) target gmgn-cli ~50 req/min free tier.
// Paid tiers can bump --rate 5 --concurrency 3.

import { openDb, getDb } from '../src/db/index.js';
import { getTokenMetrics, clearCache, ping } from '../src/collector/gmgn.js';
import { log, logAction } from '../src/utils/logger.js';

function parseArgs(argv) {
  const args = { rate: 2, concurrency: 1, limit: 0, dryRun: false, chain: 'sol' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--rate') args.rate = Number(argv[++i]);
    else if (argv[i] === '--concurrency') args.concurrency = Number(argv[++i]);
    else if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--chain') args.chain = String(argv[++i]);
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node scripts/backfill-gmgn.js [--rate SEC] [--concurrency N] [--limit N] [--chain sol] [--dry-run]');
      console.log('');
      console.log('Defaults (--rate 2 --concurrency 1) are tuned for gmgn-cli free tier (~50 req/min).');
      console.log('For paid tiers, try: --rate 5 --concurrency 3');
      console.log('');
      console.log('Populates: token_num_holders, token_holder_concentration, token_x_circ_supply, token_x_created_at');
      process.exit(0);
    }
  }
  return args;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function uniqueMintsFromRecords() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT DISTINCT token_pair_base_mint
    FROM training_records
    WHERE token_pair_base_mint IS NOT NULL
      AND token_pair_base_mint != ''
      AND (
        token_num_holders IS NULL
        OR token_holder_concentration IS NULL
        OR token_x_circ_supply IS NULL
        OR token_x_created_at IS NULL
      )
  `).all();
  return rows.map((r) => r.token_pair_base_mint).filter(Boolean);
}

function buildUpdateStmt(dryRun) {
  if (dryRun) return null;
  return getDb().prepare(`
    UPDATE training_records
    SET
      token_num_holders = COALESCE(?, token_num_holders),
      token_holder_concentration = COALESCE(?, token_holder_concentration),
      token_x_circ_supply = COALESCE(?, token_x_circ_supply),
      token_x_created_at = COALESCE(?, token_x_created_at),
      token_dev_hold_rate = COALESCE(?, token_dev_hold_rate)
    WHERE token_pair_base_mint = ?
      AND (
        token_num_holders IS NULL
        OR token_holder_concentration IS NULL
        OR token_x_circ_supply IS NULL
        OR token_x_created_at IS NULL
      )
  `);
}

async function main() {
  const args = parseArgs(process.argv);
  const start = Date.now();

  console.log('=== backfill token metrics via gmgn-cli ===\n');
  console.log(`rate:        ${args.rate} req/sec`);
  console.log(`concurrency: ${args.concurrency}`);
  console.log(`limit:       ${args.limit || '(all)'}`);
  console.log(`chain:       ${args.chain}`);
  console.log(`dry-run:     ${args.dryRun}\n`);

  const pingResult = await ping();
  if (!pingResult.ok) {
    console.error(`✗ gmgn-cli not available: ${pingResult.error}`);
    console.error('  install: npm i -g gmgn-cli');
    console.error('  set GMGN_API_KEY in .env');
    process.exit(1);
  }
  console.log(`✓ gmgn-cli ${pingResult.version}\n`);

  openDb();

  const mints = uniqueMintsFromRecords();
  const workList = args.limit > 0 ? mints.slice(0, args.limit) : mints;
  console.log(`tokens to backfill: ${workList.length} (${mints.length} unique, ${mints.length - workList.length} skipped by --limit)\n`);

  if (workList.length === 0) {
    console.log('nothing to do — all training_records already populated.');
    return;
  }

  const updateStmt = buildUpdateStmt(args.dryRun);
  let updatedRows = 0;
  let updatedTokens = 0;
  let errorCount = 0;
  const errorSamples = [];
  const startedAt = Date.now();

  let cursor = 0;
  const total = workList.length;

  async function worker(workerId) {
    while (true) {
      const idx = cursor++;
      if (idx >= total) return;
      const mint = workList[idx];
      const percent = ((idx + 1) / total * 100).toFixed(1);
      try {
        const metrics = await getTokenMetrics(args.chain, mint, { ratePerSec: args.rate });
        const affected = args.dryRun ? { changes: 0 } : updateStmt.run(
          metrics.holder_count,
          metrics.top10_concentration_calculated ?? metrics.top10_holder_rate,
          metrics.circulating_supply,
          metrics.creation_timestamp,
          metrics.dev_hold_rate,
          mint
        );
        updatedTokens += 1;
        updatedRows += affected.changes;
        if ((idx + 1) % 10 === 0 || idx === total - 1) {
          console.log(`  [w${workerId}] ${idx + 1}/${total} (${percent}%) updated=${updatedTokens} errors=${errorCount} elapsed=${((Date.now() - startedAt) / 1000).toFixed(0)}s`);
        }
      } catch (err) {
        errorCount += 1;
        if (errorSamples.length < 5) errorSamples.push({ mint, error: err.message });
        console.log(`  [w${workerId}] ${idx + 1}/${total} (${percent}%) error: ${err.message.slice(0, 80)}`);
      }
    }
  }

  const workers = Array.from({ length: args.concurrency }, (_, i) => worker(i));
  await Promise.all(workers);

  console.log('\n=== summary ===');
  console.log(`tokens processed:   ${updatedTokens}/${total}`);
  console.log(`training records updated: ${updatedRows}`);
  console.log(`errors:             ${errorCount}`);
  console.log(`elapsed:            ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  if (errorSamples.length > 0) {
    console.log('\nerror samples:');
    for (const s of errorSamples) console.log(`  ${s.mint}: ${s.error}`);
  }

  clearCache();

  logAction('backfill.gmgn', {
    tokensProcessed: updatedTokens,
    rowsUpdated: updatedRows,
    errors: errorCount,
    elapsedMs: Date.now() - start,
    rate: args.rate,
    concurrency: args.concurrency,
    dryRun: args.dryRun,
  });
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
