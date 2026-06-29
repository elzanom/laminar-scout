import { getTopCandidates } from '../screener/pool-screener.js';
import { listPositionOwnersForPool } from '../collector/pool-lpers.js';
import { fetchJson, withRetry } from '../utils/retry.js';
import { log, logAction } from '../utils/logger.js';
import { recordSuccess, recordError, incrCounter } from '../utils/health.js';
import { getConfig } from '../config/config.js';
import {
  getWallet,
  upsertWallet,
  setWalletStatus,
  markTracked,
} from '../db/wallets.js';

const SOURCE_TAG = 'pool_discovery';
const KNOWN_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function isLikelySolanaAddress(s) {
  return typeof s === 'string' && KNOWN_MINT_RE.test(s);
}

function dedupeOwners(owners) {
  const seen = new Set();
  const out = [];
  for (const o of owners || []) {
    if (!isLikelySolanaAddress(o)) continue;
    if (seen.has(o)) continue;
    seen.add(o);
    out.push(o);
  }
  return out;
}

async function fetchAgentMeridianTopLPers(poolAddress, limit = 10) {
  const cfg = getConfig();
  if (!cfg.agentMeridian.enabled) return null;
  const baseUrl = cfg.agentMeridian.url.replace(/\/$/, '');
  const apiKey = cfg.agentMeridian.apiKey;
  const url = `${baseUrl}/top-lp/${poolAddress}/study?limit=${limit}`;
  try {
    const body = await fetchJson(
      url,
      { headers: { 'X-API-Key': apiKey } },
      {},
      `agent-meridian:${poolAddress}`,
    );
    const topLpers = Array.isArray(body?.topLpers) ? body.topLpers.slice(0, limit) : [];
    return topLpers
      .filter((p) => isLikelySolanaAddress(p.owner || p.address))
      .map((p) => {
        const inflow = Number(p.totalInflowUsd ?? p.totalInflowNative ?? 0);
        const pnl = Number(p.totalPnlUsd ?? p.totalPnlNative ?? 0);
        const fee = Number(p.feePercent ?? p.feePercentNative ?? 0);
        const roi = Number(p.roiPct ?? 0);
        const winRate = Number(p.winRatePct ?? 0);
        const winRateNative = Number(p.winRateNativePct ?? 0);
        const effectiveWinRate = winRate > 0 ? winRate / 100 : (winRateNative > 0 ? winRateNative / 100 : 0);
        return {
          owner: p.owner || p.address,
          winRatePct: winRate,
          roiPct: roi,
          totalPnlUsd: pnl,
          totalFeePercent: fee,
          totalInflowUsd: inflow,
          totalOutflowUsd: Number(p.totalOutflowUsd ?? p.totalOutflowNative ?? 0),
          totalFeeUsd: Number(p.totalFeeUsd ?? p.totalFeeNative ?? 0),
          pnlPerInflowPct: Number(p.pnlPerInflowPct ?? 0),
          avgAgeHours: Number(p.avgAgeHours ?? 0),
          firstActivityTs: p.firstActivity ? Math.floor(new Date(p.firstActivity).getTime() / 1000) : null,
          lastActivityTs: p.lastActivity ? Math.floor(new Date(p.lastActivity).getTime() / 1000) : null,
          // Pre-computed score hint (0-100). Uses same formula as wallet-evaluator but
          // accepts meridian's values directly. Used to skip 14-day backfill when
          // meridian already provides complete data.
          precomputedScore: computeScoreFromMeridianStats({
            winRate: effectiveWinRate,
            totalPnlUsd: pnl,
            totalInflowUsd: inflow,
            feePercent: fee,
          }),
          source: 'agent_meridian',
        };
      });
  } catch (err) {
    recordError('pool-discovery.agentMeridian', err, { pool: poolAddress });
    log('warn', 'pool-discovery: agentMeridian fetch failed', { pool: poolAddress, error: err.message });
    return null;
  }
}

function computeScoreFromMeridianStats({ winRate, totalPnlUsd, totalInflowUsd, feePercent }) {
  // Simplified version of wallet-evaluator's scoring formula.
  // feePercent from meridian is a percentage (e.g. 17.63 means 17.63% yield).
  // Convert to decimal fraction for the formula.
  const feeYieldFrac = (feePercent || 0) / 100;
  const wrScore = Math.min(40, Math.max(0, winRate * 40));
  const feeScore = Math.min(20, Math.max(0, (feeYieldFrac / 0.03) * 20));
  const pnlScore = totalPnlUsd > 0 ? 20 : 0;
  const pnlRatio = totalInflowUsd > 0 ? Math.min(1, Math.max(0, totalPnlUsd / totalInflowUsd)) : 0;
  const consistencyScore = Math.round(pnlRatio * 20);
  const score = wrScore + feeScore + consistencyScore + pnlScore;
  return Math.round(Math.min(100, Math.max(0, score)));
}

function applyMeridianStatsToWallet(lper) {
  if (!lper || !lper.owner) return null;
  const now = Math.floor(Date.now() / 1000);
  const lastActive = lper.lastActivityTs || now;
  const wr = lper.winRatePct > 0 ? lper.winRatePct / 100 : 0;
  const totalPnl = Number(lper.totalPnlUsd || 0);
  const inflow = Number(lper.totalInflowUsd || 0);
  const feeYield = (Number(lper.totalFeePercent || 0)) / 100;
  const winRateEff = wr > 0 ? wr : 0.5;
  const score = lper.precomputedScore ?? computeScoreFromMeridianStats({
    winRate: winRateEff, totalPnlUsd: totalPnl, totalInflowUsd: inflow, feePercent: lper.totalFeePercent || 0,
  });
  let status = 'candidate';
  if (score >= 40 && winRateEff >= 0.55 && feeYield >= 0.02 && (lper.totalLp || 0) >= 1) {
    status = 'top';
  } else if (score > 0 && (lper.totalLp || 0) >= 1) {
    status = 'tracked';
  } else if (totalPnl < 0 && inflow > 0) {
    status = 'rejected';
  }
  const existing = getWallet(lper.owner);
  const merged = {
    address: lper.owner,
    score,
    win_rate: winRateEff,
    win_count: 0,
    loss_count: 0,
    total_pnl_usd: totalPnl,
    total_fees_usd: Number(lper.totalFeeUsd || 0),
    avg_fee_yield: feeYield,
    unique_pools_traded: existing?.unique_pools_traded || 1,
    last_active: lastActive,
    last_evaluated: now,
    source: existing?.source || 'pool_discovery',
    ...(existing?.status === 'top' ? { status: 'top' } : { status }),
    ...(existing?.status === 'tracked' && status === 'top' ? {} : {}),
  };
  if (!existing) {
    merged.first_seen = now;
  }
  return upsertWallet(merged);
}

export function recordDiscovery(walletAddress, sourceDetail) {
  return upsertWallet({
    address: walletAddress,
    source: SOURCE_TAG,
    discovered_from: sourceDetail || null,
    status: 'candidate',
    last_active: Math.floor(Date.now() / 1000),
  });
}

export async function discoverFromPool(poolAddress, opts = {}) {
  if (!poolAddress || !isLikelySolanaAddress(poolAddress)) {
    return { pool: poolAddress, owners: 0, newCandidates: 0, skipped: 'invalid_pool' };
  }

  const cfg = getConfig();
  const useMeridian = opts.useAgentMeridian ?? cfg.agentMeridian.enabled;

  // PRIMARY: agent meridian API — single call, rich stats (winRate, ROI, PnL, fees, activity timestamps).
  // FALLBACK: listPositionOwnersForPool via Helius — slow (100+ TX per pool) but no third-party dependency.
  let lpers = null;
  let enumeration = null;
  let meridianUsed = false;
  let heliusUsed = false;

  if (useMeridian) {
    lpers = await fetchAgentMeridianTopLPers(poolAddress, opts.meridianLimit || 10);
    if (Array.isArray(lpers) && lpers.length > 0) {
      meridianUsed = true;
    }
  }

  if (!meridianUsed) {
    try {
      enumeration = await listPositionOwnersForPool(poolAddress, { ttlMs: opts.ttlMs });
      heliusUsed = true;
    } catch (err) {
      recordError('pool-discovery.enumerate', err, { pool: poolAddress });
      log('error', 'pool-discovery: enumerate failed', { pool: poolAddress, error: err.message });
      return { pool: poolAddress, owners: 0, newCandidates: 0, error: err.message };
    }
  }

  let owners;
  if (meridianUsed) {
    owners = dedupeOwners(lpers.map((l) => l.owner));
  } else {
    owners = dedupeOwners(enumeration.owners);
  }

  let newCount = 0;
  let seenCount = 0;
  let scoredFromMeridian = 0;

  for (const owner of owners) {
    const existing = getWallet(owner);
    if (existing) {
      seenCount += 1;
      upsertWallet({ address: owner, last_active: Math.floor(Date.now() / 1000) });
      continue;
    }
    if (meridianUsed) {
      const lper = lpers.find((l) => l.owner === owner);
      if (lper) {
        applyMeridianStatsToWallet(lper);
        scoredFromMeridian += 1;
      } else {
        recordDiscovery(owner, poolAddress);
      }
    } else {
      recordDiscovery(owner, poolAddress);
    }
    newCount += 1;
  }

  incrCounter('pool_discovery.owners_seen', owners.length);
  incrCounter('pool_discovery.new_candidates', newCount);
  if (meridianUsed) {
    incrCounter('pool_discovery.meridian_scored', scoredFromMeridian);
  } else if (heliusUsed) {
    incrCounter('pool_discovery.helius_fallback', owners.length);
  }
  recordSuccess('pool-discovery', {
    pool: poolAddress,
    owners: owners.length,
    newCandidates: newCount,
    source: meridianUsed ? 'agent_meridian' : 'helius',
    scoredFromMeridian,
    fromCache: enumeration?.fromCache || false,
  });
  log('info', `pool-discovery: ${poolAddress} → ${owners.length} owners, ${newCount} new`, {
    source: meridianUsed ? 'agent_meridian' : 'helius',
    scoredFromMeridian,
    fromCache: enumeration?.fromCache || false,
  });

  return {
    pool: poolAddress,
    owners: owners.length,
    newCandidates: newCount,
    seenCount,
    source: meridianUsed ? 'agent_meridian' : 'helius',
    scoredFromMeridian,
    fromCache: enumeration?.fromCache || false,
  };
}

export async function discoverFromTopPools(opts = {}) {
  const cfg = getConfig();
  const limit = opts.limit || cfg.discovery.maxWalletCandidatesPerCycle || 10;
  const timeframe = opts.timeframe || cfg.poolScreening.timeframe || '4h';
  const useAgentMeridian = opts.useAgentMeridian ?? cfg.agentMeridian.enabled;

  let top;
  try {
    top = await getTopCandidates({ limit, timeframe });
  } catch (err) {
    recordError('pool-discovery.topCandidates', err);
    throw err;
  }

  const perPoolResults = [];
  let totalNew = 0;
  let totalOwners = 0;
  for (const candidate of top.candidates || []) {
    const poolAddress = candidate.pool;
    if (!poolAddress) continue;
    try {
      const r = await discoverFromPool(poolAddress, { useAgentMeridian, ttlMs: opts.ttlMs });
      perPoolResults.push(r);
      totalNew += r.newCandidates || 0;
      totalOwners += r.owners || 0;
    } catch (err) {
      recordError('pool-discovery.perPool', err, { pool: poolAddress });
      log('error', 'pool-discovery: per-pool failed', { pool: poolAddress, error: err.message });
      perPoolResults.push({ pool: poolAddress, error: err.message });
    }
  }

  incrCounter('pool_discovery.cycle.pools', perPoolResults.length);
  incrCounter('pool_discovery.cycle.new_candidates', totalNew);
  recordSuccess('pool-discovery.cycle', {
    pools: perPoolResults.length,
    owners: totalOwners,
    newCandidates: totalNew,
    timeframe,
  });
  logAction('pool-discovery.cycle', {
    pools: perPoolResults.length,
    owners: totalOwners,
    newCandidates: totalNew,
    timeframe,
  });

  return {
    poolsScanned: perPoolResults.length,
    totalOwners,
    totalNewCandidates: totalNew,
    perPool: perPoolResults,
  };
}

export const _test = { isLikelySolanaAddress, dedupeOwners, recordDiscovery };