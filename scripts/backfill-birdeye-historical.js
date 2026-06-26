#!/usr/bin/env node
// Backfill positions.{token_volatility_24h, token_price_change_24h} from Birdeye historical price API.
// Computes per-token 24h volatility (std dev) and 24h price change %.
// One Birdeye call per unique base_mint (cached for 1 hour in metrics-fetcher).
//
// Requires BIRDEYE_API_KEY in .env (free tier: ~50 req/min — enough for our scale).
//
// Usage:
//   node scripts/backfill-birdeye-historical.js [--rate 0.5] [--max-pages 0]

import { openDb, getDb } from '../src/db/index.js';
import { getConfig, reloadConfig } from '../src/config/config.js';
import { fetchMeteoraPoolMeta, clearMetricsCache } from '../src/screener/metrics-fetcher.js';
import { log, logAction } from '../src/utils/logger.js';

function parseArgs(argv) {
  const args = { rate: 0.4, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--rate') args.rate = Number(argv[++i]);
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node scripts/backfill-birdeye-historical.js [--rate SEC] [--dry-run]');
      process.exit(0);
    }
  }
  return args;
}

function stdDev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

async function fetchBirdeyeHistory(mint, apiKey) {
  const now = Math.floor(Date.now() / 1000);
  const url = `https://public-api.birdeye.so/defi/history_price?address=${mint}&address_type=token&type=1H&time_from=${now - 86400}&time_to=${now}`;
  const r = await fetch(url, {
    headers: { 'X-API-KEY': apiKey, 'x-chain': 'solana' },
  });
  if (!r.ok) throw new Error(`Birdeye ${r.status}`);
  const j = await r.json();
  if (!j?.data?.items || !Array.isArray(j.data.items)) return [];
  return j.data.items
    .filter((it) => it.value != null)
    .map((it) => ({ unixTime: it.unixTime, price: Number(it.value) }))
    .sort((a, b) => a.unixTime - b.unixTime);
}

async function main() {
  const args = parseArgs(process.argv);
  reloadConfig();
  const cfg = getConfig();
  clearMetricsCache();
  openDb();
  const db = getDb();

  console.log('=== backfill token_volatility_24h + token_price_change_24h via Birdeye ===\n');
  console.log(`rate:    ${args.rate}s/request`);
  console.log(`key:     ${cfg.birdeye.apiKey ? cfg.birdeye.apiKey.slice(0, 8) + '…' : '(NOT SET)'}`);
  console.log(`dry-run: ${args.dryRun}\n`);

  if (!cfg.birdeye.apiKey) {
    console.error('✗ BIRDEYE_API_KEY not set in .env');
    console.error('  set it to enable this backfill, or skip and leave token_volatility_24h/token_price_change_24h NULL');
    process.exit(1);
  }

  const pools = db.prepare(`
    SELECT DISTINCT p.pool_address
    FROM positions p
    WHERE p.status = 'closed'
      AND p.token_pair IS NOT NULL
  `).all().map((r) => r.pool_address);
  console.log(`distinct pools: ${pools.length}`);

  const stats = { updated: 0, failed: 0, skipped: 0, pools_processed: 0 };
  const t0 = Date.now();

  for (let i = 0; i < pools.length; i++) {
    const pool = pools[i];
    stats.pools_processed += 1;
    try {
      const meta = await fetchMeteoraPoolMeta(pool);
      if (!meta?.token_x?.address) { stats.skipped += 1; continue; }
      const mint = meta.token_x.address;
      const history = await fetchBirdeyeHistory(mint, cfg.birdeye.apiKey);
      if (history.length < 2) { stats.skipped += 1; continue; }

      const prices = history.map((h) => h.price);
      const vol = stdDev(prices) / (prices.reduce((a, b) => a + b, 0) / prices.length);
      const change24 = (prices[prices.length - 1] - prices[0]) / prices[0];

      if (!args.dryRun) {
        const r = db.prepare(`
          UPDATE positions SET
            token_volatility_24h = ?,
            token_price_change_24h = ?
          WHERE pool_address = ?
        `).run(vol, change24, pool);
        stats.updated += r.changes;
      } else {
        stats.updated += 1;
      }
    } catch (err) {
      stats.failed += 1;
      if (stats.failed < 5) log('warn', 'backfill-birdeye: pool failed', { pool, error: err.message });
    }
    if ((i + 1) % 10 === 0) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      const rate = ((i + 1) / elapsed).toFixed(2);
      console.log(`  ${i + 1}/${pools.length} (${rate}/s, updated=${stats.updated}, failed=${stats.failed}, skipped=${stats.skipped})`);
    }
    await new Promise((r) => setTimeout(r, args.rate * 1000));
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n=== results ===');
  console.log(`elapsed:           ${elapsed}s`);
  console.log(`pools processed:   ${stats.pools_processed}`);
  console.log(`updated:           ${stats.updated}`);
  console.log(`failed:            ${stats.failed}`);
  console.log(`skipped:           ${stats.skipped} (no meta or no history)`);
  console.log(`dry-run:           ${args.dryRun}`);
  if (!args.dryRun) logAction('backfill.birdeye_historical', { ...stats, elapsed_s: Number(elapsed) });
  console.log('\nnext: node scripts/build-dataset.js --limit 5000 && node scripts/export-dataset.js');
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });