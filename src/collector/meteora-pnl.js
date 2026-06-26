import { fetchJson } from '../utils/retry.js';
import { log } from '../utils/logger.js';
import { recordSuccess, recordError, incrCounter } from '../utils/health.js';

const METEORA_DLMM_API = 'https://dlmm.datapi.meteora.ag';

function buildPnlUrl(poolAddress, walletAddress, opts = {}) {
  const q = new URLSearchParams();
  q.set('user', walletAddress);
  q.set('status', opts.status || 'closed');
  q.set('pageSize', String(opts.pageSize || 100));
  q.set('page', String(opts.page || 1));
  return `${METEORA_DLMM_API}/positions/${poolAddress}/pnl?${q.toString()}`;
}

function normalizePnlPosition(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    positionAddress: raw.positionAddress || raw.position_address || raw.address || null,
    pnlUsd: Number(raw.pnlUsd ?? raw.pnl_usd ?? 0) || 0,
    pnlSol: Number(raw.pnlSol ?? raw.pnl_sol ?? 0) || 0,
    pnlPctChange: Number(raw.pnlPctChange ?? raw.pnl_pct_change ?? raw.pnlPct ?? 0) || 0,
    totalDepositsUsd: Number(raw.allTimeDeposits?.total?.usd ?? raw.total_deposits_usd ?? 0) || 0,
    totalWithdrawalsUsd: Number(raw.allTimeWithdrawals?.total?.usd ?? raw.total_withdrawals_usd ?? 0) || 0,
    totalFeesUsd: Number(raw.allTimeFees?.total?.usd ?? raw.total_fees_usd ?? 0) || 0,
    feePerTvl24h: Number(raw.feePerTvl24h ?? raw.fee_per_tvl_24h ?? 0) || 0,
    lowerBinId: raw.lowerBinId ?? raw.lower_bin_id ?? null,
    upperBinId: raw.upperBinId ?? raw.upper_bin_id ?? null,
    poolActiveBinId: raw.poolActiveBinId ?? raw.pool_active_bin_id ?? null,
    isOutOfRange: raw.isOutOfRange ?? raw.is_out_of_range ?? null,
    createdAt: raw.createdAt ?? raw.created_at ?? null,
    tokenX: raw.tokenX ?? raw.token_x ?? null,
    tokenY: raw.tokenY ?? raw.token_y ?? null,
    raw,
  };
}

function extractPositionsArray(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  if (Array.isArray(body.data)) return body.data;
  if (Array.isArray(body.positions)) return body.positions;
  if (body.byPosition && typeof body.byPosition === 'object') return Object.values(body.byPosition);
  return [];
}

export async function fetchDlmmPnlForPool(poolAddress, walletAddress, opts = {}) {
  if (!poolAddress) throw new Error('poolAddress required');
  if (!walletAddress) throw new Error('walletAddress required');
  const status = opts.status || 'closed';
  const pageSize = opts.pageSize || 100;
  const maxPages = opts.maxPages || 5;
  const aggregate = new Map();

  for (let page = 1; page <= maxPages; page += 1) {
    let body;
    try {
      body = await fetchJson(
        buildPnlUrl(poolAddress, walletAddress, { status, pageSize, page }),
        {},
        {},
        `meteora-pnl:${poolAddress}`,
      );
    } catch (err) {
      recordError('meteora-pnl', err, { pool: poolAddress, wallet: walletAddress, page });
      throw err;
    }

    const rows = extractPositionsArray(body).map(normalizePnlPosition).filter(Boolean);
    for (const r of rows) {
      if (r.positionAddress && !aggregate.has(r.positionAddress)) {
        aggregate.set(r.positionAddress, r);
      } else if (!r.positionAddress) {
        aggregate.set(`anon-${aggregate.size}`, r);
      }
    }

    if (rows.length < pageSize) break;
    if (typeof body?.total === 'number' && page * pageSize >= body.total) break;
  }

  const positions = [...aggregate.values()];
  incrCounter(`meteora_pnl.positions_${status}`, positions.length);
  recordSuccess('meteora-pnl', { pool: poolAddress, wallet: walletAddress, status, positions: positions.length });
  return { positions, count: positions.length };
}

export async function fetchWalletClosedPositions(walletAddress, poolAddresses, opts = {}) {
  if (!walletAddress) throw new Error('walletAddress required');
  const pools = (Array.isArray(poolAddresses) ? poolAddresses : []).filter(Boolean);
  if (!pools.length) return { positions: [], perPool: {} };

  const all = [];
  const perPool = {};
  for (const pool of pools) {
    try {
      const { positions } = await fetchDlmmPnlForPool(pool, walletAddress, { status: 'closed', pageSize: 100 });
      perPool[pool] = positions.length;
      for (const p of positions) {
        all.push({ ...p, poolAddress: pool });
      }
    } catch (err) {
      recordError('meteora-pnl.perPool', err, { pool, wallet: walletAddress });
      perPool[pool] = 0;
      log('warn', 'meteora-pnl: per-pool fetch failed', { pool, wallet: walletAddress, error: err.message });
    }
  }

  return { positions: all, count: all.length, perPool };
}

export async function fetchWalletOpenPositions(walletAddress, poolAddresses, opts = {}) {
  if (!walletAddress) throw new Error('walletAddress required');
  const pools = (Array.isArray(poolAddresses) ? poolAddresses : []).filter(Boolean);
  if (!pools.length) return { positions: [], perPool: {} };

  const all = [];
  const perPool = {};
  for (const pool of pools) {
    try {
      const { positions } = await fetchDlmmPnlForPool(pool, walletAddress, { status: 'open', pageSize: 100 });
      perPool[pool] = positions.length;
      for (const p of positions) all.push({ ...p, poolAddress: pool });
    } catch (err) {
      recordError('meteora-pnl.open', err, { pool, wallet: walletAddress });
      perPool[pool] = 0;
    }
  }
  return { positions: all, count: all.length, perPool };
}

export const _test = { normalizePnlPosition, extractPositionsArray, buildPnlUrl };