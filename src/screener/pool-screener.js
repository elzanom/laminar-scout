import { fetchMeteoraDiscovery, fetchMeteoraDiscoveryMultiPage, fetchMeteoraPoolMeta, enrichPoolsWithDetails } from './metrics-fetcher.js';
import { fetchJupiterPrices } from './metrics-fetcher.js';
import { scoreCandidate, degenScore, compositeScore } from './pool-scorer.js';
import { getScreeningDefaultsForTimeframe, normalizeTimeframe } from './screening-scales.js';
import { log } from '../utils/logger.js';
import { recordSuccess, recordError, incrCounter } from '../utils/health.js';
import { getConfig } from '../config/config.js';
import { listSignals } from '../db/signals.js';
import { listOpenPositions } from '../db/positions.js';
import { KNOWN_MINTS } from '../constants.js';

export const PVP_CONSTANTS = {
  PVP_SHORTLIST_LIMIT: 2,
  RIVAL_LIMIT: 2,
  MIN_ACTIVE_TVL: 5000,
  MIN_HOLDERS: 500,
  MIN_GLOBAL_FEES_SOL: 30,
};

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asString(v, fallback = null) {
  if (v === null || v === undefined) return fallback;
  return String(v);
}

export function condensePool(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const tx = raw.token_x && typeof raw.token_x === 'object' ? raw.token_x : {};
  const ty = raw.token_y && typeof raw.token_y === 'object' ? raw.token_y : {};
  const dlp = raw.dlmm_params && typeof raw.dlmm_params === 'object' ? raw.dlmm_params : {};
  const pool = asString(raw.pool_address || raw.address || raw.pool || raw.lb_pair);
  const tokenXMint = asString(tx.address || raw.token_x_mint || raw.mint_x || raw.tokenXMint || raw.base_mint);
  const tokenYMint = asString(ty.address || raw.token_y_mint || raw.mint_y || raw.tokenYMint || raw.quote_mint);
  const tokenXSymbol = asString(tx.symbol || raw.token_x_symbol || raw.symbol_x);
  const tokenYSymbol = asString(ty.symbol || raw.token_y_symbol || raw.symbol_y);

  let tokenAgeHours = 0;
  const createdAt = tx.created_at || raw.token_created_at || raw.pool_created_at;
  if (createdAt) {
    const tsMs = createdAt > 1e12 ? createdAt : createdAt * 1000;
    if (Number.isFinite(tsMs) && tsMs > 0) tokenAgeHours = Math.max(0, (Date.now() - tsMs) / 3.6e6);
  }

  return {
    pool,
    name: asString(raw.name || `${tokenXSymbol || ''}-${tokenYSymbol || ''}`.replace(/^-+|-+$/g, '')) || null,
    base: {
      symbol: tokenXSymbol,
      mint: tokenXMint,
      organic: num(tx.organic_score ?? raw.token_x_organic_score),
      warnings: Array.isArray(tx.warnings) ? tx.warnings : (Array.isArray(raw.token_x_warnings) ? raw.token_x_warnings : []),
    },
    quote: {
      symbol: tokenYSymbol,
      mint: tokenYMint,
    },
    bin_step: num(dlp.bin_step ?? raw.bin_step ?? raw.binStep),
    fee_pct: num(raw.fee_pct ?? raw.base_fee_pct),
    tvl: num(raw.tvl),
    active_tvl: num(raw.active_tvl ?? raw.active_tvl_usd ?? raw.tvl_active),
    fee_window: num(raw.fee ?? raw.fees ?? raw.fee_window),
    volume_window: num(raw.volume ?? raw.volume_window),
    fee_active_tvl_ratio: num(raw.fee_active_tvl_ratio ?? raw.fees_per_tvl),
    volatility: num(raw.volatility),
    holders: num(raw.base_token_holders ?? tx.holders ?? raw.holders),
    mcap: num(tx.market_cap ?? tx.fdv ?? raw.mcap),
    organic_score: num(tx.organic_score ?? raw.organic_score ?? raw.token_x_organic_score),
    token_age_hours: tokenAgeHours || num(raw.token_age_hours ?? raw.age_hours),
    dev: tx.dev != null ? String(tx.dev) : (raw.dev || null),
    launchpad: asString(raw.launchpad),
    active_positions: num(raw.active_positions ?? raw.open_positions),
    price: num(tx.price ?? raw.price ?? raw.pool_price),
    price_change_pct: num(raw.price_change_24h ?? raw.price_change_pct),
    volume_active_tvl_ratio: num(raw.volume_active_tvl_ratio),
    unique_lps: num(raw.unique_lps),
    positions_created: num(raw.positions_created),
    gmgn_score: Number.isFinite(raw.gmgn_score) ? Number(raw.gmgn_score) : null,
    category: asString(raw.category),
    timeframe: asString(raw.timeframe),
    raw,
  };
}

function buildFilterBy(screening, excludeLaunchpads = [], includeLaunchpads = []) {
  const parts = [];
  if (Number.isFinite(screening.minTvl)) parts.push(`tvl>=${screening.minTvl}`);
  if (Number.isFinite(screening.maxTvl)) parts.push(`tvl<=${screening.maxTvl}`);
  if (Number.isFinite(screening.minFeeActiveTvlRatio)) parts.push(`fees_per_tvl>=${screening.minFeeActiveTvlRatio}`);
  if (Number.isFinite(screening.minOrganic)) parts.push(`organic_score>=${screening.minOrganic}`);
  if (Number.isFinite(screening.minVolume)) parts.push(`volume>=${screening.minVolume}`);
  if (Number.isFinite(screening.minBinStep)) parts.push(`bin_step>=${screening.minBinStep}`);
  if (Number.isFinite(screening.maxBinStep)) parts.push(`bin_step<=${screening.maxBinStep}`);
  if (Number.isFinite(screening.minHolders)) parts.push(`holders>=${screening.minHolders}`);
  if (Number.isFinite(screening.minMcap)) parts.push(`mcap>=${screening.minMcap}`);
  if (includeLaunchpads?.length) parts.push(`launchpad-in:${includeLaunchpads.join('|')}`);
  if (excludeLaunchpads?.length) parts.push(`launchpad-nin:${excludeLaunchpads.join('|')}`);
  return parts.join(',');
}

export async function discoverPools({ pageSize = 100, pages = 3, timeframe = '4h', includeLaunchpads = [], excludeLaunchpads = [], extraFilterBy = '', enrich = true, concurrency = 10 } = {}) {
  const cfg = getConfig();
  const tf = normalizeTimeframe(timeframe);
  const screening = cfg.poolScreening;
  const merged = {
    ...getScreeningDefaultsForTimeframe(tf),
    ...screening,
    timeframe: tf,
  };
  const filterBy = [buildFilterBy(merged, excludeLaunchpads, includeLaunchpads), extraFilterBy].filter(Boolean).join(',');
  const result = await fetchMeteoraDiscoveryMultiPage({ pageSize, totalPages: pages, filterBy, timeframe: tf });
  const enriched = enrich ? await enrichPoolsWithDetails(result.data, { concurrency }) : result.data;
  return { ...result, data: enriched, timeframe: tf, filterBy, condensed: enriched.map(condensePool).filter(Boolean) };
}

export function getRawPoolScreeningRejectReason(pool, screening) {
  if (!pool) return 'invalid_pool';
  const s = screening || {};
  const activeTvl = num(pool.active_tvl ?? pool.tvl);
  if (activeTvl < PVP_CONSTANTS.MIN_ACTIVE_TVL) return `active_tvl<${PVP_CONSTANTS.MIN_ACTIVE_TVL}`;
  if (num(pool.holders) < PVP_CONSTANTS.MIN_HOLDERS) return `holders<${PVP_CONSTANTS.MIN_HOLDERS}`;
  const uniqueLps = num(pool.unique_lps);
  if (uniqueLps > 0 && uniqueLps < 5) return 'unique_lps<5';

  if (s.onlySolPairs) {
    const baseMint = pool.base?.mint || pool.base_mint || pool.tokenXMint;
    const quoteMint = pool.quote?.mint || pool.quote_mint || pool.tokenYMint;
    if (baseMint !== KNOWN_MINTS.WSOL && quoteMint !== KNOWN_MINTS.WSOL) {
      return 'not_sol_pair';
    }
  }

  if (Number.isFinite(s.minTvl) && activeTvl < s.minTvl) return `tvl<${s.minTvl}`;
  if (Number.isFinite(s.maxTvl) && activeTvl > s.maxTvl) return `tvl>${s.maxTvl}`;
  if (Number.isFinite(s.minFeeActiveTvlRatio) && num(pool.fee_active_tvl_ratio) < s.minFeeActiveTvlRatio) return `fee_active_tvl_ratio<${s.minFeeActiveTvlRatio}`;
  if (Number.isFinite(s.minVolume) && num(pool.volume_window) < s.minVolume) return `volume<${s.minVolume}`;
  if (Number.isFinite(s.minOrganic) && num(pool.organic_score) < s.minOrganic) return `organic_score<${s.minOrganic}`;
  if (Number.isFinite(s.minBinStep) && num(pool.bin_step) < s.minBinStep) return `bin_step<${s.minBinStep}`;
  if (Number.isFinite(s.maxBinStep) && num(pool.bin_step) > s.maxBinStep) return `bin_step>${s.maxBinStep}`;
  if (Number.isFinite(s.minTokenFeesSol) && num(pool.fee_window) < s.minTokenFeesSol) return `fee_window<${s.minTokenFeesSol}`;
  return null;
}

export function screenPool(pool, screening) {
  return getRawPoolScreeningRejectReason(pool, screening) === null;
}

function poolMintKey(pool) {
  return pool?.base?.mint || pool?.pool;
}

async function enrichWithPrices(pools) {
  const mints = new Set();
  for (const p of pools) {
    if (p?.base?.mint) mints.add(p.base.mint);
    if (p?.quote?.mint) mints.add(p.quote.mint);
  }
  if (!mints.size) return pools;
  const prices = await fetchJupiterPrices([...mints]);
  for (const p of pools) {
    if (p?.base?.mint && prices[p.base.mint] != null) p.base.usdPrice = prices[p.base.mint];
    if (p?.quote?.mint && prices[p.quote.mint] != null) p.quote.usdPrice = prices[p.quote.mint];
  }
  return pools;
}

function pairKey(pool) {
  if (!pool) return null;
  const mints = [];
  if (pool.base?.mint) mints.push(pool.base.mint);
  if (pool.quote?.mint) mints.push(pool.quote.mint);
  if (!mints.length) return null;
  return mints.sort().join('|');
}

function getRecentSignalPools(withinSeconds = 60 * 60) {
  const since = Math.floor(Date.now() / 1000) - withinSeconds;
  const sigs = listSignals({ since }, { limit: 500 });
  return new Set(sigs.map((s) => s.pool_address).filter(Boolean));
}

function getOccupiedPools() {
  const open = listOpenPositions();
  return new Set(open.map((p) => p.pool_address).filter(Boolean));
}

export function pvpGuard(candidates, opts = {}) {
  const limit = opts.limit || PVP_CONSTANTS.PVP_SHORTLIST_LIMIT;
  const byPair = new Map();
  const final = [];
  for (const c of candidates) {
    const key = pairKey(c);
    if (!key) continue;
    const bucket = byPair.get(key) || 0;
    if (bucket >= limit) continue;
    byPair.set(key, bucket + 1);
    final.push(c);
  }
  return final;
}

export async function getTopCandidates({ limit = 10, timeframe = '4h', screening = null, excludeOccupied = true, signalCooldownSec = 60 * 60, includeLaunchpads = [], excludeLaunchpads = [], pageSize = 50 } = {}) {
  const cfg = getConfig();
  const tf = normalizeTimeframe(timeframe);
  const mergedScreening = screening || {
    ...getScreeningDefaultsForTimeframe(tf),
    ...cfg.poolScreening,
    timeframe: tf,
  };

  let pools;
  try {
    pools = await discoverPools({ pageSize, timeframe: tf, includeLaunchpads, excludeLaunchpads });
  } catch (err) {
    recordError('pool-screener.discover', err);
    throw err;
  }
  let condensed = pools.condensed;

  const recentSignalPools = getRecentSignalPools(signalCooldownSec);
  const occupiedPools = excludeOccupied ? getOccupiedPools() : new Set();
  const beforeFilter = condensed.length;
  condensed = condensed.filter((p) => {
    if (!p.pool) return false;
    if (recentSignalPools.has(p.pool)) return false;
    if (occupiedPools.has(p.pool)) return false;
    const reason = getRawPoolScreeningRejectReason(p, mergedScreening);
    return reason === null;
  });

  condensed = await enrichWithPrices(condensed);

  const sortMode = (mergedScreening.category || 'trending').toLowerCase();
  if (sortMode === 'new') {
    const ageOf = (p) => num(p.token_age_hours);
    condensed.sort((a, b) => ageOf(a) - ageOf(b));
  } else if (sortMode === 'all') {
    // keep Meteora's default order, no local re-sort
  } else {
    condensed.sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
  }
  log('info', `pool-screener: ranking by category=${sortMode}`);

  condensed = pvpGuard(condensed);

  const scored = condensed.map((p) => {
    const { score, degen, combined } = compositeScore(p);
    return { ...p, score, degen, combined };
  });

  const final = scored.slice(0, limit);

  incrCounter('pool_screener.discovered', pools.condensed.length);
  incrCounter('pool_screener.passed_filter', beforeFilter - condensed.length);
  incrCounter('pool_screener.returned', final.length);
  recordSuccess('pool-screener', { discovered: pools.condensed.length, returned: final.length, timeframe: tf });

  log('info', `pool-screener: getTopCandidates returned ${final.length} from ${pools.condensed.length} (timeframe=${tf})`);

  return {
    candidates: final,
    total_screened: pools.condensed.length,
    source: 'meteora',
    filtered_examples: [],
    timeframe: tf,
    filterBy: pools.filterBy,
  };
}

export async function screenPoolDeep(poolAddress, timeframe = '4h') {
  const meta = await fetchMeteoraPoolMeta(poolAddress);
  const condensed = condensePool({ ...(meta || {}), address: poolAddress });
  if (!condensed) return { passed: false, reason: 'no_meta', pool: null };
  const cfg = getConfig();
  const tf = normalizeTimeframe(timeframe);
  const screening = { ...getScreeningDefaultsForTimeframe(tf), ...cfg.poolScreening, timeframe: tf };
  const reason = getRawPoolScreeningRejectReason(condensed, screening);
  if (reason) return { passed: false, reason, pool: condensed };
  const scored = compositeScore(condensed);
  return { passed: true, reason: null, pool: { ...condensed, ...scored } };
}

export function clearPvpGuard() {}