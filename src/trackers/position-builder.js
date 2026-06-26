import * as positionsDb from '../db/positions.js';
import * as marketSnapshots from '../db/market-snapshots.js';
import {
  fetchDlmmPnlForPool,
  fetchWalletClosedPositions,
  fetchWalletOpenPositions,
} from '../collector/meteora-pnl.js';
import { onTxEvent, offTxEvent, emitTxEvent, TX_EVENT_TYPES } from '../collector/event-bus.js';
import { log } from '../utils/logger.js';
import { recordSuccess, recordError, incrCounter } from '../utils/health.js';
import {
  isAddLiquidity,
  isRemoveLiquidity,
  isClaimFee,
} from '../constants.js';

const _isValidAddress = (a) => typeof a === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);

function _ts(s) {
  if (!s) return null;
  if (typeof s === 'number') return s > 1e12 ? Math.floor(s / 1000) : Math.floor(s);
  if (typeof s === 'string') {
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  }
  return null;
}

function _durationHours(entryTs, exitTs) {
  if (!entryTs || !exitTs) return null;
  return (exitTs - entryTs) / 3600;
}

function _positionTokenPair(raw, poolAddress) {
  const x = raw?.tokenX?.symbol || raw?.tokenX?.mint;
  const y = raw?.tokenY?.symbol || raw?.tokenY?.mint;
  if (x && y) return `${x}/${y}`;
  if (raw?.tokenX && raw?.tokenY) return `${raw.tokenX}/${raw.tokenY}`;
  return poolAddress ? `pool:${poolAddress.slice(0, 6)}` : null;
}

export async function syncPositionFromPnl({ wallet, poolAddress, pnlPosition, entryEvent }) {
  if (!_isValidAddress(wallet) || !_isValidAddress(poolAddress) || !pnlPosition) return null;

  const id = pnlPosition.positionAddress;
  if (!id || !_isValidAddress(id)) return null;

  const existing = positionsDb.getPosition(id);
  const ts = _ts(pnlPosition.createdAt) || entryEvent?.timestamp || Math.floor(Date.now() / 1000);

  if (existing && existing.status === 'closed') return existing;

  const tokenPair = _positionTokenPair(pnlPosition, poolAddress);
  const lowerBin = pnlPosition.lowerBinId != null ? Number(pnlPosition.lowerBinId) : null;
  const upperBin = pnlPosition.upperBinId != null ? Number(pnlPosition.upperBinId) : null;
  const poolActiveBin = pnlPosition.poolActiveBinId != null ? Number(pnlPosition.poolActiveBinId) : null;
  const binRangeWidth = (lowerBin != null && upperBin != null) ? Math.max(0, upperBin - lowerBin + 1) : null;

  if (!existing) {
    const inserted = positionsDb.insertPosition({
      id,
      wallet_address: wallet,
      pool_address: poolAddress,
      token_pair: tokenPair,
      entry_timestamp: ts,
      bin_step: null,
      bin_lower: lowerBin,
      bin_upper: upperBin,
      bin_range_width: binRangeWidth,
      pool_active_bin_id: poolActiveBin,
      is_out_of_range: pnlPosition.isOutOfRange ? 1 : 0,
      fee_per_tvl_24h: pnlPosition.feePerTvl24h ?? null,
      capital_usd: pnlPosition.totalDepositsUsd || null,
      entry_tx: entryEvent?.signature || null,
      position_mint: id,
      status: 'open',
    });
    incrCounter('position_builder.opened');
    emitTxEvent(TX_EVENT_TYPES.POSITION_OPEN, {
      wallet,
      pool: poolAddress,
      position_mint: id,
      position: inserted,
      source: 'pnl_sync',
    });
    return inserted;
  }

  if (existing.status === 'open' && (pnlPosition.totalWithdrawalsUsd > 0 || pnlPosition.totalFeesUsd > 0)) {
    return existing;
  }
  return existing;
}

export function closePositionFromPnl(pnlPosition, exitTs) {
  const id = pnlPosition.positionAddress;
  if (!id) return null;
  const existing = positionsDb.getPosition(id);
  if (!existing) return null;
  if (existing.status === 'closed') return existing;

  const entryTs = existing.entry_timestamp || _ts(pnlPosition.createdAt);
  const exitTimestamp = exitTs || Math.floor(Date.now() / 1000);
  const durationHours = _durationHours(entryTs, exitTimestamp);

  const totalFees = Number(pnlPosition.totalFeesUsd || 0);
  const pnlUsd = Number(pnlPosition.pnlUsd || 0);
  const pnlSol = Number(pnlPosition.pnlSol || 0);
  const pnlSolPct = Number(pnlPosition.pnlSolPctChange || 0);
  const deposits = Number(pnlPosition.totalDepositsUsd || 0);
  const feeYield = deposits > 0 ? totalFees / deposits : 0;
  const pnlPct = deposits > 0 ? (pnlUsd / deposits) * 100 : Number(pnlPosition.pnlPctChange || 0);
  const poolActiveBin = pnlPosition.poolActiveBinId != null ? Number(pnlPosition.poolActiveBinId) : null;

  const closed = positionsDb.closePosition(id, {
    exit_timestamp: exitTimestamp,
    fees_earned_usd: totalFees,
    pnl_usd: pnlUsd,
    pnl_sol: pnlSol,
    pnl_sol_pct: pnlSolPct,
    pnl_pct: pnlPct,
    fee_yield: feeYield,
    fee_per_tvl_24h: pnlPosition.feePerTvl24h ?? null,
    pool_active_bin_id: poolActiveBin,
    is_out_of_range: pnlPosition.isOutOfRange ? 1 : 0,
    duration_hours: durationHours,
    is_profitable: pnlUsd > 0 ? 1 : 0,
    close_reason: 'pnl_close',
  });

  incrCounter('position_builder.closed');
  emitTxEvent(TX_EVENT_TYPES.POSITION_CLOSE, {
    wallet: closed.wallet_address,
    pool: closed.pool_address,
    position_mint: id,
    position: closed,
    pnl: { pnl_usd: pnlUsd, fees_usd: totalFees, pnl_pct: pnlPct },
    source: 'pnl_sync',
  });
  return closed;
}

export async function syncWalletPositionsFromPnl(wallet, poolAddresses, opts = {}) {
  if (!_isValidAddress(wallet)) return { opened: 0, closed: 0, skipped: 0 };

  const opened = [];
  const closed = [];

  try {
    const closedRes = await fetchWalletClosedPositions(wallet, poolAddresses);
    for (const p of closedRes.positions) {
      const position = await syncPositionFromPnl({ wallet, poolAddress: p.poolAddress, pnlPosition: p });
      if (position) {
        const wasOpen = position.status === 'open' || position.status !== 'closed';
        const closedPos = closePositionFromPnl(p);
        if (closedPos) {
          closed.push(closedPos);
          if (wasOpen) incrCounter('position_builder.transitions_open_to_closed');
        }
      }
    }
  } catch (err) {
    recordError('position_builder.closed_sync', err, { wallet });
  }

  try {
    const openRes = await fetchWalletOpenPositions(wallet, poolAddresses);
    for (const p of openRes.positions) {
      const position = await syncPositionFromPnl({ wallet, poolAddress: p.poolAddress, pnlPosition: p });
      if (position) opened.push(position);
    }
  } catch (err) {
    recordError('position_builder.open_sync', err, { wallet });
  }

  recordSuccess('position_builder', { wallet, opened: opened.length, closed: closed.length });
  return { opened: opened.length, closed: closed.length };
}

function _handleLiveAddLiquidity(event) {
  if (!event?.position_mint || !event?.pool || !event?.wallet) return null;
  if (!_isValidAddress(event.position_mint) || !_isValidAddress(event.pool)) return null;

  const existing = positionsDb.getPositionByMint(event.position_mint);
  if (existing) return existing;

  const entryTs = event.timestamp || Math.floor(Date.now() / 1000);
  const inserted = positionsDb.insertPosition({
    id: event.position_mint,
    wallet_address: event.wallet,
    pool_address: event.pool,
    token_pair: null,
    entry_timestamp: entryTs,
    entry_tx: event.signature || null,
    position_mint: event.position_mint,
    status: 'open',
  });
  incrCounter('position_builder.live_open');
  emitTxEvent(TX_EVENT_TYPES.POSITION_OPEN, {
    wallet: event.wallet,
    pool: event.pool,
    position_mint: event.position_mint,
    position: inserted,
    source: 'live_tx',
    signature: event.signature,
  });
  return inserted;
}

function _handleLiveRemoveLiquidity(event) {
  if (!event?.position_mint) return null;
  const existing = positionsDb.getPositionByMint(event.position_mint);
  if (!existing) return null;
  if (existing.status === 'closed') return existing;

  const exitTs = event.timestamp || Math.floor(Date.now() / 1000);
  const closed = positionsDb.closePosition(existing.id, {
    exit_timestamp: exitTs,
    exit_tx: event.signature || null,
    close_reason: 'live_close',
  });
  incrCounter('position_builder.live_close');
  emitTxEvent(TX_EVENT_TYPES.POSITION_CLOSE, {
    wallet: closed.wallet_address,
    pool: closed.pool_address,
    position_mint: event.position_mint,
    position: closed,
    source: 'live_tx',
    signature: event.signature,
  });
  return closed;
}

function _handleLiveClaimFee(event) {
  if (!event?.position_mint) return null;
  const existing = positionsDb.getPositionByMint(event.position_mint);
  if (!existing) return null;
  emitTxEvent(TX_EVENT_TYPES.FEE_CLAIM, {
    wallet: event.wallet,
    pool: event.pool,
    position_mint: event.position_mint,
    position: existing,
    source: 'live_tx',
    signature: event.signature,
  });
  incrCounter('position_builder.fee_claim');
  return existing;
}

function _handleDlmmEvent(event) {
  if (!event || !event.instruction) return null;
  if (isAddLiquidity(event.instruction)) return _handleLiveAddLiquidity(event);
  if (isRemoveLiquidity(event.instruction)) return _handleLiveRemoveLiquidity(event);
  if (isClaimFee(event.instruction)) return _handleLiveClaimFee(event);
  return null;
}

export function startPositionBuilder() {
  const handler = (event) => {
    try {
      _handleDlmmEvent(event);
    } catch (err) {
      recordError('position_builder.live', err, { signature: event?.signature });
      log('warn', 'position-builder: live handler failed', { error: err.message, signature: event?.signature });
    }
  };
  onTxEvent(TX_EVENT_TYPES.ANY_DLMM, handler);
  log('info', 'position-builder: subscribed to ANY_DLMM events');
  return {
    stop() {
      offTxEvent(TX_EVENT_TYPES.ANY_DLMM, handler);
      log('info', 'position-builder: stopped');
    },
  };
}

export const _test = {
  _ts,
  _durationHours,
  _positionTokenPair,
  _isValidAddress,
  _handleDlmmEvent,
  _handleLiveAddLiquidity,
  _handleLiveRemoveLiquidity,
  _handleLiveClaimFee,
};