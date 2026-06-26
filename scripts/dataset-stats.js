#!/usr/bin/env node
// Print comprehensive dataset statistics for monitoring + documentation.
// Coverage by field, label distribution, value ranges, wallet stats.
// Usage: node scripts/dataset-stats.js [--json] [--field COLUMN]

import { openDb, getDb } from '../src/db/index.js';

function parseArgs(argv) {
  const args = { json: false, field: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--field') args.field = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node scripts/dataset-stats.js [--json] [--field COLUMN]');
      process.exit(0);
    }
  }
  return args;
}

function bar(pct, width = 30) {
  return '█'.repeat(Math.round(pct / 100 * width)).padEnd(width, '·');
}

function fmtNum(v) {
  if (v == null) return 'null';
  if (typeof v === 'string') return v.length > 30 ? v.slice(0, 27) + '…' : v;
  if (typeof v !== 'number' || !Number.isFinite(v)) return String(v);
  if (Math.abs(v) >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (Math.abs(v) >= 1) return v.toFixed(2);
  return v.toFixed(4);
}

function buildReport(db) {
  const total = db.prepare('SELECT COUNT(*) as n FROM training_records').get().n;
  const labels = {
    profitable: db.prepare('SELECT COUNT(*) as n FROM training_records WHERE was_profitable = 1').get().n,
    loss:       db.prepare('SELECT COUNT(*) as n FROM training_records WHERE was_profitable = 0').get().n,
    null_label: db.prepare('SELECT COUNT(*) as n FROM training_records WHERE was_profitable IS NULL').get().n,
  };

  const coverageFields = [
    'token_pair','pool_bin_step',    'token_x_market_cap','token_x_holders','token_x_fdv','token_x_mcap',
    'token_x_liquidity','token_x_is_verified','token_x_created_at','token_x_organic_score',
    'token_x_total_supply',
    'token_price_change_24h','token_volatility_24h','token_num_buys_5m','token_num_sells_5m',
    'token_buy_sell_ratio_5m','token_y_total_supply',
    'pool_launchpad','pool_current_price','pool_dynamic_fee_pct',
    'pool_token_x_age_hours','pool_volume_24h','fee_tvl_ratio','pool_fee_apr','pool_apr','pool_apy',
    'bin_lower','bin_upper','bin_center_distance','bin_range_width','is_out_of_range',
    'fee_per_tvl_24h','pnl_usd','pnl_sol','pnl_pct','duration_hours','fee_yield','fee_earned_usd',
    'capital_usd','wallet_score_at_entry','wallet_wr_at_entry','wallet_pnl_at_entry',
    'wallet_position_count_at_entry','wallet_is_top_at_entry','wallet_is_tracked_at_entry',
    'wallet_recent_wr_30d','wallet_recent_fee_yield_30d','wallet_recent_pnl_30d',
    'wallet_recent_position_count_30d','wallet_activity_span_days','wallet_unique_pools_traded',
    'wallet_prior_pnl_usd','wallet_prior_fees_usd','wallet_prior_capital_usd',
    'wallet_prior_position_count','wallet_prior_win_rate','wallet_prior_wins','wallet_prior_losses',
    'wallet_pool_revisit_count','wallet_pool_revisit_pnl_usd','wallet_pool_revisit_wr',
    'wallet_pool_revisit_fees_usd','is_first_in_pool','position_in_pool_count',
    'wallet_discovered_at','wallet_discovery_source','wallet_position_index',
  ];
  const coverage = {};
  for (const c of coverageFields) {
    const row = db.prepare(`SELECT
      COUNT(*) as n,
      COUNT(${c}) as nonnull,
      AVG(${c}) as avg_v,
      MIN(${c}) as min_v,
      MAX(${c}) as max_v
    FROM training_records WHERE ${c} IS NOT NULL AND ${c} != ''`).get();
    coverage[c] = {
      count: row.nonnull,
      pct: total ? (row.nonnull / total * 100).toFixed(1) : 0,
      avg: row.avg_v,
      min: row.min_v,
      max: row.max_v,
    };
  }

  const launchpadDist = db.prepare(`
    SELECT COALESCE(pool_launchpad, '(null)') AS lp, COUNT(*) AS n
    FROM training_records GROUP BY pool_launchpad ORDER BY n DESC
  `).all();

  const walletTierDist = db.prepare(`
    SELECT
      COALESCE(wallet_is_top_at_entry, -1) AS tier,
      COUNT(*) AS n
    FROM training_records GROUP BY wallet_is_top_at_entry ORDER BY n DESC
  `).all();

  const poolsCount = db.prepare(`SELECT COUNT(DISTINCT pool_address) as n FROM training_records`).get().n;
  const walletsCount = db.prepare(`SELECT COUNT(DISTINCT wallet_address) as n FROM training_records`).get().n;

  return { total, poolsCount, walletsCount, labels, coverage, launchpadDist, walletTierDist };
}

function printReport(r) {
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('  laminar-scout dataset statistics');
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log();
  console.log(`Total training records:     ${r.total}`);
  console.log(`Distinct pools:             ${r.poolsCount}`);
  console.log(`Distinct wallets:           ${r.walletsCount}`);
  console.log();
  console.log('Label distribution:');
  const lp = r.labels;
  console.log(`  profitable (was_profitable=1):   ${lp.profitable}  (${(lp.profitable/r.total*100).toFixed(1)}%)`);
  console.log(`  loss (was_profitable=0):         ${lp.loss}        (${(lp.loss/r.total*100).toFixed(1)}%)`);
  if (lp.null_label) console.log(`  null:                            ${lp.null_label}`);
  console.log();
  console.log('Wallet tier at entry:');
  for (const t of r.walletTierDist) {
    const tierLabel = t.tier === 1 ? 'top' : t.tier === 0 ? 'tracked' : t.tier === -1 ? '(null)' : 'unknown';
    console.log(`  tier=${t.tier} (${tierLabel.padEnd(8)}): ${t.n}  (${(t.n/r.total*100).toFixed(1)}%)`);
  }
  console.log();
  console.log('Pool launchpad distribution:');
  for (const p of r.launchpadDist) {
    const pct = (p.n / r.total * 100).toFixed(1);
    console.log(`  ${p.lp.padEnd(20)} ${String(p.n).padStart(5)}  (${pct.padStart(5)}%) ${bar(pct / Math.max(...r.launchpadDist.map(x => x.n)) * 100, 20)}`);
  }
  console.log();
  console.log('Field coverage (sorted by coverage %):');
  const sorted = Object.entries(r.coverage).sort((a, b) => parseFloat(b[1].pct) - parseFloat(a[1].pct));
  for (const [name, info] of sorted) {
    const pct = parseFloat(info.pct);
    const barShown = pct >= 95 ? '✓' : pct >= 50 ? '~' : pct > 0 ? '!' : '×';
    const examples = (info.avg != null) ? `(avg=${fmtNum(info.avg)}, range=${fmtNum(info.min)}…${fmtNum(info.max)})` : '';
    console.log(`  ${barShown} ${name.padEnd(40)} ${String(info.count).padStart(5)}/${r.total}  (${info.pct.padStart(5)}%) ${bar(pct, 25)} ${examples}`);
  }
  console.log();
  console.log('Legend: ✓ >=95%   ~ >=50%   ! >0%   × null');
}

function printJson(r) {
  console.log(JSON.stringify(r, null, 2));
}

function printField(r, field) {
  if (!r.coverage[field]) {
    console.log(`unknown field: ${field}`);
    console.log('available:', Object.keys(r.coverage).join(', '));
    process.exit(1);
  }
  const info = r.coverage[field];
  console.log(`${field}:`);
  console.log(`  count: ${info.count}/${r.total} (${info.pct}%)`);
  console.log(`  avg:   ${fmtNum(info.avg)}`);
  console.log(`  min:   ${fmtNum(info.min)}`);
  console.log(`  max:   ${fmtNum(info.max)}`);
}

async function main() {
  const args = parseArgs(process.argv);
  openDb();
  const db = getDb();
  const report = buildReport(db);
  if (args.json) printJson(report);
  else if (args.field) printField(report, args.field);
  else printReport(report);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });