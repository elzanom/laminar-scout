import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);

const CACHE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

const cache = new Map();
let lastCallTs = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rateLimit(ratePerSec) {
  if (!ratePerSec || ratePerSec <= 0) return;
  const minGapMs = 1000 / ratePerSec;
  const now = Date.now();
  const gap = now - lastCallTs;
  if (gap < minGapMs) await sleep(minGapMs - gap);
  lastCallTs = Date.now();
}

function cacheKey(chain, address, sub) {
  return `${chain}:${address}:${sub || 'default'}`;
}

async function execGmgn(args, opts = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, maxBuffer = DEFAULT_MAX_BUFFER } = opts;
  try {
    const { stdout } = await pExecFile('gmgn-cli', args, {
      timeout: timeoutMs,
      maxBuffer,
      windowsHide: true,
    });
    return stdout;
  } catch (err) {
    const msg = err.stderr ? err.stderr.toString().trim() : err.message;
    const code = err.code || 'unknown';
    const e = new Error(`gmgn-cli ${args.join(' ')} failed (${code}): ${msg}`);
    e.cause = err;
    throw e;
  }
}

export function clearCache() {
  cache.clear();
}

export function cacheSize() {
  return cache.size;
}

async function cachedCall(key, ttlMs, fn) {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.ts < ttlMs) return cached.value;
  const value = await fn();
  cache.set(key, { value, ts: now });
  return value;
}

export async function getTokenInfo(chain, address, { useCache = true, cacheTtlMs = CACHE_TTL_MS, ratePerSec = 2 } = {}) {
  const key = cacheKey(chain, address, 'info');
  if (!useCache) cache.delete(key);
  await rateLimit(ratePerSec);
  return cachedCall(key, cacheTtlMs, async () => {
    const stdout = await execGmgn(['token', 'info', '--chain', chain, '--address', address, '--raw']);
    return JSON.parse(stdout);
  });
}

export async function getTokenHolders(chain, address, { limit = 20, useCache = true, cacheTtlMs = CACHE_TTL_MS, ratePerSec = 2 } = {}) {
  const key = cacheKey(chain, address, `holders:${limit}`);
  if (!useCache) cache.delete(key);
  await rateLimit(ratePerSec);
  return cachedCall(key, cacheTtlMs, async () => {
    const stdout = await execGmgn([
      'token', 'holders',
      '--chain', chain,
      '--address', address,
      '--limit', String(limit),
      '--order-by', 'amount_percentage',
      '--direction', 'desc',
      '--raw',
    ]);
    const parsed = JSON.parse(stdout);
    return parsed.list || parsed.rank || parsed.data || [];
  });
}

export function extractHolderMetrics(holderList) {
  if (!Array.isArray(holderList) || holderList.length === 0) {
    return { top10_concentration: null, holder_count_from_list: 0 };
  }
  const top = holderList.slice(0, 10);
  let totalPct = 0;
  let parsedCount = 0;
  for (const h of top) {
    const pctRaw = h.amount_percentage ?? h.amountPercentage ?? h.percentage ?? h.percent;
    const pct = typeof pctRaw === 'string' ? parseFloat(pctRaw) : pctRaw;
    if (typeof pct === 'number' && !Number.isNaN(pct)) {
      totalPct += pct;
      parsedCount += 1;
    }
  }
  return {
    top10_concentration: parsedCount > 0 ? +(totalPct / 100).toFixed(6) : null,
    holder_count_from_list: holderList.length,
  };
}

export async function getTokenMetrics(chain, address, opts = {}) {
  const useCache = opts.useCache !== false;
  const cacheTtlMs = opts.cacheTtlMs ?? CACHE_TTL_MS;
  const ratePerSec = opts.ratePerSec ?? 2;
  const includeHolders = opts.includeHolders !== false;

  const info = await getTokenInfo(chain, address, { useCache, cacheTtlMs, ratePerSec });

  const result = {
    holder_count: toNumber(info.holder_count ?? info.stat?.holder_count),
    circulating_supply: parseSupply(info.circulating_supply),
    total_supply: parseSupply(info.total_supply),
    creation_timestamp: toTimestamp(info.creation_timestamp),
    launches_at: toTimestamp(info.open_timestamp || info.launchpad_open_timestamp),
    liquidity_usd: toNumber(info.liquidity ?? info.pool?.liquidity),
    swap_total_24h: toNumber(info.price?.swaps_24h ?? info.swaps_24h),
    buy_volume_24h: toNumber(info.price?.buy_volume_24h ?? info.buy_volume_24h),
    sell_volume_24h: toNumber(info.price?.sell_volume_24h ?? info.sell_volume_24h),
    top10_holder_rate: toNumber(info.stat?.top_10_holder_rate ?? info.dev?.top_10_holder_rate),
    dev_hold_rate: toNumber(info.stat?.dev_team_hold_rate ?? info.stat?.creator_hold_rate),
    launchpad: info.launchpad || info.launchpad_platform || null,
    source: 'gmgn-cli',
  };

  if (includeHolders) {
    try {
      const holders = await getTokenHolders(chain, address, {
        limit: 20,
        useCache,
        cacheTtlMs,
        ratePerSec,
      });
      const m = extractHolderMetrics(holders);
      if (m.top10_concentration != null) result.top10_concentration_calculated = m.top10_concentration;
      result.holders_sampled = m.holder_count_from_list;
    } catch (err) {
      result.holders_error = err.message;
    }
  }

  if (result.top10_concentration_calculated == null && result.top10_holder_rate != null && result.top10_holder_rate > 0) {
    result.top10_concentration_calculated = result.top10_holder_rate;
  }

  return result;
}

function parseSupply(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
}

function toNumber(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
}

function toTimestamp(v) {
  if (!v || v === 0) return null;
  const n = typeof v === 'string' ? parseInt(v, 10) : v;
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? Math.floor(n) : Math.floor(n / 1000);
}

export async function ping() {
  try {
    const { stdout } = await pExecFile('gmgn-cli', ['--version'], { timeout: 5000 });
    return { ok: true, version: stdout.trim() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
