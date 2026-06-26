import { backfillWallet, syncWallet } from '../collector/helius-history.js';
import { fetchWalletClosedPositions, fetchWalletOpenPositions } from '../collector/meteora-pnl.js';
import { getWallet, upsertWallet, listCandidatesNeedingEval } from '../db/wallets.js';
import { listPositions } from '../db/positions.js';
import { log, logAction } from '../utils/logger.js';
import { recordSuccess, recordError, incrCounter } from '../utils/health.js';
import { getConfig } from '../config/config.js';
import { startPositionBuilder, syncWalletPositionsFromPnl } from '../trackers/position-builder.js';

function nowSec() { return Math.floor(Date.now() / 1000); }

export function computeMetricsFromClosed(closedPositions = []) {
  let total = 0;
  let wins = 0;
  let losses = 0;
  let totalPnlUsd = 0;
  let totalFeesUsd = 0;
  let totalDepositsUsd = 0;
  let totalDurationHours = 0;
  let durationCount = 0;
  for (const p of closedPositions) {
    total += 1;
    const pnl = Number(p.pnlUsd || 0);
    const fees = Number(p.totalFeesUsd || 0);
    const deposits = Number(p.totalDepositsUsd || 0);
    totalPnlUsd += pnl;
    totalFeesUsd += fees;
    totalDepositsUsd += deposits;
    if (pnl > 0) wins += 1;
    else if (pnl < 0) losses += 1;

    if (p.createdAt && p.closedAt) {
      const dur = (p.closedAt - p.createdAt) / 3600;
      if (Number.isFinite(dur) && dur >= 0) {
        totalDurationHours += dur;
        durationCount += 1;
      }
    }
  }
  const winRate = total > 0 ? wins / total : 0;
  const avgFeeYield = totalDepositsUsd > 0 ? totalFeesUsd / totalDepositsUsd : 0;
  const avgDurationHours = durationCount > 0 ? totalDurationHours / durationCount : 0;
  return {
    total_positions: total,
    win_count: wins,
    loss_count: losses,
    win_rate: winRate,
    total_pnl_usd: totalPnlUsd,
    total_fees_usd: totalFeesUsd,
    avg_fee_yield: avgFeeYield,
    avg_duration_hours: avgDurationHours,
  };
}

export function calculateWalletScore(metrics = {}) {
  const wr = Number(metrics.win_rate || 0);
  const feeYield = Number(metrics.avg_fee_yield || 0);
  const total = Number(metrics.total_positions || 0);
  const pnl = Number(metrics.total_pnl_usd || 0);
  const wrScore = wr * 40;
  const feeScore = Math.min((feeYield / 3) * 20, 20);
  const consistencyScore = Math.min((total / 100) * 20, 20);
  const pnlScore = pnl > 0 ? 20 : 0;
  return wrScore + feeScore + consistencyScore + pnlScore;
}

export function decideTier(metrics = {}, score = 0, thresholds = {}) {
  const {
    minWalletScore = 45,
    minWinRate = 0.65,
    minTotalPositions = 20,
    minFeeYield = 0.5,
    topScoreBoost = 15,
    autoPromoteToTracked = true,
    autoDemoteTopWallet = true,
  } = thresholds;

  if (metrics.total_positions < minTotalPositions) {
    return {
      status: 'candidate',
      reason: `insufficient_positions(${metrics.total_positions}<${minTotalPositions})`,
      is_tracked: 0,
      is_top_wallet: 0,
      eligible: false,
    };
  }

  const wr = Number(metrics.win_rate || 0);
  const feeYield = Number(metrics.avg_fee_yield || 0);
  const reasons = [];
  if (score < minWalletScore) reasons.push(`score<${minWalletScore}`);
  if (wr < minWinRate) reasons.push(`wr<${minWinRate}`);
  if (feeYield < minFeeYield) reasons.push(`fee_yield<${minFeeYield}`);
  if (reasons.length) {
    return {
      status: 'rejected',
      reason: reasons.join(','),
      is_tracked: 0,
      is_top_wallet: 0,
      eligible: false,
    };
  }

  const isTop = score >= (minWalletScore + topScoreBoost);
  return {
    status: autoPromoteToTracked ? 'tracked' : 'candidate',
    reason: 'passed',
    is_tracked: autoPromoteToTracked ? 1 : 0,
    is_top_wallet: isTop ? 1 : 0,
    eligible: true,
  };
}

function poolsTouchedByWallet(walletAddress) {
  const positions = listPositions({ wallet_address: walletAddress }, { limit: 2000 });
  const pools = new Set();
  for (const p of positions) {
    if (p.pool_address) pools.add(p.pool_address);
  }
  return [...pools];
}

export async function evaluateWallet(walletAddress, opts = {}) {
  if (!walletAddress) return { wallet: null, error: 'missing_wallet' };
  const cfg = getConfig();
  const start = Date.now();
  const dbWallet = getWallet(walletAddress);
  if (!dbWallet) return { wallet: walletAddress, skipped: 'not_in_db' };

  const minPositions = cfg.discovery.minPositionsToEvaluate;
  const days = cfg.discovery.evaluationBackfillDays;

  let backfillResult = null;
  const pbHandle = startPositionBuilder();

  try {
    if (opts.skipBackfill) {
      backfillResult = { skipped: true };
    } else if (dbWallet.history_backfilled_until && dbWallet.history_backfilled_until > 0 && (nowSec() - dbWallet.history_backfilled_until) < 24 * 3600) {
      try {
        backfillResult = await syncWallet(walletAddress, { limit: 100 });
      } catch (err) {
        recordError('wallet-evaluator.sync', err, { wallet: walletAddress });
        log('warn', 'wallet-evaluator: sync failed', { wallet: walletAddress, error: err.message });
      }
    } else {
      try {
        backfillResult = await backfillWallet(walletAddress, { days });
      } catch (err) {
        recordError('wallet-evaluator.backfill', err, { wallet: walletAddress });
        log('warn', 'wallet-evaluator: backfill failed', { wallet: walletAddress, error: err.message });
      }
    }
  } finally {
    pbHandle.stop();
  }

  const pools = poolsTouchedByWallet(walletAddress);

  let pnlSync = null;
  if (!opts.skipBackfill && pools.length > 0) {
    try {
      pnlSync = await syncWalletPositionsFromPnl(walletAddress, pools);
    } catch (err) {
      recordError('wallet-evaluator.pnlSync', err, { wallet: walletAddress });
      log('warn', 'wallet-evaluator: pnl sync failed', { wallet: walletAddress, error: err.message });
    }
  }

  let closedResult = { positions: [], perPool: {} };
  let openResult = { positions: [], perPool: {} };
  try {
    closedResult = await fetchWalletClosedPositions(walletAddress, pools, { status: 'closed' });
  } catch (err) {
    recordError('wallet-evaluator.closed', err, { wallet: walletAddress });
    log('warn', 'wallet-evaluator: closed fetch failed', { wallet: walletAddress, error: err.message });
  }
  try {
    openResult = await fetchWalletOpenPositions(walletAddress, pools, { status: 'open' });
  } catch (err) {
    recordError('wallet-evaluator.open', err, { wallet: walletAddress });
  }

  const allPositions = [...closedResult.positions, ...openResult.positions];
  const metrics = computeMetricsFromClosed(closedResult.positions);
  if (openResult.positions.length && !metrics.total_positions) {
    metrics.total_positions = openResult.positions.length;
  }

  if (metrics.total_positions < minPositions && !opts.forceEvaluate) {
    incrCounter('wallet_evaluator.skipped_insufficient', 1);
    recordSuccess('wallet-evaluator', { wallet: walletAddress, skipped: 'insufficient_positions', total: metrics.total_positions });
    log('info', 'wallet-evaluator: insufficient positions, deferring', {
      wallet: walletAddress,
      total: metrics.total_positions,
      min: minPositions,
    });
    return {
      wallet: walletAddress,
      skipped: 'insufficient_positions',
      metrics,
      poolsScanned: pools.length,
      backfill: backfillResult,
    };
  }

  const score = calculateWalletScore(metrics);
  const tier = decideTier(metrics, score, {
    minWalletScore: cfg.walletTier.minWalletScore,
    minWinRate: cfg.walletTier.minWinRate,
    minTotalPositions: cfg.walletTier.minTotalPositions,
    minFeeYield: cfg.walletTier.minFeeYield,
    autoPromoteToTracked: cfg.walletTier.autoPromoteToTracked,
    autoDemoteTopWallet: cfg.walletTier.autoDemoteTopWallet,
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

  incrCounter(`wallet_evaluator.evaluated.${tier.status}`, 1);
  incrCounter('wallet_evaluator.evaluated.total', 1);
  recordSuccess('wallet-evaluator', {
    wallet: walletAddress,
    tier: tier.status,
    score,
    total: metrics.total_positions,
    pools: pools.length,
  });
  logAction('wallet-evaluator.evaluate', {
    wallet: walletAddress,
    tier: tier.status,
    score: Number(score.toFixed(2)),
    total: metrics.total_positions,
    win_rate: Number(metrics.win_rate.toFixed(3)),
    reason: tier.reason,
    duration_ms: Date.now() - start,
  });

  return {
    wallet: walletAddress,
    tier: tier.status,
    is_top_wallet: tier.is_top_wallet,
    is_tracked: tier.is_tracked,
    score,
    metrics,
    poolsScanned: pools.length,
    closedPositions: closedResult.count,
    openPositions: openResult.count,
    reason: tier.reason,
    backfill: backfillResult,
    duration_ms: Date.now() - start,
    updated_wallet: updated,
  };
}

export async function processEvaluationQueue(opts = {}) {
  const cfg = getConfig();
  const limit = opts.limit || cfg.discovery.maxWalletCandidatesPerCycle || 50;
  const reEvaluateIntervalHours = cfg.discovery.reEvaluateIntervalHours || 168;
  const candidates = listCandidatesNeedingEval(limit);

  const dueForReEval = candidates.filter((w) => {
    if (w.status === 'candidate') return true;
    if (w.status === 'rejected' && w.last_evaluated) {
      return (nowSec() - w.last_evaluated) >= reEvaluateIntervalHours * 3600;
    }
    if (w.status === 'rejected' && !w.last_evaluated) return true;
    return false;
  });

  const results = [];
  for (const c of dueForReEval) {
    try {
      const r = await evaluateWallet(c.address, opts);
      results.push(r);
    } catch (err) {
      recordError('wallet-evaluator.queue', err, { wallet: c.address });
      results.push({ wallet: c.address, error: err.message });
    }
  }

  incrCounter('wallet_evaluator.cycle.candidates', candidates.length);
  incrCounter('wallet_evaluator.cycle.processed', results.length);
  recordSuccess('wallet-evaluator.cycle', {
    candidates: candidates.length,
    processed: results.length,
    reEvaluateIntervalHours,
  });
  logAction('wallet-evaluator.cycle', {
    candidates: candidates.length,
    processed: results.length,
  });

  return {
    candidatesFound: candidates.length,
    processed: results.length,
    results,
  };
}

export const _test = { computeMetricsFromClosed, calculateWalletScore, decideTier, poolsTouchedByWallet };