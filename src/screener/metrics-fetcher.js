import { fetchJson } from '../utils/retry.js';
import { log } from '../utils/logger.js';
import { recordSuccess, recordError, incrCounter } from '../utils/health.js';
import { KNOWN_MINTS } from '../constants.js';

const METEORA_POOL_DISCOVERY = 'https://pool-discovery-api.datapi.meteora.ag/pools';
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

export async function fetchMeteoraDiscovery({ pageSize = 50, filterBy = '', timeframe = '4h' } = {}) {
  const cacheKey = JSON.stringify({ pageSize, filterBy, timeframe });
  const cached = getCached(discoveryCache, cacheKey, DEFAULT_TTL_DISCOVERY_MS);
  if (cached) return cached;

  const q = new URLSearchParams();
  q.set('page_size', String(pageSize));
  if (filterBy) q.set('filter_by', filterBy);
  if (timeframe) q.set('timeframe', timeframe);
  const url = `${METEORA_POOL_DISCOVERY}?${q.toString()}`;

  try {
    const data = await fetchJson(url, {}, {}, 'meteora-discovery');
    const result = { data: Array.isArray(data?.data) ? data.data : [], total: data?.total ?? (data?.data?.length || 0) };
    setCached(discoveryCache, cacheKey, result);
    incrCounter('metrics.discovery.hit', result.data.length);
    recordSuccess('metrics.discovery', { count: result.data.length, timeframe });
    return result;
  } catch (err) {
    recordError('metrics.discovery', err);
    throw err;
  }
}

export async function fetchMeteoraPoolMeta(poolAddress) {
  if (!poolAddress) return null;
  const cached = getCached(poolMetaCache, poolAddress, DEFAULT_TTL_POOL_META_MS);
  if (cached) return cached;
  const url = `${METEORA_DLMM_POOLS}/${poolAddress}`;
  try {
    const data = await fetchJson(url, {}, {}, `meteora-pool-meta:${poolAddress}`);
    setCached(poolMetaCache, poolAddress, data);
    recordSuccess('metrics.pool-meta', { pool: poolAddress });
    return data;
  } catch (err) {
    recordError('metrics.pool-meta', err, { pool: poolAddress });
    log('warn', `metrics-fetcher: pool-meta failed for ${poolAddress}`, { error: err.message });
    return null;
  }
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