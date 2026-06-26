#!/usr/bin/env node
// Re-evaluate all evaluated wallets against current config thresholds.

import { openDb } from '../src/db/index.js';
import { listWallets, upsertWallet } from '../src/db/wallets.js';
import { listPositions } from '../src/db/positions.js';
import { evaluateWallet, computeMetricsFromClosed, calculateWalletScore, decideTier } from '../src/discovery/wallet-evaluator.js';
import { getConfig, reloadConfig } from '../src/config/config.js';
import { log } from '../src/utils/logger.js';

function nowSec() { return Math.floor(Date.now() / 1000); }

function localEvaluate(walletAddress) {
  const dbWallet = listWallets({}).find((w) => w.address === walletAddress);
  if (!dbWallet) return null;
  const closed = listPositions({ wallet_address: walletAddress, status: 'closed' });
  const open = listPositions({ wallet_address: walletAddress, status: 'open' });
  const metrics = computeMetricsFromClosed(closed.map((p) => ({
    pnlUsd: p.pnl_usd,
    totalFeesUsd: p.fees_earned_usd,
    totalDepositsUsd: p.capital_usd,
    createdAt: p.entry_timestamp,
    closedAt: p.exit_timestamp,
  })));
  if (open.length && !metrics.total_positions) metrics.total_positions = open.length;
  const score = calculateWalletScore(metrics);
  const cfg = getConfig();
  const tier = decideTier(metrics, score, {
    minWalletScore: cfg.walletTier.minWalletScore,
    minWinRate: cfg.walletTier.minWinRate,
    minTotalPositions: cfg.walletTier.minTotalPositions,
    minFeeYield: cfg.walletTier.minFeeYield,
    autoPromoteToTracked: cfg.walletTier.autoPromoteToTracked,
  });
  const updated = upsertWallet({
    address: walletAddress,
    metrics,
    score,
    score_updated: nowSec(),
    status: tier.status,
    is_tracked: tier.is_tracked,
    is_top_wallet: tier.is_top_wallet,
    reject_reason: tier.reason,
    last_evaluated: nowSec(),
    evaluation_count: (dbWallet.evaluation_count || 0) + 1,
  });
  return { score, metrics, tier, updated };
}

async function main() {
  reloadConfig();
  openDb();
  const cfg = getConfig();

  console.log('=== re-evaluate with new thresholds ===');
  console.log(`minWalletScore: ${cfg.walletTier.minWalletScore}`);
  console.log(`minWinRate:     ${cfg.walletTier.minWinRate}`);
  console.log(`minFeeYield:    ${cfg.walletTier.minFeeYield}`);
  console.log(`topScoreBoost:  ${cfg.walletTier.topScoreBoost}`);
  console.log();

  const all = listWallets({}).filter((w) => w.score && w.score > 0);
  console.log(`re-evaluating ${all.length} wallets from local positions table...`);
  console.log();

  console.log('address                    score      tier        wr       fee_yield  positions  reason');
  console.log('-------------------------- ---------- ----------- -------- ---------- ---------- ----------------');

  const buckets = { top: [], tracked: [], candidate: [], rejected: [] };
  for (const w of all) {
    const r = localEvaluate(w.address);
    if (!r) continue;
    const score = r.score.toFixed(2).padStart(8);
    const tier = r.tier.status.padEnd(11);
    const wr = (r.metrics.win_rate * 100).toFixed(1).padStart(6) + '%';
    const fy = (r.metrics.avg_fee_yield * 100).toFixed(2).padStart(8) + '%';
    const pos = String(r.metrics.total_positions).padStart(8);
    const reason = r.tier.reason;
    console.log(`${w.address.slice(0, 26).padEnd(26)} ${score}  ${tier} ${wr}  ${fy}   ${pos}   ${reason}`);
    buckets[r.tier.status].push(w.address);
  }

  console.log();
  console.log('=== tier distribution ===');
  for (const [t, list] of Object.entries(buckets)) {
    console.log(`  ${t.padEnd(11)} ${list.length}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});