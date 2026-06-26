#!/usr/bin/env node
// Export training records to CSV/JSON for Laminar to consume.
// Usage:
//   node scripts/export-dataset.js                       # uses default path from scout-config.json
//   node scripts/export-dataset.js --path ./x.csv        # custom path
//   node scripts/export-dataset.js --format json         # CSV (default) or JSON
//   node scripts/export-dataset.js --include-exported    # include already-exported rows (re-export)
//
// After export, training_records.exported_at is stamped so the same record is not exported
// again on the next run (use --include-exported to override).

import { openDb } from '../src/db/index.js';
import { exportUnexported } from '../src/dataset/exporter.js';
import { countTrainingRecords, listAllTrainingRecords } from '../src/db/training-records.js';
import { getConfig, reloadConfig } from '../src/config/config.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--path') args.path = argv[++i];
    else if (argv[i] === '--format') args.format = argv[++i];
    else if (argv[i] === '--include-exported') args.includeExported = true;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node scripts/export-dataset.js [--path PATH] [--format csv|json] [--include-exported]');
      process.exit(0);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  reloadConfig();
  openDb();

  const cfg = getConfig();
  console.log('=== export training dataset ===');
  console.log(`total training_records:    ${countTrainingRecords()}`);
  console.log(`default export path:       ${cfg.dataset.exportPath}`);
  console.log(`autoExportOnClose:         ${cfg.dataset.autoExportOnClose}`);
  console.log();

  const all = listAllTrainingRecords({}, { limit: 100000 });
  const unexported = all.filter((r) => !r.exported_at);
  const exported = all.filter((r) => r.exported_at);
  console.log(`unexported:                ${unexported.length}`);
  console.log(`already exported:          ${exported.length}`);
  console.log();

  if (unexported.length === 0 && !args.includeExported) {
    console.log('nothing to export. run scripts/build-dataset.js first.');
    process.exit(0);
  }

  const r = await exportUnexported({ path: args.path, format: args.format });
  if (!r.ok) {
    console.error('export failed:', r.error);
    process.exit(1);
  }
  console.log(`exported ${r.count} records to ${r.path} (format=${r.format})`);
  console.log();
  console.log('Laminar can consume this file directly:');
  console.log(`  python train_laminar.py --input ${r.path}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});