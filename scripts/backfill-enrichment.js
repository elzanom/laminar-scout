#!/usr/bin/env node
// Priority 1+2 enrichment:
//   1. Backfill wallets.unique_pools_traded via SQL aggregation
//   2. Quick-fill market_snapshots for every pool_address that has positions
//
// After running this, rebuild training_records (records/build-dataset.js) and re-export.

import { openDb, getDb } from '../src/db/index.js';
import * as positionsDb from '../src/db/positions.js';
import * as marketSnapshots from '../src/db/market-snapshots.js';
import { fetchMeteoraPoolMeta, clearMetricsCache } from '../src/screener/metrics-fetcher.js';
import { log, logAction } from '../src/utils/logger.js';

function nowSec() { return Math.floor(Date.now() / 1000); }

async function backfillWalletUniquePools() {
  console.log('=== [1/2] backfill wallets.unique_pools_traded ===');
  const db = getDb();
  const updated = db.prepare(`
    UPDATE wallets SET unique_pools_traded = (
      SELECT COUNT(DISTINCT pool_address)
      FROM positions
      WHERE positions.wallet_address = wallets.address
        AND positions.pool_address IS NOT NULL
    )
  `).run();
  console.log(`  updated ${updated.changes} wallets`);

  const sample = db.prepare(`
    SELECT address, unique_pools_traded, total_positions
    FROM wallets
    WHERE unique_pools_traded > 0
    ORDER BY unique_pools_traded DESC LIMIT 5
  `).all();
  console.log('  top 5 by unique_pools_traded:');
  for (const w of sample) console.log(`    ${w.address.slice(0, 12)}…  unique_pools=${String(w.unique_pools_traded).padStart(4)}  total_positions=${w.total_positions}`);

  const zero = db.prepare(`SELECT COUNT(*) as n FROM wallets WHERE unique_pools_traded = 0 OR unique_pools_traded IS NULL`).get().n;
  console.log(`  wallets with unique_pools_traded=0 (no positions yet): ${zero}`);
}

function deriveFeeTvlRatio(fees24h, tvl) {
  if (!Number.isFinite(fees24h) || !Number.isFinite(tvl) || tvl <= 0) return null;
  return (fees24h / tvl);
}

function deriveTokenVolume24h(token, poolMeta) {
  if (!token?.total_supply || !Number.isFinite(token.price)) return null;
  return token.total_supply * token.price;
}

async function quickFillSnapshots() {
  console.log('\n=== [2/2] market_snapshots quick-fill ===');
  clearMetricsCache();

  const allPools = getDb().prepare(`
    SELECT DISTINCT pool_address FROM positions
    WHERE pool_address IS NOT NULL
  `).all().map((r) => r.pool_address);
  console.log(`  ${allPools.length} distinct pools to snapshot`);

  let ok = 0, failed = 0, skipped = 0;
  let feeTvlCount = 0, vol24Count = 0, tokenVolCount = 0, priceCount = 0;

  for (let i = 0; i < allPools.length; i++) {
    const pool = allPools[i];
    try {
      const meta = await fetchMeteoraPoolMeta(pool);
      if (!meta) { failed += 1; continue; }

      const tvl = Number(meta.tvl || 0);
      const fees24h = Number(meta.fees?.['24h'] || 0);
      const vol24h = Number(meta.volume?.['24h'] || 0);
      const feeTvl = deriveFeeTvlRatio(fees24h, tvl);
      const tokenVol24 = deriveTokenVolume24h(meta.token_x, meta);

      marketSnapshots.insertSnapshot({
        pool_address: pool,
        timestamp: nowSec(),
        fee_apr: Number(meta.apr || 0),
        volume_24h: vol24h || null,
        tvl: tvl || null,
        fee_tvl_ratio: feeTvl,
        active_bin: null,
        price: Number(meta.current_price || 0) || null,
        token_price: Number(meta.token_x?.price || 0) || null,
        token_price_change_24h: null,
        token_volatility_24h: null,
        token_volume_24h: tokenVol24,
      });

      ok += 1;
      if (feeTvl != null) feeTvlCount += 1;
      if (vol24h > 0) vol24Count += 1;
      if (tokenVol24 != null) tokenVolCount += 1;
      if (Number(meta.current_price) > 0) priceCount += 1;
    } catch (err) {
      failed += 1;
      if (failed <= 3) log('warn', 'snapshot quick-fill failed', { pool, error: err.message });
    }
    if ((i + 1) % 25 === 0) console.log(`  ...${i + 1}/${allPools.length} (ok=${ok}, failed=${failed})`);
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`  done: ok=${ok}, failed=${failed}, skipped=${skipped}`);
  console.log(`  populated: fee_tvl_ratio=${feeTvlCount}, volume_24h=${vol24Count}, token_volume_24h=${tokenVolCount}, price=${priceCount}`);

  const total = getDb().prepare(`SELECT COUNT(*) as n FROM market_snapshots`).get().n;
  console.log(`  market_snapshots total rows: ${total}`);
  logAction('enrichment.snapshot_fill', { ok, failed, total, feeTvlCount, vol24Count, tokenVolCount, priceCount });
}

async function main() {
  openDb();
  const t0 = Date.now();
  await backfillWalletUniquePools();
  await quickFillSnapshots();
  console.log(`\nelapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('\nnext: node scripts/build-dataset.js --limit 1000 && node scripts/export-dataset.js');
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});