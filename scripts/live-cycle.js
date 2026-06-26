#!/usr/bin/env node
// One-shot live discovery cycle against real Meteora + Solana RPC.
// Usage: node scripts/live-cycle.js [--limit 5] [--evaluate 3]

import { openDb, getDb } from '../src/db/index.js';
import { countWallets, listWallets } from '../src/db/wallets.js';
import { discoverFromTopPools } from '../src/discovery/pool-discovery.js';
import { evaluateWallet } from '../src/discovery/wallet-evaluator.js';
import { getConfig, reloadConfig } from '../src/config/config.js';
import { log, logAction } from '../src/utils/logger.js';
import { recordSuccess, recordError, emitHeartbeat } from '../src/utils/health.js';

function parseArgs(argv) {
  const args = { limit: 5, evaluate: 0 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else if (argv[i] === '--evaluate') args.evaluate = Number(argv[++i]);
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node scripts/live-cycle.js [--limit 5] [--evaluate 3]');
      process.exit(0);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  reloadConfig();
  const cfg = getConfig();

  console.log('=== live discovery cycle ===');
  console.log(`meteora program:    ${cfg.meteora.programId}`);
  console.log(`discovery category: ${cfg.poolScreening.category}`);
  console.log(`timeframe:          ${cfg.poolScreening.timeframe}`);
  console.log(`limit:              ${args.limit}`);
  console.log(`evaluate:           ${args.evaluate}`);
  console.log();

  openDb();

  const baseline = {
    wallets: countWallets(),
    tracked: listWallets({ status: 'tracked' }).length,
    top: listWallets({ status: 'top' }).length,
    candidate: listWallets({ status: 'candidate' }).length,
    rejected: listWallets({ status: 'rejected' }).length,
  };
  console.log('DB baseline:', baseline);
  console.log();

  const t0 = Date.now();
  let cycle;
  try {
    cycle = await discoverFromTopPools({ limit: args.limit });
    recordSuccess('live-cycle', cycle);
    logAction('live-cycle.discovery', cycle);
  } catch (err) {
    recordError('live-cycle.discovery', err);
    console.error('discovery failed:', err.message);
    process.exit(1);
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`discovery cycle: ${dt}s`);
  console.log(`  pools scanned: ${cycle.poolsScanned}`);
  console.log(`  total owners:  ${cycle.totalOwners}`);
  console.log(`  new candidates:${cycle.totalNewCandidates}`);
  console.log();
  console.log('per-pool breakdown:');
  for (const r of cycle.perPool || []) {
    const note = r.error ? `ERR ${r.error}` : `${r.owners} owners (${r.newCandidates} new)`;
    console.log(`  ${r.pool} → ${note}`);
  }
  console.log();

  const after = {
    wallets: countWallets(),
    tracked: listWallets({ status: 'tracked' }).length,
    top: listWallets({ status: 'top' }).length,
    candidate: listWallets({ status: 'candidate' }).length,
    rejected: listWallets({ status: 'rejected' }).length,
  };
  console.log('DB after:', after);
  console.log(`delta: +${after.wallets - baseline.wallets} wallets, +${after.candidate - baseline.candidate} candidates`);
  console.log();

  if (args.evaluate > 0) {
    console.log(`evaluating top ${args.evaluate} candidates by score/activity...`);
    const candidates = listWallets({ status: 'candidate' })
      .sort((a, b) => (b.last_active || 0) - (a.last_active || 0))
      .slice(0, args.evaluate);
    for (const w of candidates) {
      const t1 = Date.now();
      let r;
      try {
        r = await evaluateWallet(w.address, { force: false });
      } catch (err) {
        console.log(`  ${w.address.slice(0, 8)}… eval FAILED: ${err.message}`);
        continue;
      }
      const ms = Date.now() - t1;
      const tier = r?.tier || 'unknown';
      const score = r?.score != null ? r.score.toFixed(1) : '-';
      const reason = r?.reason || '-';
      console.log(`  ${w.address.slice(0, 8)}… → ${tier} (score=${score}, reason=${reason}, pools=${r?.poolsScanned || 0}, dur=${ms}ms)`);
    }
  }

  await emitHeartbeat();
  console.log('\nheartbeat emitted. ok.');
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  log('error', 'live-cycle fatal', { error: err.message });
  process.exit(1);
});