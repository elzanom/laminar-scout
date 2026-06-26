import { fetchJson } from '../utils/retry.js';
import { withRetry } from '../utils/retry.js';
import { parseTransaction } from './tx-parser.js';
import { markProcessed, filterUnprocessed } from '../db/processed-txs.js';
import { getWallet, updateBackfillState } from '../db/wallets.js';
import { log, logAction } from '../utils/logger.js';
import { recordSuccess, recordError, incrCounter } from '../utils/health.js';
import { getConfig } from '../config/config.js';
import { emitTxEvent, TX_EVENT_TYPES } from './event-bus.js';

const HELIUS_TX_BASE = 'https://api.helius.xyz/v0/addresses';
const SOURCE_TAG = 'helius_history';
const PAGE_SIZE = 100;
const MAX_PAGES_PER_CALL = 50;

function heliusUrl(wallet, params = {}) {
  const cfg = getConfig();
  const q = new URLSearchParams();
  q.set('api-key', cfg.helius.apiKey);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') q.set(k, v);
  }
  return `${HELIUS_TX_BASE}/${wallet}/transactions?${q.toString()}`;
}

async function fetchHeliusPage(wallet, params, label) {
  return fetchJson(heliusUrl(wallet, params), {}, {}, label || `helius:${wallet}`);
}

export async function fetchWalletTransactions(wallet, opts = {}) {
  const cfg = getConfig();
  const before = opts.before || undefined;
  const limit = opts.limit || PAGE_SIZE;
  const txs = await fetchHeliusPage(wallet, { limit, before: before || '' }, `helius-history:${wallet}`);
  return Array.isArray(txs) ? txs : [];
}

export async function backfillWallet(walletAddress, opts = {}) {
  const cfg = getConfig();
  const days = opts.days || cfg.discovery.evaluationBackfillDays;
  const cutoffTs = Math.floor(Date.now() / 1000) - days * 86400;
  const maxPages = opts.maxPages || MAX_PAGES_PER_CALL;
  const pageDelayMs = opts.pageDelayMs || 0;

  log('info', `helius-history: backfill start`, { wallet: walletAddress, days, cutoffTs });
  let before = opts.before || null;
  let page = 0;
  let totalFetched = 0;
  let totalEvents = 0;
  let oldestSeenTs = null;
  let newestSeenSig = null;
  let stopReason = 'exhausted';

  while (page < maxPages) {
    let txs;
    try {
      txs = await fetchWalletTransactions(walletAddress, { before });
    } catch (err) {
      recordError('helius-history', err, { wallet: walletAddress, page });
      throw err;
    }
    if (!txs.length) {
      stopReason = 'empty-page';
      break;
    }

    page += 1;
    totalFetched += txs.length;

    const sigs = txs.map((t) => t.signature).filter(Boolean);
    const newSigs = filterUnprocessed(sigs);
    for (const sig of newSigs) markProcessed(sig, SOURCE_TAG);

    for (const tx of txs) {
      const events = parseTransaction(tx, { source: SOURCE_TAG, wallet: walletAddress });
      for (const ev of events) {
        totalEvents += 1;
        try { emitTxEvent(TX_EVENT_TYPES.ANY_DLMM, ev); } catch { /* bus optional */ }
      }
      const ts = tx.blockTime || tx.timestamp;
      if (ts && (oldestSeenTs === null || ts < oldestSeenTs)) oldestSeenTs = ts;
    }

    newestSeenSig = newestSeenSig || txs[0]?.signature || null;
    if (oldestSeenTs !== null && oldestSeenTs < cutoffTs) {
      stopReason = 'cutoff-reached';
      break;
    }

    before = txs[txs.length - 1]?.signature;
    if (!before) {
      stopReason = 'no-more-pages';
      break;
    }

    if (pageDelayMs > 0) {
      await new Promise((r) => setTimeout(r, pageDelayMs));
    }
  }

  if (oldestSeenTs !== null) {
    updateBackfillState(walletAddress, oldestSeenTs, null);
  }

  incrCounter('helius_history.backfill.tx_fetched', totalFetched);
  incrCounter('helius_history.backfill.events', totalEvents);

  recordSuccess('helius-history', {
    wallet: walletAddress,
    pages: page,
    txFetched: totalFetched,
    events: totalEvents,
    cutoffTs,
  });

  logAction('helius-history.backfill', {
    wallet: walletAddress,
    pages: page,
    txFetched: totalFetched,
    events: totalEvents,
    stopReason,
    cutoffTs,
  });

  log('info', `helius-history: backfill done`, {
    wallet: walletAddress,
    pages: page,
    txFetched: totalFetched,
    events: totalEvents,
    stopReason,
  });

  return { pages: page, txFetched: totalFetched, events: totalEvents, stopReason, oldestSeenTs, newestSeenSig };
}

export async function syncWallet(walletAddress, opts = {}) {
  const cfg = getConfig();
  const limit = opts.limit || PAGE_SIZE;
  const txs = await fetchWalletTransactions(walletAddress, { limit });
  if (!txs.length) {
    recordSuccess('helius-history.sync', { wallet: walletAddress, txFetched: 0 });
    return { txFetched: 0, events: 0 };
  }

  const sigs = txs.map((t) => t.signature).filter(Boolean);
  const newSigs = filterUnprocessed(sigs);
  for (const sig of newSigs) markProcessed(sig, SOURCE_TAG);

  let totalEvents = 0;
  let newestSig = null;
  let newestTs = null;
  for (const tx of txs) {
    const events = parseTransaction(tx, { source: SOURCE_TAG, wallet: walletAddress });
    for (const ev of events) {
      totalEvents += 1;
      try { emitTxEvent(TX_EVENT_TYPES.ANY_DLMM, ev); } catch { /* bus optional */ }
    }
    const ts = tx.blockTime || tx.timestamp;
    if (ts && (newestTs === null || ts > newestTs)) {
      newestTs = ts;
      newestSig = tx.signature;
    }
  }

  const wallet = getWallet(walletAddress);
  const existing = wallet?.history_backfilled_until || 0;
  if (newestTs && newestTs > existing) {
    updateBackfillState(walletAddress, newestTs, newestSig);
  }

  incrCounter('helius_history.sync.tx_fetched', txs.length);
  incrCounter('helius_history.sync.events', totalEvents);
  recordSuccess('helius-history.sync', { wallet: walletAddress, txFetched: txs.length, events: totalEvents });

  return { txFetched: txs.length, events: totalEvents, newestSig, newestTs };
}

export async function syncTrackedWallets(wallets, opts = {}) {
  const results = [];
  for (const w of wallets) {
    try {
      const r = await syncWallet(w, opts);
      results.push({ wallet: w, ...r });
    } catch (err) {
      recordError('helius-history.sync', err, { wallet: w });
      results.push({ wallet: w, error: err.message });
    }
  }
  return results;
}

export async function backfillMany(wallets, opts = {}) {
  const results = [];
  for (const w of wallets) {
    try {
      const r = await backfillWallet(w, opts);
      results.push({ wallet: w, ...r });
    } catch (err) {
      recordError('helius-history.backfill', err, { wallet: w });
      results.push({ wallet: w, error: err.message });
    }
  }
  return results;
}