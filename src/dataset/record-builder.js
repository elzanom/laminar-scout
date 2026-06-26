import * as positionsDb from '../db/positions.js';
import * as walletsDb from '../db/wallets.js';
import * as trainingDb from '../db/training-records.js';
import * as marketSnapshots from '../db/market-snapshots.js';
import { fetchMeteoraPoolMeta } from '../screener/metrics-fetcher.js';
import { onTxEvent, offTxEvent, TX_EVENT_TYPES } from '../collector/event-bus.js';
import { log } from '../utils/logger.js';
import { recordSuccess, recordError, incrCounter } from '../utils/health.js';

function _dayOfWeek(ts) {
  if (!ts) return null;
  return new Date(ts * 1000).getUTCDay();
}

function _hourOfDay(ts) {
  if (!ts) return null;
  return new Date(ts * 1000).getUTCHours();
}

async function _safePoolMeta(poolAddress) {
  try {
    return await fetchMeteoraPoolMeta(poolAddress);
  } catch (err) {
    recordError('record_builder.pool_meta', err, { pool: poolAddress });
    return null;
  }
}

function _safeNumber(n) {
  if (n == null) return null;
  if (typeof n === 'number') return Number.isFinite(n) ? n : null;
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

export async function buildTrainingRecordFromPosition(position) {
  if (!position) return null;
  if (position.status !== 'closed') return null;
  if (!position.entry_timestamp || !position.exit_timestamp) return null;

  const wallet = walletsDb.getWallet(position.wallet_address);
  const snapshot = marketSnapshots.nearestSnapshotAt(position.pool_address, position.entry_timestamp, 24 * 3600);
  const meta = await _safePoolMeta(position.pool_address);
  const tokenX = meta?.token_x?.address || meta?.token_x_mint || meta?.mint_x;
  const tokenY = meta?.token_y?.address || meta?.token_y_mint || meta?.mint_y;
  const daysSincePoolCreated = meta?.created_at && position.entry_timestamp
    ? Math.max(0, (position.entry_timestamp - (meta.created_at > 1e12 ? Math.floor(meta.created_at / 1000) : meta.created_at)) / 86400)
    : null;

  const discoveryLagSec = wallet?.first_seen && position.entry_timestamp
    ? position.entry_timestamp - wallet.first_seen
    : null;
  const discoveredBeforeEntry = discoveryLagSec != null && discoveryLagSec >= 0;

  const binStepFromMeta = _safeNumber(meta?.pool_config?.bin_step ?? meta?.bin_step ?? meta?.dlmm_params?.bin_step);
  const tokenPairFromMeta = (meta?.token_x?.symbol && meta?.token_y?.symbol)
    ? `${meta.token_x.symbol}/${meta.token_y.symbol}`
    : null;

  const tx = meta?.token_x || {};
  const ty = meta?.token_y || {};
  const tokenXCreated = tx?.created_at || meta?.created_at;
  const tokenXAgeHours = tokenXCreated && position.entry_timestamp
    ? Math.max(0, (position.entry_timestamp - (tokenXCreated > 1e12 ? Math.floor(tokenXCreated / 1000) : tokenXCreated)) / 3600)
    : null;

  const lowerBin = _safeNumber(position.bin_lower);
  const upperBin = _safeNumber(position.bin_upper);
  const binCenter = (lowerBin != null && upperBin != null) ? (lowerBin + upperBin) / 2 : null;
  const binRangeWidth = _safeNumber(position.bin_range_width)
    ?? (lowerBin != null && upperBin != null ? upperBin - lowerBin + 1 : null);

  const recentPositions = _recentClosedPositions(position.wallet_address, position.entry_timestamp, 30 * 86400);
  const recentStats = _computeRecentStats(recentPositions);

  const priorPositions = _priorClosedPositions(position.wallet_address, position.entry_timestamp);
  const priorStats = _computePriorStats(priorPositions);

  const priorInPoolPositions = _priorInPoolPositions(position.wallet_address, position.pool_address, position.entry_timestamp);
  const priorInPoolStats = _computePriorInPoolStats(priorInPoolPositions);

  const record = {
    position_id: position.id,
    wallet_address: position.wallet_address,
    pool_address: position.pool_address,

    entry_timestamp: position.entry_timestamp,
    close_timestamp: position.exit_timestamp,

    was_profitable: position.is_profitable ?? (position.pnl_usd > 0 ? 1 : 0),
    pnl_usd: _safeNumber(position.pnl_usd),
    pnl_pct: _safeNumber(position.pnl_pct),
    pnl_sol: _safeNumber(position.pnl_sol),
    pnl_sol_pct: _safeNumber(position.pnl_sol_pct),
    fee_earned_usd: _safeNumber(position.fees_earned_usd),
    fee_yield: _safeNumber(position.fee_yield),
    duration_hours: _safeNumber(position.duration_hours),

    pool_fee_apr: _safeNumber(snapshot?.fee_apr ?? meta?.fee_apr ?? meta?.fee),
    pool_apr: _safeNumber(meta?.apr),
    pool_apy: _safeNumber(meta?.apy),
    pool_volume_24h: _safeNumber(snapshot?.volume_24h ?? meta?.volume_24h),
    pool_tvl: _safeNumber(snapshot?.tvl ?? meta?.tvl),
    fee_tvl_ratio: _safeNumber(snapshot?.fee_tvl_ratio),
    pool_bin_step: position.bin_step ?? binStepFromMeta ?? null,
    pool_launchpad: meta?.launchpad || null,
    pool_has_farm: meta?.has_farm == null ? null : (meta.has_farm ? 1 : 0),
    pool_farm_apr: _safeNumber(meta?.farm_apr),
    pool_dynamic_fee_pct: _safeNumber(meta?.dynamic_fee_pct),
    pool_current_price: _safeNumber(meta?.current_price),
    token_pair: position.token_pair || tokenPairFromMeta || (meta?.name ? meta.name : (tokenX && tokenY ? `${tokenX.slice(0, 6)}/${tokenY.slice(0, 6)}` : null)),
    token_pair_base_mint: tokenX || null,
    token_pair_quote_mint: tokenY || null,
    days_since_pool_created: daysSincePoolCreated != null ? Number(daysSincePoolCreated.toFixed(3)) : null,
    pool_token_x_age_hours: tokenXAgeHours != null ? Number(tokenXAgeHours.toFixed(2)) : null,

    token_x_symbol: tx.symbol || null,
    token_x_market_cap: _safeNumber(tx.market_cap),
    token_x_fdv: _safeNumber(tx.fdv),
    token_x_holders: _safeNumber(tx.holders),
    token_x_organic_score: _safeNumber(tx.organic_score),
    token_x_is_verified: tx.is_verified == null ? null : (tx.is_verified ? 1 : 0),
    token_x_freeze_disabled: tx.freeze_authority_disabled == null ? null : (tx.freeze_authority_disabled ? 1 : 0),
    token_y_symbol: ty.symbol || null,
    token_y_is_sol: (tokenY === 'So11111111111111111111111111111111111111112') ? 1 : 0,
    token_volatility_24h: _safeNumber(snapshot?.token_volatility_24h),
    token_price_change_24h: _safeNumber(snapshot?.token_price_change_24h),
    volume_vs_7d_avg: null,

    bin_range_width: binRangeWidth,
    bin_lower: lowerBin,
    bin_upper: upperBin,
    bin_center_distance: binCenter != null && position.pool_active_bin_id != null
      ? Math.abs(binCenter - position.pool_active_bin_id) : null,
    is_out_of_range: position.is_out_of_range == null ? null : (position.is_out_of_range ? 1 : 0),
    capital_usd: _safeNumber(position.capital_usd),
    fee_per_tvl_24h: _safeNumber(position.fee_per_tvl_24h),
    hour_of_day: _hourOfDay(position.entry_timestamp),
    day_of_week: _dayOfWeek(position.entry_timestamp),

    wallet_score_at_entry: _safeNumber(wallet?.score),
    wallet_wr_at_entry: _safeNumber(wallet?.win_rate),
    wallet_pnl_at_entry: _safeNumber(wallet?.total_pnl_usd),
    wallet_position_count_at_entry: _safeNumber(wallet?.total_positions),
    wallet_is_top_at_entry: wallet?.is_top_wallet ? 1 : 0,
    wallet_is_tracked_at_entry: wallet?.is_tracked ? 1 : 0,
    wallet_recent_wr_30d: recentStats.recent_wr,
    wallet_recent_fee_yield_30d: recentStats.recent_fee_yield,
    wallet_recent_pnl_30d: recentStats.recent_pnl,
    wallet_recent_position_count_30d: recentStats.recent_count,
    // wallet_prior_* = wallet state computed from positions closed BEFORE this entry.
    // These provide genuine at-entry context (vs wallet_*_at_entry which is current-state).
    wallet_prior_pnl_usd: _safeNumber(priorStats.prior_pnl_usd),
    wallet_prior_fees_usd: _safeNumber(priorStats.prior_fees_usd),
    wallet_prior_capital_usd: _safeNumber(priorStats.prior_capital_usd),
    wallet_prior_position_count: priorStats.prior_position_count ?? null,
    wallet_prior_win_rate: priorStats.prior_win_rate,
    wallet_prior_wins: priorStats.prior_wins,
    wallet_prior_losses: priorStats.prior_losses,
    // wallet_pool_revisit_* = prior positions in the SAME pool (familiarity signal).
    wallet_pool_revisit_count: priorInPoolStats.pool_revisit_count,
    wallet_pool_revisit_pnl_usd: _safeNumber(priorInPoolStats.pool_revisit_pnl_usd),
    wallet_pool_revisit_wr: priorInPoolStats.pool_revisit_wr,
    wallet_pool_revisit_fees_usd: _safeNumber(priorInPoolStats.pool_revisit_fees_usd),
    is_first_in_pool: priorInPoolStats.is_first_in_pool,
    wallet_activity_span_days: (wallet?.first_seen && wallet?.last_active)
      ? Number(((wallet.last_active - wallet.first_seen) / 86400).toFixed(2))
      : null,
    wallet_unique_pools_traded: _safeNumber(wallet?.unique_pools_traded),

    wallet_discovery_source: wallet?.source || null,
    wallet_discovered_at: wallet?.first_seen || null,
    wallet_position_index: discoveredBeforeEntry ? 1 : (discoveryLagSec != null ? 0 : null),
  };

  return record;
}

function _recentClosedPositions(walletAddress, beforeTs, windowSec) {
  try {
    if (!beforeTs) return [];
    const cutoff = beforeTs - windowSec;
    // DB-side filter: positions closed in [cutoff, beforeTs), most-recently-closed first.
    // Returns the most recent `limit` closed positions before the reference entry.
    return positionsDb.listPositions(
      { wallet_address: walletAddress, status: 'closed', exit_before: beforeTs },
      { limit: 200, orderBy: 'exit_timestamp DESC' },
    ).filter((p) => p.exit_timestamp && p.exit_timestamp >= cutoff);
  } catch {
    return [];
  }
}

// All positions closed before this entry (no time window).
// Used to compute at-entry wallet context — what was the wallet doing BEFORE
// opening this position? Captures lifetime PnL, fees, capital deployed, win rate
// up to (but excluding) the entry moment.
function _priorClosedPositions(walletAddress, beforeTs) {
  try {
    if (!beforeTs) return [];
    return positionsDb.listPositions(
      { wallet_address: walletAddress, status: 'closed', exit_before: beforeTs },
      { limit: 5000, orderBy: 'exit_timestamp DESC' },
    );
  } catch {
    return [];
  }
}

function _computePriorStats(positions) {
  if (!positions.length) {
    return {
      prior_pnl_usd: null,
      prior_fees_usd: null,
      prior_capital_usd: null,
      prior_position_count: 0,
      prior_win_rate: null,
      prior_wins: null,
      prior_losses: null,
    };
  }
  let wins = 0, losses = 0, fees = 0, deposits = 0, pnl = 0;
  for (const p of positions) {
    if (p.pnl_usd > 0) wins += 1;
    else if (p.pnl_usd < 0) losses += 1;
    fees += p.fees_earned_usd || 0;
    deposits += p.capital_usd || 0;
    pnl += p.pnl_usd || 0;
  }
  const total = positions.length;
  return {
    prior_pnl_usd: pnl,
    prior_fees_usd: fees,
    prior_capital_usd: deposits,
    prior_position_count: total,
    prior_win_rate: total > 0 ? wins / total : null,
    prior_wins: wins,
    prior_losses: losses,
  };
}

// Positions the same wallet had in the SAME POOL, closed BEFORE this entry.
// Captures "pool familiarity" — wallets that revisit a pool likely have more
// conviction / better understanding of that specific pool's dynamics.
function _priorInPoolPositions(walletAddress, poolAddress, beforeTs) {
  try {
    if (!beforeTs || !walletAddress || !poolAddress) return [];
    return positionsDb.listPositions(
      { wallet_address: walletAddress, pool_address: poolAddress, status: 'closed', exit_before: beforeTs },
      { limit: 1000, orderBy: 'exit_timestamp DESC' },
    );
  } catch {
    return [];
  }
}

function _computePriorInPoolStats(positions) {
  if (!positions.length) {
    return {
      pool_revisit_count: 0,
      pool_revisit_pnl_usd: null,
      pool_revisit_wr: null,
      pool_revisit_fees_usd: null,
      is_first_in_pool: 1,
    };
  }
  let wins = 0, fees = 0, pnl = 0;
  for (const p of positions) {
    if (p.pnl_usd > 0) wins += 1;
    fees += p.fees_earned_usd || 0;
    pnl += p.pnl_usd || 0;
  }
  const total = positions.length;
  return {
    pool_revisit_count: total,
    pool_revisit_pnl_usd: pnl,
    pool_revisit_wr: total > 0 ? wins / total : null,
    pool_revisit_fees_usd: fees,
    is_first_in_pool: 0,
  };
}

function _computeRecentStats(positions) {
  if (!positions.length) return { recent_wr: null, recent_fee_yield: null, recent_pnl: null, recent_count: 0 };
  let wins = 0, losses = 0, fees = 0, deposits = 0, pnl = 0;
  for (const p of positions) {
    if (p.pnl_usd > 0) wins += 1;
    else if (p.pnl_usd < 0) losses += 1;
    fees += p.fees_earned_usd || 0;
    deposits += p.capital_usd || 0;
    pnl += p.pnl_usd || 0;
  }
  const total = positions.length;
  const recentFeeYield = deposits > 0 ? fees / deposits : 0;
  return {
    recent_wr: total > 0 ? wins / total : 0,
    recent_fee_yield: recentFeeYield,
    recent_pnl: pnl,
    recent_count: total,
  };
}

export async function recordClosedPosition(position) {
  try {
    const rec = await buildTrainingRecordFromPosition(position);
    if (!rec) return null;
    trainingDb.insertTrainingRecord(rec);
    incrCounter('record_builder.inserted');
    recordSuccess('record_builder', { position_id: rec.position_id });
    return rec;
  } catch (err) {
    recordError('record_builder.insert', err, { position_id: position?.id });
    log('warn', 'record-builder: insert failed', { position_id: position?.id, error: err.message });
    return null;
  }
}

export function startRecordBuilder() {
  const handler = async (event) => {
    if (!event?.position?.id) return;
    const closed = event.position;
    if (closed.status !== 'closed') return;
    if (event.source !== 'pnl_sync' && event.source !== 'live_tx') return;
    await recordClosedPosition(closed);
  };
  onTxEvent(TX_EVENT_TYPES.POSITION_CLOSE, handler);
  log('info', 'record-builder: subscribed to POSITION_CLOSE events');
  return {
    stop() {
      offTxEvent(TX_EVENT_TYPES.POSITION_CLOSE, handler);
      log('info', 'record-builder: stopped');
    },
  };
}

export const _test = {
  _dayOfWeek,
  _hourOfDay,
  _safeNumber,
  buildTrainingRecordFromPosition,
};