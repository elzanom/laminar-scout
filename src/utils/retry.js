import { log } from './logger.js';

const DEFAULTS = {
  maxAttempts: 5,
  maxElapsedMs: 60_000,
  perAttemptTimeoutMs: 15_000,
  baseBackoffMs: 500,
  maxBackoffMs: 5_000,
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableStatus(status) {
  if (!status) return false;
  if (status === 408 || status === 409 || status === 425 || status === 429) return true;
  return status >= 500;
}

function isRetryableError(err) {
  if (!err) return false;
  const code = err.code || err.cause?.code;
  if (code === 'AbortError' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') return true;
  const msg = String(err.message || '');
  if (/network|fetch failed|aborted|timeout/i.test(msg)) return true;
  return false;
}

export async function withRetry(fn, opts = {}, label = 'retry') {
  const cfg = { ...DEFAULTS, ...opts };
  const start = Date.now();
  let lastErr;
  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    if (Date.now() - start > cfg.maxElapsedMs) {
      log('warn', `${label}: max elapsed ${cfg.maxElapsedMs}ms exceeded after ${attempt - 1} attempts`);
      break;
    }
    try {
      const result = await fn(attempt);
      return result;
    } catch (err) {
      lastErr = err;
      const status = err.status || err.statusCode || (err.response && err.response.status);
      const retryable = isRetryableStatus(status) || isRetryableError(err);
      const remaining = cfg.maxAttempts - attempt;
      if (!retryable || remaining === 0) {
        log('error', `${label}: giving up after ${attempt} attempts`, { error: err.message, status });
        break;
      }
      const backoff = Math.min(cfg.baseBackoffMs * 2 ** (attempt - 1), cfg.maxBackoffMs);
      log('warn', `${label}: attempt ${attempt} failed (${status || err.code || err.message}); retrying in ${backoff}ms`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

export async function fetchJson(url, init = {}, opts = {}, label = url) {
  const cfg = { ...DEFAULTS, perAttemptTimeoutMs: 15_000, ...opts };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.perAttemptTimeoutMs);
  try {
    return await withRetry(async () => {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    }, cfg, label);
  } finally {
    clearTimeout(timer);
  }
}

export { isRetryableStatus, isRetryableError };