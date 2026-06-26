#!/usr/bin/env node
// Backfill token_price_change_24h (and token_x_fdv if missing) using DexScreener.
// Free, no rate limit, works for all pools with on-chain liquidity.
//
// DexScreener returns:
//   pair.priceChange.h24 — 24h price change (%)
//   pair.fdv              — fully diluted valuation (USD)
//
// token_volatility_24h is not available from DexScreener free tier — leave NULL.
// Birdeye Pro / Jupiter Pro / DexScreener paid provide candle history for true volatility.
//
// Usage:
//   node scripts/backfill-dexscreener.js [--rate 0.2] [--dry-run]

import { openDb, getDb } from '../src/db/index.js';
import { fetchMeteoraPoolMeta, clearMetricsCache } from '../src/screener/metrics-fetcher.js';
import { log, logAction } from '../src/utils/logger.js';

function parseArgs(argv) {
  const args = { rate: 0.2, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--rate') args.rate = Number(argv[++i]);
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node scripts/backfill-dexscreener.js [--rate SEC] [--dry-run]');
      process.exit(0);
    }
  }
  return args;
}

async function fetchDexScreenerToken(mint) {
  const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
  if (!r.ok) throw new Error(`DexScreener ${r.status}`);
  const j = await r.json();
  return j;
}

function pickBestPair(pairs, baseMint) {
  if (!Array.isArray(pairs) || !pairs.length) return null;
  let best = null;
  let bestLiq = 0;
  for (const p of pairs) {
    if (p?.chainId !== 'solana') continue;
    const baseAddr = p?.baseToken?.address;
    const isMatch = baseAddr === baseMint;
    const liq = Number(p?.liquidity?.usd || 0);
    const prefer = isMatch ? liq * 2 : liq;
    if (prefer > bestLiq) { bestLiq = prefer; best = p; }
  }
  return best;
}

async function main() {
  const args = parseArgs(process.argv);
  clearMetricsCache();
  openDb();
  const db = getDb();

  console.log('=== backfill token_price_change_24h + token_x_fdv via DexScreener ===\n');
  console.log(`rate:    ${args.rate}s/request`);
  console.log(`dry-run: ${args.dryRun}\n`);

  const pools = db.prepare(`
    SELECT DISTINCT pool_address FROM training_records
    WHERE pool_address IS NOT NULL
  `).all().map((r) => r.pool_address);
  console.log(`distinct pools: ${pools.length}`);
  if (pools.length === 0) { console.log('(nothing to do)'); return; }

  const stats = { updated_change: 0, updated_fdv: 0, failed: 0, no_meta: 0, no_pair: 0 };
  const t0 = Date.now();

  for (let i = 0; i < pools.length; i++) {
    const pool = pools[i];
    try {
      const meta = await fetchMeteoraPoolMeta(pool);
      if (!meta?.token_x?.address) { stats.no_meta += 1; continue; }
      const mint = meta.token_x.address;
      const data = await fetchDexScreenerToken(mint);
      const pair = pickBestPair(data?.pairs, mint);
      if (!pair) { stats.no_pair += 1; continue; }

      const change24 = Number(pair?.priceChange?.h24 ?? 0) / 100;
      const fdv = Number(pair?.fdv ?? 0);

      if (!args.dryRun) {
        const r = db.prepare(`
          UPDATE training_records SET
            token_price_change_24h = COALESCE(?, token_price_change_24h),
            token_x_fdv           = COALESCE(?, token_x_fdv)
          WHERE pool_address = ?
        `).run(change24, fdv || null, pool);
        stats.updated_change += 1;
        if (fdv) stats.updated_fdv += 1;
      } else {
        stats.updated_change += 1;
        if (fdv) stats.updated_fdv += 1;
      }
    } catch (err) {
      stats.failed += 1;
      if (stats.failed < 5) log('warn', 'backfill-dexscreener: pool failed', { pool, error: err.message });
    }
    if ((i + 1) % 25 === 0) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      const rate = ((i + 1) / elapsed).toFixed(2);
      console.log(`  ${i + 1}/${pools.length} (${rate}/s, change=${stats.updated_change}, fdv=${stats.updated_fdv}, failed=${stats.failed})`);
    }
    await new Promise((r) => setTimeout(r, args.rate * 1000));
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n=== results ===');
  console.log(`elapsed:             ${elapsed}s`);
  console.log(`pools processed:     ${pools.length}`);
  console.log(`no meta:             ${stats.no_meta}`);
  console.log(`no pair:             ${stats.no_pair}`);
  console.log(`price change:        ${stats.updated_change}`);
  console.log(`fdv:                 ${stats.updated_fdv}`);
  console.log(`failed:              ${stats.failed}`);
  console.log(`dry-run:             ${args.dryRun}`);
  console.log('');
  console.log('note: token_volatility_24h left NULL (no free candle history source —');
  console.log('       Birdeye Pro / Jupiter Pro / DexScreener paid plans required).');
  if (!args.dryRun) logAction('backfill.dexscreener', { ...stats, elapsed_s: Number(elapsed) });
  console.log('\nnext: node scripts/build-dataset.js --limit 5000 && node scripts/export-dataset.js');
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });