import { getDb } from './index.js';

function nowSec() { return Math.floor(Date.now() / 1000); }

export function insertSignal(sig) {
  if (!sig || !sig.pool_address) throw new Error('signal.pool_address required');
  const validationReasons = typeof sig.validation_reasons === 'string'
    ? sig.validation_reasons
    : JSON.stringify(sig.validation_reasons || []);
  const result = getDb().prepare(`
    INSERT INTO signals (
      pool_address, token_pair, trigger_type, triggered_by,
      wallet_score, pool_score, combined_confidence, validation_reasons,
      suggested_bin_step, suggested_range_lower, suggested_range_upper,
      fee_apr, volume_24h, tvl, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sig.pool_address,
    sig.token_pair || null,
    sig.trigger_type || null,
    sig.triggered_by || null,
    sig.wallet_score ?? null,
    sig.pool_score ?? null,
    sig.combined_confidence ?? null,
    validationReasons,
    sig.suggested_bin_step ?? null,
    sig.suggested_range_lower ?? null,
    sig.suggested_range_upper ?? null,
    sig.fee_apr ?? null,
    sig.volume_24h ?? null,
    sig.tvl ?? null,
    sig.status || 'pending',
    nowSec(),
  );
  return result.lastInsertRowid;
}

export function markSignalStatus(id, status, emittedAt = null) {
  return getDb().prepare(`
    UPDATE signals SET status = ?, emitted_at = COALESCE(?, emitted_at) WHERE id = ?
  `).run(status, emittedAt, id);
}

export function getSignal(id) {
  return getDb().prepare(`SELECT * FROM signals WHERE id = ?`).get(id) || null;
}

export function listSignals(filter = {}, opts = {}) {
  const where = [];
  const params = [];
  if (filter.status) { where.push('status = ?'); params.push(filter.status); }
  if (filter.pool_address) { where.push('pool_address = ?'); params.push(filter.pool_address); }
  if (filter.since) { where.push('created_at >= ?'); params.push(filter.since); }
  const limit = opts.limit ? `LIMIT ${Number(opts.limit)}` : '';
  const sql = `SELECT * FROM signals ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC ${limit}`;
  return getDb().prepare(sql).all(...params);
}

export function recentSignalForPool(poolAddress, sinceSec) {
  if (!poolAddress) return null;
  return getDb().prepare(`
    SELECT * FROM signals
    WHERE pool_address = ? AND created_at >= ?
    ORDER BY created_at DESC LIMIT 1
  `).get(poolAddress, sinceSec) || null;
}

export function expireStaleSignals(maxAgeSec) {
  return getDb().prepare(`
    UPDATE signals SET status = 'expired'
    WHERE status = 'pending' AND created_at < ?
  `).run(nowSec() - maxAgeSec);
}