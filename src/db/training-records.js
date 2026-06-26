import { getDb } from './index.js';

function nowSec() { return Math.floor(Date.now() / 1000); }

export function insertTrainingRecord(rec) {
  if (!rec || !rec.position_id) throw new Error('training_record.position_id required');
  const db = getDb();
  const existing = db.prepare('SELECT id FROM training_records WHERE position_id = ?').get(rec.position_id);
  if (existing) return { changes: 0, skipped: true, id: existing.id };
  return db.prepare(`
    INSERT INTO training_records (
      position_id, wallet_address, pool_address,
      entry_timestamp, close_timestamp,
      was_profitable, pnl_usd, pnl_pct, pnl_sol, pnl_sol_pct, fee_earned_usd, fee_yield, duration_hours,
      pool_fee_apr, pool_apr, pool_apy, pool_volume_24h, pool_tvl, fee_tvl_ratio, pool_bin_step,
      pool_launchpad, pool_has_farm, pool_farm_apr, pool_dynamic_fee_pct, pool_current_price,
      token_pair, token_pair_base_mint, token_pair_quote_mint, days_since_pool_created, pool_token_x_age_hours,
      token_x_symbol, token_x_market_cap, token_x_fdv, token_x_holders, token_x_organic_score,
      token_x_is_verified, token_x_freeze_disabled, token_x_mcap, token_x_liquidity, token_x_created_at,
      token_y_symbol, token_y_is_sol,
      token_volatility_24h, token_price_change_24h, volume_vs_7d_avg,
      token_num_buys_5m, token_num_sells_5m, token_buy_sell_ratio_5m,
      bin_range_width, bin_lower, bin_upper, bin_center_distance, is_out_of_range, fee_per_tvl_24h,
      capital_usd, hour_of_day, day_of_week,
      wallet_score_at_entry, wallet_wr_at_entry,
      wallet_pnl_at_entry, wallet_position_count_at_entry,
      wallet_is_top_at_entry, wallet_is_tracked_at_entry,
      wallet_recent_wr_30d, wallet_recent_fee_yield_30d,
      wallet_recent_pnl_30d, wallet_recent_position_count_30d,
      wallet_activity_span_days, wallet_unique_pools_traded,
      wallet_discovery_source, wallet_discovered_at, wallet_position_index,
      created_at
) VALUES (
      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,?,
      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,      ?,?
    )
  `).run(
    rec.position_id,
    rec.wallet_address || null,
    rec.pool_address || null,
    rec.entry_timestamp ?? null,
    rec.close_timestamp ?? null,
    rec.was_profitable ?? null,
    rec.pnl_usd ?? null,
    rec.pnl_pct ?? null,
    rec.pnl_sol ?? null,
    rec.pnl_sol_pct ?? null,
    rec.fee_earned_usd ?? null,
    rec.fee_yield ?? null,
    rec.duration_hours ?? null,
    rec.pool_fee_apr ?? null,
    rec.pool_apr ?? null,
    rec.pool_apy ?? null,
    rec.pool_volume_24h ?? null,
    rec.pool_tvl ?? null,
    rec.fee_tvl_ratio ?? null,
    rec.pool_bin_step ?? null,
    rec.pool_launchpad ?? null,
    rec.pool_has_farm ?? null,
    rec.pool_farm_apr ?? null,
    rec.pool_dynamic_fee_pct ?? null,
    rec.pool_current_price ?? null,
    rec.token_pair ?? null,
    rec.token_pair_base_mint ?? null,
    rec.token_pair_quote_mint ?? null,
    rec.days_since_pool_created ?? null,
    rec.pool_token_x_age_hours ?? null,
    rec.token_x_symbol ?? null,
    rec.token_x_market_cap ?? null,
    rec.token_x_fdv ?? null,
    rec.token_x_holders ?? null,
    rec.token_x_organic_score ?? null,
    rec.token_x_is_verified ?? null,
    rec.token_x_freeze_disabled ?? null,
    rec.token_x_mcap ?? null,
    rec.token_x_liquidity ?? null,
    rec.token_x_created_at ?? null,
    rec.token_y_symbol ?? null,
    rec.token_y_is_sol ?? null,
    rec.token_volatility_24h ?? null,
    rec.token_price_change_24h ?? null,
    rec.volume_vs_7d_avg ?? null,
    rec.token_num_buys_5m ?? null,
    rec.token_num_sells_5m ?? null,
    rec.token_buy_sell_ratio_5m ?? null,
    rec.bin_range_width ?? null,
    rec.bin_lower ?? null,
    rec.bin_upper ?? null,
    rec.bin_center_distance ?? null,
    rec.is_out_of_range ?? null,
    rec.fee_per_tvl_24h ?? null,
    rec.capital_usd ?? null,
    rec.hour_of_day ?? null,
    rec.day_of_week ?? null,
    rec.wallet_score_at_entry ?? null,
    rec.wallet_wr_at_entry ?? null,
    rec.wallet_pnl_at_entry ?? null,
    rec.wallet_position_count_at_entry ?? null,
    rec.wallet_is_top_at_entry ?? null,
    rec.wallet_is_tracked_at_entry ?? null,
    rec.wallet_recent_wr_30d ?? null,
    rec.wallet_recent_fee_yield_30d ?? null,
    rec.wallet_recent_pnl_30d ?? null,
    rec.wallet_recent_position_count_30d ?? null,
    rec.wallet_activity_span_days ?? null,
    rec.wallet_unique_pools_traded ?? null,
    rec.wallet_discovery_source ?? null,
    rec.wallet_discovered_at ?? null,
    rec.wallet_position_index ?? null,
    nowSec(),
  );
}

export function markExported(ids) {
  if (!Array.isArray(ids) || !ids.length) return { changes: 0 };
  const placeholders = ids.map(() => '?').join(',');
  return getDb().prepare(`UPDATE training_records SET exported_at = ? WHERE id IN (${placeholders})`).run(nowSec(), ...ids);
}

export function listUnexported(limit = 1000) {
  return getDb().prepare(`SELECT * FROM training_records WHERE exported_at IS NULL ORDER BY created_at ASC LIMIT ?`).all(limit);
}

export function listAllTrainingRecords(filter = {}, opts = {}) {
  const where = [];
  const params = [];
  if (filter.wallet_address) { where.push('wallet_address = ?'); params.push(filter.wallet_address); }
  if (filter.pool_address) { where.push('pool_address = ?'); params.push(filter.pool_address); }
  if (filter.was_profitable !== undefined) { where.push('was_profitable = ?'); params.push(filter.was_profitable ? 1 : 0); }
  const limit = opts.limit ? `LIMIT ${Number(opts.limit)}` : '';
  const sql = `SELECT * FROM training_records ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC ${limit}`;
  return getDb().prepare(sql).all(...params);
}

export function countTrainingRecords() {
  return getDb().prepare(`SELECT COUNT(*) AS n FROM training_records`).get().n;
}