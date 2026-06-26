import { getDb } from './index.js';

const VALID_STATUSES = new Set(['candidate', 'tracked', 'top', 'rejected']);
const VALID_SOURCES = new Set(['manual', 'pool_discovery', 'tx_mining', 'follow_winner']);

function now() { return Math.floor(Date.now() / 1000); }

export function getWallet(address) {
  return getDb().prepare(`SELECT * FROM wallets WHERE address = ?`).get(address) || null;
}

export function listWallets(filter = {}, opts = {}) {
  const where = [];
  const params = [];
  if (filter.status) { where.push('status = ?'); params.push(filter.status); }
  if (filter.is_top_wallet !== undefined) { where.push('is_top_wallet = ?'); params.push(filter.is_top_wallet ? 1 : 0); }
  if (filter.is_tracked !== undefined) { where.push('is_tracked = ?'); params.push(filter.is_tracked ? 1 : 0); }
  if (filter.source) { where.push('source = ?'); params.push(filter.source); }
  if (filter.min_score !== undefined) { where.push('score >= ?'); params.push(filter.min_score); }
  const sql = `SELECT * FROM wallets ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY score DESC ${opts.limit ? 'LIMIT ' + Number(opts.limit) : ''}`;
  return getDb().prepare(sql).all(...params);
}

export function countWallets(filter = {}) {
  const where = [];
  const params = [];
  if (filter.status) { where.push('status = ?'); params.push(filter.status); }
  if (filter.is_top_wallet !== undefined) { where.push('is_top_wallet = ?'); params.push(filter.is_top_wallet ? 1 : 0); }
  const sql = `SELECT COUNT(*) AS n FROM wallets ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
  return getDb().prepare(sql).get(...params).n;
}

export function upsertWallet(wallet) {
  if (!wallet || !wallet.address) throw new Error('wallet.address required');
  if (wallet.status && !VALID_STATUSES.has(wallet.status)) throw new Error(`invalid wallet.status: ${wallet.status}`);
  if (wallet.source && !VALID_SOURCES.has(wallet.source)) throw new Error(`invalid wallet.source: ${wallet.source}`);
  const db = getDb();
  const existing = getWallet(wallet.address);
  const ts = now();
  if (!existing) {
    const m = wallet.metrics || wallet;
    db.prepare(`
      INSERT INTO wallets (
        address, alias, source, discovered_from, first_seen, last_active,
        status, is_tracked, is_top_wallet, score,
        total_positions, win_count, loss_count, win_rate,
        total_pnl_usd, total_fees_usd, avg_fee_yield, avg_duration_hours,
        history_backfilled_until, last_backfilled_sig,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      wallet.address,
      wallet.alias || null,
      wallet.source || null,
      wallet.discovered_from || null,
      wallet.first_seen || ts,
      wallet.last_active || ts,
      wallet.status || 'candidate',
      wallet.is_tracked ? 1 : 0,
      wallet.is_top_wallet ? 1 : 0,
      wallet.score ?? 0,
      m.total_positions ?? 0,
      m.win_count ?? 0,
      m.loss_count ?? 0,
      m.win_rate ?? 0,
      m.total_pnl_usd ?? 0,
      m.total_fees_usd ?? 0,
      m.avg_fee_yield ?? 0,
      m.avg_duration_hours ?? 0,
      wallet.history_backfilled_until || 0,
      wallet.last_backfilled_sig || null,
      ts,
      ts,
    );
    logDiscovery(wallet.address, wallet.source || 'manual', wallet.discovered_from || null);
    return getWallet(wallet.address);
  }
  const updates = [];
  const params = [];
  const fields = ['alias', 'last_active', 'status', 'is_tracked', 'is_top_wallet', 'score', 'score_updated', 'evaluation_count', 'last_evaluated', 'reject_reason', 'history_backfilled_until', 'last_backfilled_sig'];
  for (const f of fields) {
    if (wallet[f] !== undefined) { updates.push(`${f} = ?`); params.push(wallet[f]); }
  }
  if (wallet.metrics) {
    const m = wallet.metrics;
    if (m.total_positions !== undefined) { updates.push('total_positions = ?'); params.push(m.total_positions); }
    if (m.win_count !== undefined) { updates.push('win_count = ?'); params.push(m.win_count); }
    if (m.loss_count !== undefined) { updates.push('loss_count = ?'); params.push(m.loss_count); }
    if (m.win_rate !== undefined) { updates.push('win_rate = ?'); params.push(m.win_rate); }
    if (m.total_pnl_usd !== undefined) { updates.push('total_pnl_usd = ?'); params.push(m.total_pnl_usd); }
    if (m.total_fees_usd !== undefined) { updates.push('total_fees_usd = ?'); params.push(m.total_fees_usd); }
    if (m.avg_fee_yield !== undefined) { updates.push('avg_fee_yield = ?'); params.push(m.avg_fee_yield); }
    if (m.avg_duration_hours !== undefined) { updates.push('avg_duration_hours = ?'); params.push(m.avg_duration_hours); }
  }
  if (!updates.length) return existing;
  updates.push('updated_at = ?'); params.push(ts);
  params.push(wallet.address);
  db.prepare(`UPDATE wallets SET ${updates.join(', ')} WHERE address = ?`).run(...params);
  return getWallet(wallet.address);
}

export function logDiscovery(walletAddress, source, detail = null) {
  if (!walletAddress || !source) return null;
  return getDb().prepare(`
    INSERT INTO wallet_discovery_log (wallet_address, discovery_source, source_detail)
    VALUES (?, ?, ?)
  `).run(walletAddress, source, detail);
}

export function listDiscoveryLog(walletAddress, limit = 50) {
  return getDb().prepare(`
    SELECT * FROM wallet_discovery_log
    WHERE wallet_address = ?
    ORDER BY discovered_at DESC
    LIMIT ?
  `).all(walletAddress, limit);
}

export function setWalletStatus(address, status, opts = null) {
  if (!VALID_STATUSES.has(status)) throw new Error(`invalid status: ${status}`);
  const updates = ['status = ?', 'updated_at = ?'];
  const params = [status, now()];
  if (typeof opts === 'string') {
    updates.push('reject_reason = ?');
    params.push(opts);
  } else if (opts && typeof opts === 'object') {
    if (opts.reject_reason !== undefined) { updates.push('reject_reason = ?'); params.push(opts.reject_reason); }
    if (opts.is_top_wallet !== undefined) { updates.push('is_top_wallet = ?'); params.push(opts.is_top_wallet ? 1 : 0); }
    if (opts.is_tracked !== undefined) { updates.push('is_tracked = ?'); params.push(opts.is_tracked ? 1 : 0); }
  }
  params.push(address);
  return getDb().prepare(`UPDATE wallets SET ${updates.join(', ')} WHERE address = ?`).run(...params);
}

export function markTopWallet(address, isTop = true) {
  return getDb().prepare(`
    UPDATE wallets SET is_top_wallet = ?, updated_at = ?
    WHERE address = ?
  `).run(isTop ? 1 : 0, now(), address);
}

export function markTracked(address, isTracked = true) {
  return getDb().prepare(`
    UPDATE wallets SET is_tracked = ?, updated_at = ?
    WHERE address = ?
  `).run(isTracked ? 1 : 0, now(), address);
}

export function updateBackfillState(address, backfilledUntil, lastSig = null) {
  return getDb().prepare(`
    UPDATE wallets SET history_backfilled_until = ?, last_backfilled_sig = ?, updated_at = ?
    WHERE address = ?
  `).run(backfilledUntil, lastSig, now(), address);
}

export function listCandidatesNeedingEval(limit = 100) {
  return getDb().prepare(`
    SELECT * FROM wallets
    WHERE status IN ('candidate', 'rejected')
    ORDER BY
      CASE WHEN last_evaluated IS NULL THEN 0 ELSE 1 END ASC,
      last_evaluated ASC,
      first_seen ASC
    LIMIT ?
  `).all(limit);
}

export function deleteWallet(address) {
  return getDb().prepare(`DELETE FROM wallets WHERE address = ?`).run(address);
}