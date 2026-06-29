import { getDb } from '../db/index.js';

function _num(v) {
  if (v == null) return null;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
}

function _buildWalletSummary(address) {
  const db = getDb();
  const wallet = db.prepare('SELECT * FROM wallets WHERE address = ?').get(address);
  if (!wallet) return null;

  const positions = db.prepare(`
    SELECT id, pool_address, token_pair, entry_timestamp, exit_timestamp,
           is_profitable, pnl_usd, pnl_sol, fees_earned_usd, duration_hours,
           capital_usd, bin_lower, bin_upper, bin_range_width, is_out_of_range,
           impermanent_loss_usd, impermanent_loss_pct, fee_yield, fee_per_tvl_24h
    FROM positions
    WHERE wallet_address = ?
    ORDER BY entry_timestamp DESC
    LIMIT 200
  `).all(address);

  const closed = positions.filter(p => p.exit_timestamp);
  const open = positions.filter(p => !p.exit_timestamp);
  const wins = closed.filter(p => p.is_profitable === 1).length;
  const losses = closed.length - wins;
  const totalPnl = closed.reduce((a, p) => a + _num(p.pnl_usd) || 0, 0);
  const totalFees = closed.reduce((a, p) => a + _num(p.fees_earned_usd) || 0, 0);
  const totalCapital = closed.reduce((a, p) => a + _num(p.capital_usd) || 0, 0);
  const totalIl = closed.reduce((a, p) => a + _num(p.impermanent_loss_usd) || 0, 0);
  const avgFeeYield = closed.length
    ? closed.reduce((a, p) => a + (_num(p.fee_yield) || 0), 0) / closed.length
    : 0;

  const recentClosed = closed.slice(0, 10).map(p => ({
    pair: p.token_pair,
    pnl_usd: _num(p.pnl_usd),
    fees_usd: _num(p.fees_earned_usd),
    il_usd: _num(p.impermanent_loss_usd),
    duration_hours: _num(p.duration_hours),
    profitable: p.is_profitable === 1,
  }));

  const poolCounts = {};
  for (const p of positions) {
    if (p.pool_address) poolCounts[p.pool_address] = (poolCounts[p.pool_address] || 0) + 1;
  }
  const topPools = Object.entries(poolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([addr, n]) => ({ address: addr, count: n }));

  return {
    wallet: {
      address: wallet.address,
      status: wallet.status,
      score: _num(wallet.score),
      win_rate: _num(wallet.win_rate),
      total_positions: wallet.total_positions || positions.length,
      total_pnl_usd: _num(wallet.total_pnl_usd),
      total_fees_usd: _num(wallet.total_fees_usd),
      avg_fee_yield: _num(wallet.avg_fee_yield),
      unique_pools_traded: wallet.unique_pools_traded || Object.keys(poolCounts).length,
      first_seen: wallet.first_seen,
      last_active: wallet.last_active,
    },
    aggregate: {
      closed_count: closed.length,
      open_count: open.length,
      wins,
      losses,
      win_rate: closed.length ? wins / closed.length : null,
      total_pnl_usd: totalPnl,
      total_fees_usd: totalFees,
      total_capital_usd: totalCapital,
      total_il_usd: totalIl,
      avg_fee_yield: avgFeeYield,
      realized_pnl_after_il_usd: totalPnl + totalIl,
    },
    recent_closed: recentClosed,
    top_pools: topPools,
  };
}

export { _buildWalletSummary as buildWalletSummary };

export function walletSummaryForPrompt(address, { maxPositions = 10, maxPools = 5 } = {}) {
  const s = _buildWalletSummary(address);
  if (!s) return null;
  const lines = [];
  lines.push(`Wallet: ${s.wallet.address}`);
  lines.push(`Status: ${s.wallet.status}, Score: ${s.wallet.score?.toFixed(1) ?? 'n/a'}, Win Rate: ${(s.wallet.win_rate ? (s.wallet.win_rate * 100).toFixed(1) : 'n/a')}%`);
  lines.push(`Total positions: ${s.wallet.total_positions}, Unique pools: ${s.wallet.unique_pools_traded}`);
  lines.push(`Lifetime PnL: $${s.wallet.total_pnl_usd?.toFixed(2) ?? 'n/a'}, Fees earned: $${s.wallet.total_fees_usd?.toFixed(2) ?? 'n/a'}, Avg fee yield: ${(s.wallet.avg_fee_yield ? (s.wallet.avg_fee_yield * 100).toFixed(2) : 'n/a')}%`);
  lines.push('');
  lines.push(`Aggregate stats (from ${s.aggregate.closed_count} closed + ${s.aggregate.open_count} open):`);
  lines.push(`  Wins: ${s.aggregate.wins}, Losses: ${s.aggregate.losses}, WR: ${(s.aggregate.win_rate ? (s.aggregate.win_rate * 100).toFixed(1) : 'n/a')}%`);
  lines.push(`  Total PnL: $${s.aggregate.total_pnl_usd.toFixed(2)}, Fees: $${s.aggregate.total_fees_usd.toFixed(2)}`);
  lines.push(`  Total IL: $${s.aggregate.total_il_usd.toFixed(2)}, Realized PnL after IL: $${s.aggregate.realized_pnl_after_il_usd.toFixed(2)}`);
  lines.push(`  Avg fee yield: ${(s.aggregate.avg_fee_yield * 100).toFixed(2)}%`);
  lines.push('');
  lines.push(`Top pools by position count:`);
  for (const p of s.top_pools) {
    lines.push(`  ${p.address.slice(0, 8)}...${p.address.slice(-4)}: ${p.count} positions`);
  }
  lines.push('');
  lines.push(`Recent ${maxPositions} closed positions:`);
  for (const p of s.recent_closed.slice(0, maxPositions)) {
    lines.push(`  ${p.pair || 'unknown'} | PnL $${p.pnl_usd?.toFixed(2) ?? '?'} | Fees $${p.fees_usd?.toFixed(2) ?? '?'} | IL $${p.il_usd?.toFixed(2) ?? '?'} | ${p.duration_hours?.toFixed(1) ?? '?'}h | ${p.profitable ? 'profit' : 'loss'}`);
  }
  return lines.join('\n');
}