import * as walletsDb from '../db/wallets.js';
import * as positionsDb from '../db/positions.js';
import { backfillWallet, syncWallet } from '../collector/helius-history.js';
import { fetchWalletClosedPositions, fetchWalletOpenPositions } from '../collector/meteora-pnl.js';
import { computeMetricsFromClosed, calculateWalletScore, decideTier } from '../discovery/wallet-evaluator.js';
import { getConfig } from '../config/config.js';
import { log, logAction } from '../utils/logger.js';
import { recordSuccess, recordError, incrCounter } from '../utils/health.js';

function _nowSec() { return Math.floor(Date.now() / 1000); }

function _poolsTouchedByWallet(wallet) {
  const positions = positionsDb.listPositions({ wallet_address: wallet });
  const pools = new Set();
  for (const p of positions) pools.add(p.pool_address);
  return [...pools].filter(Boolean);
}

async function _maybeBackfill(walletRow) {
  const cfg = getConfig();
  const backfillDays = cfg.evaluationBackfillDays ?? 90;
  const recent = walletRow.history_backfilled_until && (_nowSec() - walletRow.history_backfilled_until < 24 * 3600);
  try {
    if (recent) return await syncWallet(walletRow.address);
    return await backfillWallet(walletRow.address, { days: backfillDays });
  } catch (err) {
    recordError('wallet_ranker.backfill', err, { wallet: walletRow.address });
    return { processed: 0, error: err.message };
  }
}

export async function rankWallet(address, opts = {}) {
  const cfg = getConfig();
  const force = opts.force === true;
  const walletRow = walletsDb.getWallet(address);
  if (!walletRow) return { ok: false, reason: 'not_found' };

  if (!force) {
    const reevalHours = cfg.reEvaluateIntervalHours ?? 168;
    const lastEval = walletRow.last_evaluated || 0;
    if (lastEval && (_nowSec() - lastEval) < reevalHours * 3600) {
      return { ok: false, reason: 'too_recent', last_evaluated: lastEval, reevaluate_in_sec: reevalHours * 3600 - (_nowSec() - lastEval) };
    }
  }

  const backfill = await _maybeBackfill(walletRow);

  let closedPositions = [];
  let openPositions = [];
  const pools = _poolsTouchedByWallet(address);
  if (pools.length) {
    try {
      const closedRes = await fetchWalletClosedPositions(address, pools);
      closedPositions = closedRes.positions;
    } catch (err) {
      recordError('wallet_ranker.closed_fetch', err, { wallet: address });
    }
    try {
      const openRes = await fetchWalletOpenPositions(address, pools);
      openPositions = openRes.positions;
    } catch (err) {
      recordError('wallet_ranker.open_fetch', err, { wallet: address });
    }
  }

  const metrics = computeMetricsFromClosed(closedPositions);
  const score = calculateWalletScore(metrics);
  const tier = decideTier(metrics, score, {
    minWalletScore: cfg.minWalletScore,
    minWinRate: cfg.minWinRate,
    minTotalPositions: cfg.minTotalPositions,
    minFeeYield: cfg.minFeeYield,
    autoPromoteToTracked: cfg.autoPromoteToTracked,
    autoDemoteTopWallet: cfg.autoDemoteTopWallet,
  });

  const updated = walletsDb.upsertWallet({
    ...walletRow,
    ...metrics,
    score,
    score_updated: _nowSec(),
    status: tier.status,
    is_tracked: tier.is_tracked ? 1 : 0,
    is_top_wallet: tier.is_top_wallet ? 1 : 0,
    reject_reason: tier.reason,
    evaluation_count: (walletRow.evaluation_count || 0) + 1,
    last_evaluated: _nowSec(),
    last_active: _nowSec(),
  });

  logAction('wallet_ranker.rank', { wallet: address, score, tier: tier.status, is_top: tier.is_top_wallet });
  incrCounter('wallet_ranker.ranked');
  recordSuccess('wallet_ranker', { wallet: address, score, tier: tier.status });

  return {
    ok: true,
    wallet: address,
    score,
    tier: tier.status,
    is_tracked: tier.is_tracked,
    is_top_wallet: tier.is_top_wallet,
    metrics,
    reason: tier.reason,
    poolsScanned: pools.length,
    closedPositions: closedPositions.length,
    openPositions: openPositions.length,
    backfill,
    updated_wallet: updated,
  };
}

export async function rankAllTracked(opts = {}) {
  const cfg = getConfig();
  const limit = opts.limit ?? 50;
  const tracked = walletsDb.listWallets({ status: 'tracked' }, { limit });
  const top = walletsDb.listWallets({ status: 'top' }, { limit });
  const all = [...tracked, ...top];
  const results = [];
  for (const w of all) {
    try {
      const r = await rankWallet(w.address, opts);
      results.push(r);
    } catch (err) {
      recordError('wallet_ranker.batch', err, { wallet: w.address });
      results.push({ ok: false, wallet: w.address, reason: 'error', error: err.message });
    }
  }
  return { ok: true, ranked: results.length, results };
}

export const _test = { _poolsTouchedByWallet, _maybeBackfill };