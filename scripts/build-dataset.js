#!/usr/bin/env node
// Generate TrainingRecord rows from existing closed positions in the DB.
// Usage:
//   node scripts/build-dataset.js                # all closed positions, all wallets
//   node scripts/build-dataset.js --wallet <addr>   # only one wallet
//   node scripts/build-dataset.js --limit 200    # cap how many records to build per run
//
// What it does:
//   For each closed position in the DB, calls record-builder.buildTrainingRecordFromPosition,
//   which fetches pool meta from Meteora + nearest market_snapshot (if any) + wallet state.
//   Persists to training_records table (idempotent: insertTrainingRecord is INSERT OR IGNORE
//   on position_id).

import { openDb } from '../src/db/index.js';
import { listPositions } from '../src/db/positions.js';
import { insertTrainingRecord, countTrainingRecords } from '../src/db/training-records.js';
import { buildTrainingRecordFromPosition } from '../src/dataset/record-builder.js';
import { log } from '../src/utils/logger.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--wallet') args.wallet = argv[++i];
    else if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node scripts/build-dataset.js [--wallet <addr>] [--limit N]');
      process.exit(0);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  openDb();

  console.log('=== build training records from closed positions ===');
  console.log(`existing training_records: ${countTrainingRecords()}`);

  const filter = { status: 'closed' };
  if (args.wallet) filter.wallet_address = args.wallet;
  const allClosed = listPositions(filter, { limit: 5000 });
  const limit = args.limit || allClosed.length;
  const toProcess = allClosed.slice(0, limit);

  console.log(`closed positions in DB: ${allClosed.length}`);
  console.log(`processing: ${toProcess.length}`);
  console.log();

  let inserted = 0;
  let skipped = 0;
  let failed = 0;
  let byPair = {};
  let byYear = {};

  for (let i = 0; i < toProcess.length; i++) {
    const p = toProcess[i];
    try {
      const rec = await buildTrainingRecordFromPosition(p);
      if (!rec) { skipped += 1; continue; }
      insertTrainingRecord(rec);
      inserted += 1;

      const pair = rec.token_pair || 'unknown';
      byPair[pair] = (byPair[pair] || 0) + 1;
      const year = rec.entry_timestamp ? new Date(rec.entry_timestamp * 1000).getUTCFullYear() : 'unknown';
      byYear[year] = (byYear[year] || 0) + 1;
    } catch (err) {
      failed += 1;
      if (failed < 5) log('warn', 'build-dataset: failed', { position_id: p.id, error: err.message });
    }
    if ((i + 1) % 100 === 0) console.log(`  ...${i + 1}/${toProcess.length} (inserted=${inserted}, skipped=${skipped}, failed=${failed})`);
  }

  console.log();
  console.log(`done. inserted=${inserted}, skipped=${skipped}, failed=${failed}`);
  console.log(`total training_records now: ${countTrainingRecords()}`);
  console.log();
  console.log('by token_pair (top 10):');
  Object.entries(byPair).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([k, v]) => console.log(`  ${k.padEnd(20)} ${v}`));
  console.log();
  console.log('by entry year:');
  Object.entries(byYear).sort().forEach(([k, v]) => console.log(`  ${k}  ${v}`));

  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});