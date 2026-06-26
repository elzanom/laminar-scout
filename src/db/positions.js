import { getDb } from './index.js';

function now() { return Math.floor(Date.now() / 1000); }

export function getPosition(id) {
  return getDb().prepare(`SELECT * FROM positions WHERE id = ?`).get(id) || null;
}

export function getPositionByMint(mint) {
  if (!mint) return null;
  return getDb().prepare(`SELECT * FROM positions WHERE position_mint = ? ORDER BY entry_timestamp DESC LIMIT 1`).get(mint) || null;
}

export function listPositions(filter = {}, opts = {}) {
  const where = [];
  const params = [];
  if (filter.wallet_address) { where.push('wallet_address = ?'); params.push(filter.wallet_address); }
  if (filter.pool_address) { where.push('pool_address = ?'); params.push(filter.pool_address); }
  if (filter.status) { where.push('status = ?'); params.push(filter.status); }
  if (filter.position_mint) { where.push('position_mint = ?'); params.push(filter.position_mint); }
  if (filter.wallet_and_pool) {
    where.length = 0;
    params.length = 0;
    where.push('wallet_address = ?'); params.push(filter.wallet_and_pool.wallet);
    where.push('pool_address = ?'); params.push(filter.wallet_and_pool.pool);
  }
  const limit = opts.limit ? `LIMIT ${Number(opts.limit)}` : '';
  const sql = `SELECT * FROM positions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY entry_timestamp DESC ${limit}`;
  return getDb().prepare(sql).all(...params);
}

export function listOpenPositions(poolAddress = null) {
  if (poolAddress) {
    return getDb().prepare(`SELECT * FROM positions WHERE status = 'open' AND pool_address = ?`).all(poolAddress);
  }
  return getDb().prepare(`SELECT * FROM positions WHERE status = 'open'`).all();
}

export function countPositions(filter = {}) {
  const where = [];
  const params = [];
  if (filter.wallet_address) { where.push('wallet_address = ?'); params.push(filter.wallet_address); }
  if (filter.pool_address) { where.push('pool_address = ?'); params.push(filter.pool_address); }
  if (filter.status) { where.push('status = ?'); params.push(filter.status); }
  const sql = `SELECT COUNT(*) AS n FROM positions ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
  return getDb().prepare(sql).get(...params).n;
}

export function insertPosition(p) {
  if (!p || !p.id) throw new Error('position.id required (use on-chain position mint as id)');
  const db = getDb();
  const existing = getPosition(p.id);
  if (existing) return existing;
  db.prepare(`
    INSERT INTO positions (
      id, wallet_address, pool_address, token_pair,
      entry_timestamp, entry_price, bin_step, bin_lower, bin_upper, bin_range_width,
      amount_token_x, amount_token_y, capital_usd, entry_tx,
      position_mint, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    p.id,
    p.wallet_address,
    p.pool_address,
    p.token_pair || null,
    p.entry_timestamp || now(),
    p.entry_price ?? null,
    p.bin_step ?? null,
    p.bin_lower ?? null,
    p.bin_upper ?? null,
    p.bin_range_width ?? null,
    p.amount_token_x ?? null,
    p.amount_token_y ?? null,
    p.capital_usd ?? null,
    p.entry_tx || null,
    p.position_mint || p.id,
    p.status || 'open',
    now(),
    now(),
  );
  return getPosition(p.id);
}

export function closePosition(id, closeData = {}) {
  const db = getDb();
  const p = getPosition(id);
  if (!p) throw new Error(`position not found: ${id}`);
  if (p.status === 'closed') return p;
  const updates = ['status = ?', 'updated_at = ?'];
  const params = ['closed', now()];
  if (closeData.exit_timestamp !== undefined) { updates.push('exit_timestamp = ?'); params.push(closeData.exit_timestamp); }
  if (closeData.exit_price !== undefined) { updates.push('exit_price = ?'); params.push(closeData.exit_price); }
  if (closeData.exit_tx !== undefined) { updates.push('exit_tx = ?'); params.push(closeData.exit_tx); }
  if (closeData.fees_earned_usd !== undefined) { updates.push('fees_earned_usd = ?'); params.push(closeData.fees_earned_usd); }
  if (closeData.pnl_usd !== undefined) { updates.push('pnl_usd = ?'); params.push(closeData.pnl_usd); }
  if (closeData.pnl_pct !== undefined) { updates.push('pnl_pct = ?'); params.push(closeData.pnl_pct); }
  if (closeData.fee_yield !== undefined) { updates.push('fee_yield = ?'); params.push(closeData.fee_yield); }
  if (closeData.duration_hours !== undefined) { updates.push('duration_hours = ?'); params.push(closeData.duration_hours); }
  if (closeData.is_profitable !== undefined) { updates.push('is_profitable = ?'); params.push(closeData.is_profitable ? 1 : 0); }
  if (closeData.close_reason !== undefined) { updates.push('close_reason = ?'); params.push(closeData.close_reason); }
  if (closeData.pnl_sol !== undefined) { updates.push('pnl_sol = ?'); params.push(closeData.pnl_sol); }
  if (closeData.pnl_sol_pct !== undefined) { updates.push('pnl_sol_pct = ?'); params.push(closeData.pnl_sol_pct); }
  if (closeData.pool_active_bin_id !== undefined) { updates.push('pool_active_bin_id = ?'); params.push(closeData.pool_active_bin_id); }
  if (closeData.is_out_of_range !== undefined) { updates.push('is_out_of_range = ?'); params.push(closeData.is_out_of_range ? 1 : 0); }
  if (closeData.fee_per_tvl_24h !== undefined) { updates.push('fee_per_tvl_24h = ?'); params.push(closeData.fee_per_tvl_24h); }
  params.push(id);
  db.prepare(`UPDATE positions SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  return getPosition(id);
}

export function deletePosition(id) {
  return getDb().prepare(`DELETE FROM positions WHERE id = ?`).run(id);
}