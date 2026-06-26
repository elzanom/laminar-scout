#!/usr/bin/env node
// Run all smoke tests + dataset-stats + dataset-validate in sequence.
// Exits with non-zero code if any check fails.
//
// Usage: node scripts/test-all.js [--skip <name>] [--only <name>]
//   --skip smoke-db      skip a specific check
//   --only smoke-db      only run specific check(s)

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CHECKS = [
  { name: 'smoke-db',          script: 'scripts/smoke-db.js',          desc: 'DB CRUD smoke' },
  { name: 'smoke-tx-parser',   script: 'scripts/smoke-tx-parser.js',   desc: 'TX parser smoke' },
  { name: 'smoke-pool',        script: 'scripts/smoke-pool-screener.js',desc: 'Pool screener smoke' },
  { name: 'smoke-discovery',   script: 'scripts/smoke-discovery.js',   desc: 'Discovery engine smoke' },
  { name: 'smoke-step5',       script: 'scripts/smoke-step5.js',       desc: 'Signal/dataset smoke' },
  { name: 'dataset-stats',     script: 'scripts/dataset-stats.js',     desc: 'Dataset coverage report' },
  { name: 'dataset-validate',  script: 'scripts/dataset-validate.js',  desc: 'Dataset data quality' },
];

function parseArgs(argv) {
  const args = { skip: new Set(), only: new Set() };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--skip') args.skip.add(argv[++i]);
    else if (argv[i] === '--only') {
      do { args.only.add(argv[++i]); } while (i + 1 < argv.length && !argv[i + 1].startsWith('--'));
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node scripts/test-all.js [--skip <name>] [--only <name>]');
      process.exit(0);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const checks = CHECKS.filter(c => {
    if (args.only.size > 0 && !args.only.has(c.name)) return false;
    if (args.skip.has(c.name)) return false;
    return true;
  });

  console.log('▶ laminar-scout test suite');
  console.log(`  ${checks.length} checks`);
  console.log();

  const start = Date.now();
  const results = [];

  for (const c of checks) {
    process.stdout.write(`  ${c.name.padEnd(20)} `);
    const t0 = Date.now();
    const r = spawnSync('node', [c.script], { cwd: path.resolve(__dirname, '..'), stdio: 'pipe' });
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const passed = r.status === 0;
    results.push({ name: c.name, passed, dt, stderr: r.stderr?.toString() || '' });
    console.log(`${passed ? '✓' : '✗'} ${dt}s${passed ? '' : ' — exit ' + r.status}`);
  }

  const totalDt = ((Date.now() - start) / 1000).toFixed(1);
  const passed = results.filter(r => r.passed).length;
  const failed = results.length - passed;

  console.log();
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  ${passed} passed, ${failed} failed in ${totalDt}s`);
  console.log('══════════════════════════════════════════════════════════════');

  if (failed > 0) {
    console.log();
    console.log('Failures:');
    for (const r of results) {
      if (!r.passed) {
        console.log(`  ✗ ${r.name}`);
        if (r.stderr) {
          const lines = r.stderr.split('\n').filter(l => l.trim()).slice(-3);
          for (const l of lines) console.log(`      ${l}`);
        }
      }
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });