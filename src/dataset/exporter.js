import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as trainingDb from '../db/training-records.js';
import { getConfig } from '../config/config.js';
import { log } from '../utils/logger.js';
import { recordSuccess, recordError, incrCounter } from '../utils/health.js';

const COLUMNS = [
  'id', 'position_id', 'wallet_address', 'pool_address',
  'entry_timestamp', 'close_timestamp',
  'was_profitable', 'pnl_usd', 'pnl_pct', 'pnl_sol', 'pnl_sol_pct',
  'fee_earned_usd', 'fee_yield', 'duration_hours',
  'pool_fee_apr', 'pool_apr', 'pool_apy', 'pool_volume_24h', 'pool_tvl',
  'fee_tvl_ratio', 'pool_bin_step', 'pool_launchpad', 'pool_has_farm', 'pool_farm_apr',
  'pool_dynamic_fee_pct', 'pool_current_price',
  'token_pair', 'token_pair_base_mint', 'token_pair_quote_mint', 'days_since_pool_created', 'pool_token_x_age_hours',
  'token_x_symbol', 'token_x_market_cap', 'token_x_fdv', 'token_x_holders',
  'token_x_organic_score', 'token_x_is_verified', 'token_x_freeze_disabled',
  'token_x_mcap', 'token_x_liquidity', 'token_x_created_at',
  'token_y_symbol', 'token_y_is_sol',
  'token_volatility_24h', 'token_price_change_24h', 'volume_vs_7d_avg',
  'token_num_buys_5m', 'token_num_sells_5m', 'token_buy_sell_ratio_5m',
  'bin_range_width', 'bin_lower', 'bin_upper', 'bin_center_distance',
  'is_out_of_range', 'fee_per_tvl_24h',
  'capital_usd', 'hour_of_day', 'day_of_week',
  'wallet_score_at_entry', 'wallet_wr_at_entry',
  'wallet_pnl_at_entry', 'wallet_position_count_at_entry',
  'wallet_is_top_at_entry', 'wallet_is_tracked_at_entry',
  'wallet_recent_wr_30d', 'wallet_recent_fee_yield_30d',
  'wallet_recent_pnl_30d', 'wallet_recent_position_count_30d',
  'wallet_activity_span_days', 'wallet_unique_pools_traded',
  'wallet_prior_pnl_usd', 'wallet_prior_fees_usd', 'wallet_prior_capital_usd',
  'wallet_prior_position_count', 'wallet_prior_win_rate', 'wallet_prior_wins', 'wallet_prior_losses',
  'wallet_pool_revisit_count', 'wallet_pool_revisit_pnl_usd', 'wallet_pool_revisit_wr', 'wallet_pool_revisit_fees_usd',
  'is_first_in_pool',
  'wallet_discovery_source', 'wallet_discovered_at', 'wallet_position_index',
  'exported_at', 'created_at',
];

function _csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function _toCsv(rows) {
  const header = COLUMNS.join(',');
  const lines = rows.map((r) => COLUMNS.map((c) => _csvEscape(r[c])).join(','));
  return [header, ...lines].join('\n') + '\n';
}

export async function exportUnexported(opts = {}) {
  const cfg = getConfig();
  const format = opts.format || (cfg.dataset?.exportPath?.endsWith('.json') ? 'json' : 'csv');
  const outPath = resolve(opts.path || cfg.dataset?.exportPath || './dataset/training-records.csv');
  const limit = opts.limit || 1000;

  let rows;
  try {
    rows = trainingDb.listUnexported(limit);
  } catch (err) {
    recordError('exporter.list', err);
    return { ok: false, reason: 'list_error', error: err.message };
  }

  if (!rows.length) {
    return { ok: true, count: 0, path: outPath };
  }

  let payload;
  if (format === 'json') {
    payload = JSON.stringify(rows, null, 2);
  } else {
    payload = _toCsv(rows);
  }

  try {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, payload);
  } catch (err) {
    recordError('exporter.write', err, { path: outPath });
    return { ok: false, reason: 'write_error', error: err.message };
  }

  const ids = rows.map((r) => r.id);
  try {
    trainingDb.markExported(ids);
  } catch (err) {
    log('warn', 'exporter: markExported failed', { count: ids.length, error: err.message });
  }

  incrCounter('exporter.exported', rows.length);
  recordSuccess('exporter', { path: outPath, count: rows.length, format });
  return { ok: true, count: rows.length, path: outPath, format, ids };
}

export const _test = { _toCsv, _csvEscape, COLUMNS };