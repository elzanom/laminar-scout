#!/usr/bin/env node
// Manually trigger learning cycle + export for vipera/laminar consumption.
//
// Usage:
//   node scripts/export-learning.js                  # full cycle + export
//   node scripts/export-learning.js --dry-run        # cycle only, no DB writes
//   node scripts/export-learning.js --export-only    # skip cycle, just export
//   node scripts/export-learning.js --dir ./exports # custom output dir

import { openDb, getDb } from '../src/db/index.js';
import { runLearningCycle } from '../src/learning/cron.js';
import { exportAll, exportLessons, exportPoolCooldowns, exportPerformanceSnapshot } from '../src/learning/exporter.js';

function parseArgs(argv) {
  const args = { dryRun: false, exportOnly: false, dir: null, limit: 500 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--export-only') args.exportOnly = true;
    else if (argv[i] === '--dir') args.dir = String(argv[++i] || '');
    else if (argv[i] === '--limit') args.limit = Number(argv[++i] || 500);
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node scripts/export-learning.js [--dry-run] [--export-only] [--dir <path>] [--limit N]');
      process.exit(0);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  console.log('=== laminar-scout learning export ===\n');

  if (!args.exportOnly) {
    console.log('Step 1: running learning cycle', args.dryRun ? '(DRY RUN)' : '');
    openDb();
    const cycleResult = await runLearningCycle({ dryRun: args.dryRun });
    console.log(JSON.stringify(cycleResult, null, 2));
    console.log('');
  } else {
    console.log('Step 1: skipped (--export-only)');
    console.log('');
  }

  console.log('Step 2: exporting lessons + cooldowns + performance to vipera-compatible JSON');
  const result = exportAll({ limit: args.limit, outputDir: args.dir });
  console.log(JSON.stringify(result, null, 2));
  console.log('');

  console.log('=== summary ===');
  console.log('manifest:', result.manifest);
  console.log('files:');
  console.log('  - lessons.json         (' + result.counts.lessons + ' lessons)');
  console.log('  - pool-cooldowns.json  (' + result.counts.cooldowns + ' pools)');
  console.log('  - performance.json     (' + result.counts.performance + ' positions)');
  console.log('');
  console.log('To consume from vipera:');
  console.log('  cp learning-exports/lessons.json vipera/lessons.json');
  console.log('  (merge scout lessons into vipera lessons.json — they have sourceType="scout_learning")');
  console.log('');
  console.log('To consume from laminar:');
  console.log('  Read pool-cooldowns.json to skip bad pools in discovery');
  console.log('  Read performance.json for ML training (mirrors dataset CSV)');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});