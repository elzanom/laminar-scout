import { getDb } from './index.js';

function nowSec() { return Math.floor(Date.now() / 1000); }

export function markProcessed(txSignature, source = 'unknown') {
  if (!txSignature) return null;
  try {
    return getDb().prepare(`
      INSERT INTO processed_txs (tx_signature, processed_at, source) VALUES (?, ?, ?)
    `).run(txSignature, nowSec(), source);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return { changes: 0 };
    throw err;
  }
}

export function isProcessed(txSignature) {
  if (!txSignature) return false;
  const row = getDb().prepare(`SELECT 1 FROM processed_txs WHERE tx_signature = ? LIMIT 1`).get(txSignature);
  return !!row;
}

export function filterUnprocessed(signatures = []) {
  if (!Array.isArray(signatures) || !signatures.length) return [];
  const placeholders = signatures.map(() => '?').join(',');
  const seen = getDb().prepare(`SELECT tx_signature FROM processed_txs WHERE tx_signature IN (${placeholders})`).all(...signatures);
  const seenSet = new Set(seen.map((r) => r.tx_signature));
  return signatures.filter((s) => !seenSet.has(s));
}

export function processedCount() {
  return getDb().prepare(`SELECT COUNT(*) AS n FROM processed_txs`).get().n;
}

export function pruneProcessedTxs(olderThanSec) {
  return getDb().prepare(`DELETE FROM processed_txs WHERE processed_at < ?`).run(olderThanSec);
}