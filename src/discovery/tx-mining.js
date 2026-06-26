import { onTxEvent, offTxEvent, TX_EVENT_TYPES } from '../collector/event-bus.js';
import { upsertWallet, getWallet } from '../db/wallets.js';
import { log } from '../utils/logger.js';
import { recordSuccess, recordError, incrCounter } from '../utils/health.js';

const SOURCE_TAG = 'tx_mining';

const KNOWN_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function isLikelySolanaAddress(s) {
  return typeof s === 'string' && KNOWN_MINT_RE.test(s);
}

function pickWallet(event) {
  if (!event) return null;
  if (isLikelySolanaAddress(event.wallet)) return event.wallet;
  if (isLikelySolanaAddress(event.feePayer)) return event.feePayer;
  return null;
}

function pickSourceDetail(event) {
  if (!event) return null;
  if (event.pool) return event.pool;
  if (event.signature) return `tx:${event.signature}`;
  return null;
}

export function handleDlmmEvent(event, opts = {}) {
  const wallet = pickWallet(event);
  if (!wallet) return { skipped: 'no_wallet', event: event?.eventType };

  const ts = event.timestamp || Math.floor(Date.now() / 1000);
  const existing = opts.lookup ? null : getWallet(wallet);

  if (existing && existing.source === 'manual') {
    return { skipped: 'manual_wallet', wallet };
  }

  if (existing) {
    upsertWallet({ address: wallet, last_active: ts });
    return { wallet, action: 'updated', source: existing.source };
  }

  upsertWallet({
    address: wallet,
    source: SOURCE_TAG,
    discovered_from: pickSourceDetail(event),
    status: 'candidate',
    first_seen: ts,
    last_active: ts,
  });
  return { wallet, action: 'inserted', source: SOURCE_TAG };
}

function makeListener(stats) {
  return (event) => {
    try {
      const result = handleDlmmEvent(event);
      stats.processed += 1;
      if (result.action === 'inserted') stats.inserted += 1;
      else if (result.action === 'updated') stats.updated += 1;
      else stats.skipped += 1;

      if (stats.processed % 100 === 0) {
        recordSuccess('tx-mining', { ...stats });
      }
    } catch (err) {
      stats.errors += 1;
      recordError('tx-mining.handle', err, { signature: event?.signature });
    }
  };
}

export function startTxMining() {
  const stats = { processed: 0, inserted: 0, updated: 0, skipped: 0, errors: 0 };
  const listener = makeListener(stats);
  onTxEvent(TX_EVENT_TYPES.ANY_DLMM, listener);
  incrCounter('tx_mining.start', 1);
  recordSuccess('tx-mining', { started: true });
  log('info', 'tx-mining: subscribed to ANY_DLMM events');

  return {
    stop: () => {
      offTxEvent(TX_EVENT_TYPES.ANY_DLMM, listener);
      log('info', 'tx-mining: unsubscribed', stats);
    },
    stats: () => ({ ...stats }),
  };
}

export const _test = { pickWallet, pickSourceDetail, isLikelySolanaAddress };