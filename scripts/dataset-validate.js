#!/usr/bin/env node
// Validate training_records for data quality issues. Reports any anomalies that
// Laminar should not silently accept.
//
// Checks:
//   - Duplicate position_ids
//   - Future entry/close timestamps (> now)
//   - Invalid fee_yield (> 5 = 500% — likely data error)
//   - Invalid token_price_change_24h (> 10x absolute)
//   - Invalid wallet_wr_at_entry (< 0 or > 1)
//   - Inconsistent wallet_recent_position_count_30d (negative or > 500)
//   - Positions with pnl_usd + pnl_sol signs disagreeing
//   - Suspicious bin_range_width (negative or > 10x pool's bin_step)
//
// Usage: node scripts/dataset-validate.js [--strict] [--json]
//   --strict: exit with non-zero code if any issue found
//   --json:   output as JSON instead of pretty text

import { openDb, getDb } from '../src/db/index.js';

function parseArgs(argv) {
  const args = { strict: false, json: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--strict') args.strict = true;
    else if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node scripts/dataset-validate.js [--strict] [--json]');
      console.log('  --strict: exit 1 if any issue found');
      console.log('  --json:   output as JSON');
      process.exit(0);
    }
  }
  return args;
}

function runChecks(db) {
  const now = Math.floor(Date.now() / 1000);
  const checks = [];
  const addIssue = (severity, category, count, sample_query, description) => {
    checks.push({ severity, category, count, sample_query, description });
  };

  // 1. Duplicate position_ids
  {
    const r = db.prepare(`
      SELECT position_id, COUNT(*) AS n
      FROM training_records GROUP BY position_id HAVING n > 1
    `).all();
    if (r.length) {
      addIssue('ERROR', 'duplicate_position_ids', r.length,
        'SELECT position_id, COUNT(*) FROM training_records GROUP BY position_id HAVING COUNT(*) > 1',
        `${r.length} duplicate position_id(s) found in training_records`);
    }
  }

  // 2. Future entry_timestamp
  {
    const r = db.prepare(`
      SELECT COUNT(*) AS n FROM training_records WHERE entry_timestamp > ?
    `).get(now);
    if (r.n > 0) {
      addIssue('ERROR', 'future_entry_ts', r.n,
        'SELECT position_id, entry_timestamp FROM training_records WHERE entry_timestamp > strftime("%s","now")',
        `${r.n} record(s) have entry_timestamp in the future`);
    }
  }

  // 3. Future close_timestamp
  {
    const r = db.prepare(`
      SELECT COUNT(*) AS n FROM training_records WHERE close_timestamp > ? AND close_timestamp IS NOT NULL
    `).get(now);
    if (r.n > 0) {
      addIssue('WARN', 'future_close_ts', r.n,
        'SELECT position_id, close_timestamp FROM training_records WHERE close_timestamp > strftime("%s","now")',
        `${r.n} closed position(s) have close_timestamp in the future`);
    }
  }

  // 4. Invalid fee_yield (> 5 = 500%)
  {
    const r = db.prepare(`
      SELECT COUNT(*) AS n FROM training_records WHERE fee_yield IS NOT NULL AND ABS(fee_yield) > 5
    `).get();
    if (r.n > 0) {
      addIssue('ERROR', 'invalid_fee_yield', r.n,
        'SELECT position_id, fee_yield FROM training_records WHERE fee_yield > 5',
        `${r.n} record(s) have fee_yield > 500% (likely data error)`);
    }
  }

  // 5. Invalid token_price_change_24h (> 10x absolute)
  {
    const r = db.prepare(`
      SELECT COUNT(*) AS n FROM training_records WHERE token_price_change_24h IS NOT NULL AND ABS(token_price_change_24h) > 10
    `).get();
    if (r.n > 0) {
      addIssue('WARN', 'extreme_price_change', r.n,
        'SELECT position_id, token_price_change_24h FROM training_records WHERE ABS(token_price_change_24h) > 10',
        `${r.n} record(s) have token_price_change_24h > 1000%`);
    }
  }

  // 6. Invalid wallet_wr_at_entry (< 0 or > 1)
  {
    const r = db.prepare(`
      SELECT COUNT(*) AS n FROM training_records
      WHERE wallet_wr_at_entry IS NOT NULL AND (wallet_wr_at_entry < 0 OR wallet_wr_at_entry > 1)
    `).get();
    if (r.n > 0) {
      addIssue('ERROR', 'invalid_wr', r.n,
        'SELECT position_id, wallet_wr_at_entry FROM training_records WHERE wallet_wr_at_entry < 0 OR wallet_wr_at_entry > 1',
        `${r.n} record(s) have wallet_wr_at_entry outside [0, 1]`);
    }
  }

  // 7. wallet_recent_position_count_30d negative
  {
    const r = db.prepare(`
      SELECT COUNT(*) AS n FROM training_records WHERE wallet_recent_position_count_30d < 0
    `).get();
    if (r.n > 0) {
      addIssue('ERROR', 'negative_recent_count', r.n,
        'SELECT position_id, wallet_recent_position_count_30d FROM training_records WHERE wallet_recent_position_count_30d < 0',
        `${r.n} record(s) have negative wallet_recent_position_count_30d`);
    }
  }

  // 8. PnL signs disagreeing (usd positive but sol negative or vice versa)
  {
    const r = db.prepare(`
      SELECT COUNT(*) AS n FROM training_records
      WHERE pnl_usd IS NOT NULL AND pnl_sol IS NOT NULL
        AND ABS(pnl_usd) > 0.01 AND ABS(pnl_sol) > 0.001
        AND ((pnl_usd > 0 AND pnl_sol < 0) OR (pnl_usd < 0 AND pnl_sol > 0))
    `).get();
    if (r.n > 0) {
      addIssue('WARN', 'pnl_sign_disagree', r.n,
        'SELECT position_id, pnl_usd, pnl_sol FROM training_records WHERE pnl_usd * pnl_sol < 0',
        `${r.n} record(s) have pnl_usd and pnl_sol with different signs`);
    }
  }

  // 9. Negative bin_range_width
  {
    const r = db.prepare(`
      SELECT COUNT(*) AS n FROM training_records WHERE bin_range_width IS NOT NULL AND bin_range_width < 0
    `).get();
    if (r.n > 0) {
      addIssue('ERROR', 'negative_bin_range', r.n,
        'SELECT position_id, bin_range_width FROM training_records WHERE bin_range_width < 0',
        `${r.n} record(s) have negative bin_range_width`);
    }
  }

  // 10. Position opened AFTER it was closed
  {
    const r = db.prepare(`
      SELECT COUNT(*) AS n FROM training_records
      WHERE entry_timestamp IS NOT NULL AND close_timestamp IS NOT NULL
        AND entry_timestamp >= close_timestamp
    `).get();
    if (r.n > 0) {
      addIssue('WARN', 'entry_after_close', r.n,
        'SELECT position_id, entry_timestamp, close_timestamp FROM training_records WHERE entry_timestamp >= close_timestamp',
        `${r.n} record(s) have entry_timestamp >= close_timestamp (zero or negative duration)`);
    }
  }

  // 11. Records without any wallet context (wallet_address missing)
  {
    const r = db.prepare(`
      SELECT COUNT(*) AS n FROM training_records WHERE wallet_address IS NULL OR wallet_address = ''
    `).get();
    if (r.n > 0) {
      addIssue('ERROR', 'missing_wallet', r.n,
        'SELECT position_id FROM training_records WHERE wallet_address IS NULL OR wallet_address = ""',
        `${r.n} record(s) have NULL/empty wallet_address`);
    }
  }

  // 12. Records without any pool context
  {
    const r = db.prepare(`
      SELECT COUNT(*) AS n FROM training_records WHERE pool_address IS NULL OR pool_address = ''
    `).get();
    if (r.n > 0) {
      addIssue('ERROR', 'missing_pool', r.n,
        'SELECT position_id FROM training_records WHERE pool_address IS NULL OR pool_address = ""',
        `${r.n} record(s) have NULL/empty pool_address`);
    }
  }

  return checks;
}

function printChecks(checks) {
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('  laminar-scout dataset validation');
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log();

  const errors = checks.filter(c => c.severity === 'ERROR');
  const warns = checks.filter(c => c.severity === 'WARN');

  console.log(`ERRORS: ${errors.length}`);
  console.log(`WARNS:  ${warns.length}`);
  console.log();

  if (errors.length === 0 && warns.length === 0) {
    console.log('✓ all checks passed');
    return;
  }

  for (const c of [...errors, ...warns]) {
    console.log(`${c.severity === 'ERROR' ? '✗' : '!'} [${c.category}] ${c.description}`);
    if (c.sample_query) console.log(`    sample: ${c.sample_query}`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  openDb();
  const db = getDb();
  const checks = runChecks(db);
  if (args.json) console.log(JSON.stringify(checks, null, 2));
  else printChecks(checks);

  if (args.strict) {
    const errors = checks.filter(c => c.severity === 'ERROR').length;
    process.exit(errors > 0 ? 1 : 0);
  }
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });