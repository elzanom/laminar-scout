#!/usr/bin/env node
// One-shot full dataset rebuild:
//   1. build-dataset   (DELETE + INSERT from positions + Meteora pool-meta)
//   2. backfill-meteora-summary  (organic_score, fdv fallback)
//   3. backfill-dexscreener       (price_change_24h, fdv fallback)
//   4. backfill-jupiter            (mcap, liquidity, organic, verified, stats5m)
//   5. backfill-pool-launchpad     (re-fetch launchpad for NULL pools)
//   6. export-dataset              (→ dataset/training-records.csv)
//
// This ordering matters: build-dataset wipes training_records, so all subsequent
// backfills must run AFTER it. This script enforces that.
//
// Usage:
//   node scripts/rebuild-all.js [--limit 5000] [--jupiter-rate 1.5]
//                                 [--skip-jupiter] [--skip-dexscreener]

import { spawnSync } from 'node:child_process';

function parseArgs(argv) {
  const args = { limit: 5000, jupiterRate: 1.5, skipJupiter: false, skipDexscreener: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else if (argv[i] === '--jupiter-rate') args.jupiterRate = Number(argv[++i]);
    else if (argv[i] === '--skip-jupiter') args.skipJupiter = true;
    else if (argv[i] === '--skip-dexscreener') args.skipDexscreener = true;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node scripts/rebuild-all.js [--limit N] [--jupiter-rate SEC] [--skip-jupiter] [--skip-dexscreener]');
      process.exit(0);
    }
  }
  return args;
}

function runScript(scriptName, args = []) {
  const start = Date.now();
  console.log(`\n▶ running ${scriptName} ${args.join(' ')}`);
  const r = spawnSync('node', ['scripts/' + scriptName, ...args], { stdio: 'inherit' });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  if (r.status !== 0) {
    console.error(`\n✗ ${scriptName} failed with exit code ${r.status} after ${elapsed}s`);
    process.exit(r.status || 1);
  }
  console.log(`  ✓ done in ${elapsed}s`);
}

async function main() {
  const args = parseArgs(process.argv);
  console.log('=== laminar-scout full dataset rebuild ===');
  console.log(`limit:              ${args.limit}`);
  console.log(`jupiter rate:       ${args.jupiterRate}s/request`);
  console.log(`skip jupiter:       ${args.skipJupiter}`);
  console.log(`skip dexscreener:   ${args.skipDexscreener}`);

  const totalStart = Date.now();

  runScript('build-dataset.js', ['--limit', String(args.limit)]);
  runScript('backfill-meteora-summary.js');
  if (!args.skipDexscreener) {
    runScript('backfill-dexscreener.js', ['--rate', '0.15']);
  } else {
    console.log('\n  skipping dexscreener (--skip-dexscreener)');
  }
  if (!args.skipJupiter) {
    runScript('backfill-jupiter.js', ['--rate', String(args.jupiterRate), '--concurrency', '1']);
  } else {
    console.log('\n  skipping jupiter (--skip-jupiter)');
  }
  runScript('backfill-pool-launchpad.js', ['--rate', '0.3']);
  // Always export all records (override the default limit) and use --include-exported so
  // a previous partial export doesn't skip rows.
  runScript('export-dataset.js', ['--limit', '10000', '--include-exported']);

  const totalElapsed = ((Date.now() - totalStart) / 1000).toFixed(1);
  console.log(`\n=== rebuild complete in ${totalElapsed}s ===`);
  console.log('Verify:  node scripts/dataset-stats.js');
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });