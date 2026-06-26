#!/usr/bin/env node
// Backfill multiple token-level fields via Jupiter Tokens V2 + Price V3:
//   - token_x_organic_score (replaces Meteora discovery which only had ~100 pools)
//   - token_x_fdv           (replaces DexScreener; Jupiter authoritative)
//   - token_x_mcap          (NEW — Jupiter mcap, more accurate than Meteora's)
//   - token_x_liquidity     (NEW — pool liquidity USD)
//   - token_x_is_verified   (NEW — boolean)
//   - token_x_created_at    (NEW — token creation timestamp, separate from pool)
//   - token_price_change_24h (replaces DexScreener; direct from Price V3)
//   - token_num_buys_5m, token_num_sells_5m, token_buy_sell_ratio_5m (NEW from stats5m)
//   - token_volatility_24h  (NEW — proxy from |priceChange24h|; true std dev needs candle history)
//
// Requires JUPITER_API_KEY in .env (https://portal.jup.ag).
//
// Usage:
//   node scripts/backfill-jupiter.js [--rate 0.05] [--dry-run]

import { openDb, getDb } from '../src/db/index.js';
import { fetchMeteoraPoolMeta, clearMetricsCache } from '../src/screener/metrics-fetcher.js';
import { getConfig, reloadConfig } from '../src/config/config.js';
import { log, logAction } from '../src/utils/logger.js';

const PRICE_V3_URL = 'https://api.jup.ag/price/v3';
const TOKENS_V2_URL = 'https://api.jup.ag/tokens/v2/search';

function parseArgs(argv) {
  // Defaults tuned for Jupiter FREE tier (1 RPS). For Developer/Launch/Pro
  // (10+ RPS), you can safely bump concurrency to 3-5 and lower rate to 0.1.
  const args = { rate: 1.5, concurrency: 1, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--rate') args.rate = Number(argv[++i]);
    else if (argv[i] === '--concurrency') args.concurrency = Number(argv[++i]);
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node scripts/backfill-jupiter.js [--rate SEC] [--concurrency N] [--dry-run]');
      console.log('');
      console.log('Defaults (--rate 1.5 --concurrency 1) are tuned for Jupiter FREE tier (1 RPS).');
      console.log('For paid tiers (Developer 10 RPS, Launch 50 RPS, Pro 150 RPS), try:');
      console.log('  --rate 0.12 --concurrency 4');
      process.exit(0);
    }
  }
  return args;
}

async function jupiterFetch(url, apiKey, retries = 6) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await fetch(url, { headers: { 'x-api-key': apiKey } });
    if (r.status === 429 && attempt < retries) {
      // Respect Retry-After header if present, else exponential backoff
      const ra = Number(r.headers.get('retry-after'));
      const wait = Number.isFinite(ra) && ra > 0
        ? ra * 1000
        : 3000 * Math.pow(2, attempt);  // 3s, 6s, 12s, 24s, 48s, 96s
      console.log(`    [429] attempt ${attempt + 1}/${retries + 1}, backing off ${Math.round(wait/1000)}s`);
      await new Promise((res) => setTimeout(res, wait));
      continue;
    }
    if (r.status === 429) {
      const body = await r.text().catch(() => '');
      throw new Error(`Jupiter 429 retries exhausted: ${body.slice(0, 100)}`);
    }
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`Jupiter ${r.status}: ${body.slice(0, 100)}`);
    }
    return r.json();
  }
  throw new Error('Jupiter retries exhausted');
}

async function jupiterSearch(query, apiKey) {
  const j = await jupiterFetch(`${TOKENS_V2_URL}?query=${encodeURIComponent(query)}`, apiKey);
  return Array.isArray(j) ? j : [];
}

async function jupiterPrice(mints, apiKey) {
  if (!mints.length) return {};
  return jupiterFetch(`${PRICE_V3_URL}?ids=${mints.join(',')}`, apiKey);
}

async function main() {
  const args = parseArgs(process.argv);
  reloadConfig();
  const cfg = getConfig();
  clearMetricsCache();
  openDb();
  const db = getDb();

  console.log('=== backfill via Jupiter Tokens V2 + Price V3 ===\n');
  console.log(`jupiter key: ${cfg.jupiter.apiKey ? cfg.jupiter.apiKey.slice(0, 8) + '…' : '(NOT SET)'}`);
  console.log(`rate:        ${args.rate}s/request`);
  console.log(`concurrency: ${args.concurrency}`);
  console.log(`dry-run:     ${args.dryRun}\n`);

  if (!cfg.jupiter.apiKey) {
    console.error('✗ JUPITER_API_KEY not set in .env');
    process.exit(1);
  }

  const pools = db.prepare(`
    SELECT DISTINCT pool_address FROM training_records
    WHERE pool_address IS NOT NULL
  `).all().map((r) => r.pool_address);
  console.log(`distinct pools: ${pools.length}`);
  if (pools.length === 0) { console.log('(nothing to do)'); return; }

  const stats = {
    organic_score: 0, fdv: 0, mcap: 0, liquidity: 0, verified: 0, created: 0,
    price_change: 0, volatility_proxy: 0, stats5m: 0,
    no_meta: 0, no_token: 0, failed: 0,
  };
  const t0 = Date.now();

  // Concurrent worker pattern
  const queue = [...pools];
  let done = 0;

  async function worker(id) {
    while (queue.length) {
      const pool = queue.shift();
      if (!pool) break;
      try {
        const meta = await fetchMeteoraPoolMeta(pool);
        if (!meta?.token_x?.address) { stats.no_meta += 1; continue; }
        const mint = meta.token_x.address;
        const tokenHits = await jupiterSearch(mint, cfg.jupiter.apiKey);
        const token = tokenHits.find((t) => t.id === mint) || tokenHits[0];
        if (!token) { stats.no_token += 1; continue; }
        const priceHits = await jupiterPrice([mint], cfg.jupiter.apiKey);
        const price = priceHits[mint];

        const organicScore = Number(token.organicScore ?? 0) || null;
        const fdv = Number(token.fdv ?? 0) || null;
        const mcap = Number(token.mcap ?? 0) || null;
        const liquidity = Number(token.liquidity ?? 0) || null;
        const isVerified = token.isVerified == null ? null : (token.isVerified ? 1 : 0);
        const createdAt = token.createdAt ? Math.floor(new Date(token.createdAt).getTime() / 1000) : null;

        const priceChange24h = price ? Number(price.priceChange24h ?? 0) / 100 : null;
        const volatilityProxy = priceChange24h != null ? Math.abs(priceChange24h) : null;

        const s5 = token.stats5m;
        const numBuys5m = s5?.numBuys ?? null;
        const numSells5m = s5?.numSells ?? null;
        const buySellRatio = (numBuys5m != null && numSells5m != null && (numBuys5m + numSells5m) > 0)
          ? numBuys5m / (numBuys5m + numSells5m) : null;

        if (!args.dryRun) {
          db.prepare(`
            UPDATE training_records SET
              token_x_organic_score   = COALESCE(?, token_x_organic_score),
              token_x_fdv             = COALESCE(?, token_x_fdv),
              token_x_mcap            = ?,
              token_x_liquidity       = ?,
              token_x_is_verified     = COALESCE(?, token_x_is_verified),
              token_x_created_at      = ?,
              token_price_change_24h  = COALESCE(?, token_price_change_24h),
              token_volatility_24h    = ?,
              token_num_buys_5m       = ?,
              token_num_sells_5m      = ?,
              token_buy_sell_ratio_5m = ?
            WHERE pool_address = ?
          `).run(
            organicScore, fdv, mcap, liquidity, isVerified, createdAt,
            priceChange24h, volatilityProxy,
            numBuys5m, numSells5m, buySellRatio,
            pool,
          );
        }

        if (organicScore != null) stats.organic_score += 1;
        if (fdv != null) stats.fdv += 1;
        if (mcap != null) stats.mcap += 1;
        if (liquidity != null) stats.liquidity += 1;
        if (isVerified != null) stats.verified += 1;
        if (createdAt != null) stats.created += 1;
        if (priceChange24h != null) stats.price_change += 1;
        if (volatilityProxy != null) stats.volatility_proxy += 1;
        if (s5) stats.stats5m += 1;
      } catch (err) {
        stats.failed += 1;
        if (stats.failed < 5) log('warn', 'backfill-jupiter: pool failed', { pool, error: err.message });
      }
      done += 1;
      if (done % 50 === 0) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
        const rate = (done / elapsed).toFixed(2);
        console.log(`  worker ${id}: ${done}/${pools.length} (${rate}/s, failed=${stats.failed})`);
      }
      await new Promise((r) => setTimeout(r, args.rate * 1000));
    }
  }

  const workers = Array.from({ length: args.concurrency }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n=== results ===');
  console.log(`elapsed:               ${elapsed}s`);
  console.log(`pools processed:       ${done}`);
  console.log(`no meta:               ${stats.no_meta}`);
  console.log(`no token:              ${stats.no_token}`);
  console.log(`failed:                ${stats.failed}`);
  console.log();
  console.log('field coverage:');
  for (const [k, v] of Object.entries(stats)) {
    if (typeof v === 'number' && k !== 'failed' && k !== 'no_meta' && k !== 'no_token') {
      console.log(`  ${k.padEnd(22)} ${v} / ${pools.length}`);
    }
  }
  console.log();
  console.log('note: token_volatility_24h is a PROXY (|priceChange24h|); true std dev requires candle history (Birdeye Pro / Jupiter Pro).');
  if (!args.dryRun) logAction('backfill.jupiter', { ...stats, elapsed_s: Number(elapsed) });
  console.log('\nnext: node scripts/build-dataset.js --limit 5000 && node scripts/export-dataset.js');
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });