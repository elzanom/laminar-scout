#!/usr/bin/env node
// Backfill positions.bin_lower / bin_upper / bin_range_width from on-chain position account data.
// Uses Solana RPC getMultipleAccountsInfo (batch 100/request) — much faster than per-mint calls.
//
// Cost: 1 RPC call per ~100 positions. For 3157 positions with null bin info, ~32 calls.
//
// Usage:
//   node scripts/backfill-bin-info.js [--batch 100] [--concurrency 3]

import { Connection, PublicKey } from '@solana/web3.js';
import { openDb, getDb } from '../src/db/index.js';
import { getConfig, reloadConfig } from '../src/config/config.js';
import { POSITION_V2 } from '../src/constants.js';
import { log, logAction } from '../src/utils/logger.js';

function parseArgs(argv) {
  const args = { batch: 100, concurrency: 3, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--batch') args.batch = Number(argv[++i]);
    else if (argv[i] === '--concurrency') args.concurrency = Number(argv[++i]);
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node scripts/backfill-bin-info.js [--batch 100] [--concurrency 3] [--dry-run]');
      process.exit(0);
    }
  }
  return args;
}

function decodeBinIds(dataBytes) {
  if (!dataBytes || dataBytes.length < POSITION_V2.OFFSET_UPPER_BIN_ID + 4) return null;
  try {
    const dv = new DataView(dataBytes.buffer, dataBytes.byteOffset, dataBytes.byteLength);
    return {
      bin_lower: dv.getInt32(POSITION_V2.OFFSET_LOWER_BIN_ID, true),
      bin_upper: dv.getInt32(POSITION_V2.OFFSET_UPPER_BIN_ID, true),
    };
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  reloadConfig();
  const cfg = getConfig();
  openDb();
  const db = getDb();

  console.log('=== backfill positions.bin_lower / bin_upper / bin_range_width ===\n');
  console.log(`rpc url:    ${cfg.helius.rpcUrl ? cfg.helius.rpcUrl.slice(0, 60) + '…' : '(unset)'}`);
  console.log(`batch:      ${args.batch}`);
  console.log(`concurrency:${args.concurrency}`);
  console.log(`dry-run:    ${args.dryRun}\n`);

  if (!cfg.helius.rpcUrl) {
    console.error('✗ HELIUS_RPC_URL not set in .env');
    process.exit(1);
  }

  const conn = new Connection(cfg.helius.rpcUrl, 'confirmed');

  const positions = db.prepare(`
    SELECT id, position_mint
    FROM positions
    WHERE status = 'closed'
      AND bin_lower IS NULL
      AND position_mint IS NOT NULL
  `).all();
  console.log(`positions needing bin info: ${positions.length}`);
  if (positions.length === 0) { console.log('(nothing to do)'); return; }

  const stats = { updated: 0, failed: 0, skipped: 0, rpc_calls: 0 };
  const t0 = Date.now();

  const queue = [...positions];
  async function worker(id) {
    while (queue.length) {
      const batch = queue.splice(0, args.batch);
      if (!batch.length) break;
      const mints = batch.map((b) => new PublicKey(b.position_mint));
      try {
        const infos = await conn.getMultipleAccountsInfo(mints);
        stats.rpc_calls += 1;
        const updates = [];
        for (let i = 0; i < batch.length; i++) {
          const p = batch[i];
          const info = infos[i];
          if (!info) { stats.skipped += 1; continue; }
          const decoded = decodeBinIds(info.data);
          if (!decoded) { stats.skipped += 1; continue; }
          const { bin_lower, bin_upper } = decoded;
          const bin_range_width = Math.max(0, bin_upper - bin_lower + 1);
          updates.push({ id: p.id, bin_lower, bin_upper, bin_range_width });
        }
        if (!args.dryRun && updates.length) {
          const stmt = db.prepare(`UPDATE positions SET bin_lower = ?, bin_upper = ?, bin_range_width = ? WHERE id = ?`);
          const tx = db.transaction(() => {
            for (const u of updates) stmt.run(u.bin_lower, u.bin_upper, u.bin_range_width, u.id);
          });
          tx();
          stats.updated += updates.length;
        } else if (updates.length) {
          stats.updated += updates.length;
        }
      } catch (err) {
        stats.failed += batch.length;
        if (stats.failed < 50) log('warn', 'backfill-bin-info: batch failed', { error: err.message });
      }
      if (stats.rpc_calls % 5 === 0) {
        console.log(`  worker ${id}: rpc_calls=${stats.rpc_calls}, updated=${stats.updated}, failed=${stats.failed}, remaining=${queue.length}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const workers = Array.from({ length: args.concurrency }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const remaining = db.prepare(`SELECT COUNT(*) AS n FROM positions WHERE status='closed' AND bin_lower IS NULL`).get().n;

  console.log('\n=== results ===');
  console.log(`elapsed:        ${elapsed}s`);
  console.log(`rpc calls:      ${stats.rpc_calls}`);
  console.log(`updated:        ${stats.updated}`);
  console.log(`failed:         ${stats.failed}`);
  console.log(`skipped:        ${stats.skipped}`);
  console.log(`remaining null: ${remaining}`);

  if (args.dryRun) console.log('(dry run — no DB writes)');
  if (!args.dryRun) logAction('backfill.bin_info', { ...stats, remaining, elapsed_s: Number(elapsed) });
  console.log('\nnext: node scripts/build-dataset.js --limit 5000 && node scripts/export-dataset.js');
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });