import { fetchJson } from '../utils/retry.js';
import { log } from '../utils/logger.js';
import { recordSuccess, recordError, incrCounter } from '../utils/health.js';
import { KNOWN_MINTS } from '../constants.js';

const METEORA_POOL_DISCOVERY = 'https://dlmm.datapi.meteora.ag/pools';
const METEORA_DLMM_POOLS = 'https://dlmm.datapi.meteora.ag/pools';
const JUPITER_ASSETS = 'https://datapi.jup.ag/v1/assets/search';

const DEFAULT_TTL_PRICE_MS = 60 * 1000;
const DEFAULT_TTL_POOL_META_MS = 15 * 60 * 1000;
const DEFAULT_TTL_DISCOVERY_MS = 5 * 60 * 1000;

const priceCache = new Map();
const poolMetaCache = new Map();
const discoveryCache = new Map();

function now() { return Date.now(); }

function getCached(map, key, ttlMs) {
  const v = map.get(key);
  if (!v) return null;
  if (now() - v.fetchedAt > ttlMs) {
    map.delete(key);
    return null;
  }
  return v.value;
}

function setCached(map, key, value) {
  map.set(key, { value, fetchedAt: now() });
}

export async function fetchMeteoraDiscovery({ pageSize = 50, filterBy = '', timeframe = '4h', page = 1 } = {}) {
  const cacheKey = JSON.stringify({ pageSize, filterBy, timeframe, page });
  const cached = getCached(discoveryCache, cacheKey, DEFAULT_TTL_DISCOVERY_MS);
  if (cached) return cached;

  const q = new URLSearchParams();
  q.set('page_size', String(Math.min(Math.max(Number(pageSize) || 50, 1), 100)));
  q.set('page', String(Math.max(1, Number(page) || 1)));
  const url = `${METEORA_POOL_DISCOVERY}?${q.toString()}`;

  try {
    const data = await fetchJson(url, {}, {}, 'meteora-discovery');
    const rawData = Array.isArray(data?.data) ? data.data : [];
    const mapped = rawData.map((p) => ({
      ...p,
      pool_address: p.pool_address || p.address,
    }));
    const result = { data: mapped, total: data?.total ?? mapped.length, page: Number(page) };
    setCached(discoveryCache, cacheKey, result);
    incrCounter('metrics.discovery.hit', mapped.length);
    recordSuccess('metrics.discovery', { count: mapped.length, timeframe, page });
    return result;
  } catch (err) {
    recordError('metrics.discovery', err);
    throw err;
  }
}

export async function fetchMeteoraDiscoveryMultiPage({ pageSize = 100, totalPages = 3, filterBy = '', timeframe = '4h' } = {}) {
  const pages = [];
  for (let p = 1; p <= Math.max(1, totalPages); p++) {
    pages.push(fetchMeteoraDiscovery({ pageSize, filterBy, timeframe, page: p }).catch(() => ({ data: [], page: p })));
  }
  const results = await Promise.all(pages);
  const merged = results.flatMap((r) => r.data || []);
  const seen = new Set();
  const dedup = [];
  for (const p of merged) {
    const addr = p.pool_address || p.address;
    if (!addr || seen.has(addr)) continue;
    seen.add(addr);
    dedup.push(p);
  }
  return { data: dedup, total: dedup.length, pages: totalPages };
}

export async function fetchMeteoraPoolDetail(poolAddress) {
  if (!poolAddress) return null;
  const cached = getCached(poolMetaCache, `detail:${poolAddress}`, DEFAULT_TTL_POOL_META_MS);
  if (cached) return cached;
  const url = `${METEORA_DLMM_POOLS}/${poolAddress}`;
  try {
    const raw = await fetchJson(url, {}, {}, `meteora-pool-detail:${poolAddress}`);
    const normalized = normalizePoolDetail(raw);
    setCached(poolMetaCache, `detail:${poolAddress}`, normalized);
    recordSuccess('metrics.pool-detail', { pool: poolAddress });
    return normalized;
  } catch (err) {
    recordError('metrics.pool-detail', err, { pool: poolAddress });
    return null;
  }
}

function normalizePoolDetail(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const cfg = raw.pool_config || {};
  const v = raw.volume || {};
  const f = raw.fees || {};
  const ftr = raw.fee_tvl_ratio || {};
  return {
    ...raw,
    pool_address: raw.pool_address || raw.address,
    address: raw.address || raw.pool_address,
    tvl: Number(raw.tvl ?? 0),
    active_tvl: Number(raw.tvl ?? 0),
    fee: Number(f['4h'] ?? f['1h'] ?? f['24h'] ?? 0),
    fees: Number(f['4h'] ?? f['1h'] ?? f['24h'] ?? 0),
    volume: Number(v['4h'] ?? v['1h'] ?? v['24h'] ?? 0),
    fee_active_tvl_ratio: Number(ftr['4h'] ?? ftr['1h'] ?? ftr['24h'] ?? 0),
    fee_tvl_ratio: Number(ftr['4h'] ?? ftr['1h'] ?? ftr['24h'] ?? 0),
    bin_step: Number(cfg.bin_step ?? 0),
    fee_pct: Number(cfg.base_fee_pct ?? 0),
    base_fee_pct: Number(cfg.base_fee_pct ?? 0),
    apr: Number(raw.apr ?? 0),
    apy: Number(raw.apy ?? 0),
    pool_created_at: Number(raw.created_at ?? 0),
    created_at: Number(raw.created_at ?? 0),
    launchpad: raw.launchpad || '',
    is_blacklisted: !!raw.is_blacklisted,
    dlmm_params: cfg.bin_step != null ? { bin_step: cfg.bin_step } : undefined,
  };
}

export async function enrichPoolsWithDetails(pools, { concurrency = 10 } = {}) {
  if (!Array.isArray(pools) || !pools.length) return pools;
  const out = new Array(pools.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= pools.length) return;
      const p = pools[idx];
      const addr = p?.pool_address || p?.address;
      if (!addr) { out[idx] = p; continue; }
      const detail = await fetchMeteoraPoolDetail(addr);
      out[idx] = detail ? { ...p, ...detail, _enriched: true } : { ...p, _enriched: false };
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, pools.length) }, () => worker());
  await Promise.all(workers);
  return out;
}

export async function fetchMeteoraPoolMeta(poolAddress) {
  return fetchMeteoraPoolDetail(poolAddress);
}

export async function fetchJupiterPrices(mints, opts = {}) {
  if (!Array.isArray(mints) || !mints.length) return {};
  const ttl = opts.ttlMs ?? DEFAULT_TTL_PRICE_MS;
  const out = {};
  const missing = [];
  for (const mint of mints) {
    if (!mint) continue;
    const cached = getCached(priceCache, mint, ttl);
    if (cached != null) out[mint] = cached;
    else missing.push(mint);
  }
  if (!missing.length) return out;
  try {
    const url = `${JUPITER_ASSETS}?query=${encodeURIComponent(missing.join(','))}`;
    const data = await fetchJson(url, {}, {}, 'jupiter-prices');
    const arr = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
    for (const item of arr) {
      if (!item || !item.id) continue;
      const price = Number(item.usdPrice ?? item.price ?? item.priceUsd);
      if (Number.isFinite(price)) {
        out[item.id] = price;
        setCached(priceCache, item.id, price);
      }
    }
    incrCounter('metrics.jupiter.prices_fetched', missing.length);
    recordSuccess('metrics.jupiter', { fetched: missing.length, hits: Object.keys(out).length });
  } catch (err) {
    recordError('metrics.jupiter', err, { mints: missing.length });
    log('warn', 'metrics-fetcher: jupiter prices failed', { error: err.message });
  }
  return out;
}

export function getCachedPrice(mint) {
  if (!mint) return null;
  const v = getCached(priceCache, mint, DEFAULT_TTL_PRICE_MS);
  return v ?? null;
}

export async function fetchMeteoraDiscoveryByPool(poolAddress, opts = {}) {
  return fetchMeteoraDiscovery({
    pageSize: 1,
    filterBy: `pool_address=${poolAddress}`,
    timeframe: opts.timeframe || '4h',
  });
}

export function clearMetricsCache() {
  priceCache.clear();
  poolMetaCache.clear();
  discoveryCache.clear();
}

export function knownMint(mint) {
  if (!mint) return null;
  for (const [name, addr] of Object.entries(KNOWN_MINTS)) {
    if (addr === mint) return name;
  }
  return null;
}