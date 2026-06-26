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

async function fetchAgentMeridianTopLPers(poolAddress, limit = 4) {
  const cfg = getConfig();
  if (!cfg.agentMeridian.enabled) return null;
  const url = `${cfg.agentMeridian.url.replace(/\/$/, '')}/top-lp/${poolAddress}`;
  try {
    const body = await fetchJson(
      url,
      { headers: { 'x-api-key': cfg.agentMeridian.apiKey } },
      {},
      `agent-meridian:${poolAddress}`,
    );
    const topLpers = Array.isArray(body?.topLpers) ? body.topLpers.slice(0, limit) : [];
    return topLpers
      .map((p) => ({
        owner: p.owner || p.address,
        winRatePct: Number(p.winRatePct ?? p.win_rate ?? 0),
        roiPct: Number(p.roiPct ?? p.roi ?? 0),
        totalPnlUsd: Number(p.totalPnlUsd ?? p.total_pnl_usd ?? 0),
        totalLp: Number(p.totalLp ?? p.total_lp ?? 0),
      }))
      .filter((p) => isLikelySolanaAddress(p.owner));
  } catch (err) {
    recordError('pool-discovery.agentMeridian', err, { pool: poolAddress });
    log('warn', 'pool-discovery: agentMeridian fetch failed', { pool: poolAddress, error: err.message });
    return null;
  }
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

  let enumeration;
  try {
    enumeration = await listPositionOwnersForPool(poolAddress, { ttlMs: opts.ttlMs });
  } catch (err) {
    recordError('pool-discovery.enumerate', err, { pool: poolAddress });
    log('error', 'pool-discovery: enumerate failed', { pool: poolAddress, error: err.message });
    return { pool: poolAddress, owners: 0, newCandidates: 0, error: err.message };
  }

  const owners = dedupeOwners(enumeration.owners);
  let newCount = 0;
  let seenCount = 0;

  for (const owner of owners) {
    const existing = getWallet(owner);
    if (existing) {
      seenCount += 1;
      upsertWallet({ address: owner, last_active: Math.floor(Date.now() / 1000) });
      continue;
    }
    recordDiscovery(owner, poolAddress);
    newCount += 1;
  }

  let enrichment = null;
  if (opts.useAgentMeridian) {
    enrichment = await fetchAgentMeridianTopLPers(poolAddress, opts.meridianLimit || 4);
  }

  incrCounter('pool_discovery.owners_seen', owners.length);
  incrCounter('pool_discovery.new_candidates', newCount);
  recordSuccess('pool-discovery', {
    pool: poolAddress,
    owners: owners.length,
    newCandidates: newCount,
    enrichment: enrichment ? enrichment.length : 0,
    fromCache: enumeration.fromCache,
  });
  log('info', `pool-discovery: ${poolAddress} → ${owners.length} owners, ${newCount} new`, {
    fromCache: enumeration.fromCache,
    enrichment: enrichment ? enrichment.length : 0,
  });

  return {
    pool: poolAddress,
    owners: owners.length,
    newCandidates: newCount,
    seenCount,
    enrichment,
    fromCache: enumeration.fromCache,
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