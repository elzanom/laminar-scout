import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'scout-smoke-db-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.LOG_DIR = path.join(tmp, 'logs');

const { openDb, closeDb, dbStats } = await import('../src/db/index.js');
const { getConfig } = await import('../src/config/config.js');
const { log } = await import('../src/utils/logger.js');
const { upsertWallet, getWallet, listCandidatesNeedingEval } = await import('../src/db/wallets.js');
const { insertPosition, getPosition, closePosition, listPositions } = await import('../src/db/positions.js');
const { insertSnapshot, latestSnapshot, nearestSnapshotAt } = await import('../src/db/market-snapshots.js');
const { insertSignal, listSignals, markSignalStatus } = await import('../src/db/signals.js');
const { insertTrainingRecord, listAllTrainingRecords } = await import('../src/db/training-records.js');
const { markProcessed, isProcessed, filterUnprocessed, processedCount } = await import('../src/db/processed-txs.js');

async function run() {
  const cfg = getConfig();
  log('info', `smoke: data dir = ${cfg.runtime.dataDir}`);

  const db = openDb();
  log('info', 'smoke: db opened');

  const stats = dbStats();
  log('info', `smoke: db stats`, stats);

  const wallet = upsertWallet({
    address: 'SmokeWallet1111111111111111111111111111111111',
    alias: 'smoke-test',
    source: 'manual',
    discovered_from: 'smoke',
    status: 'candidate',
  });
  if (!getWallet(wallet.address)) throw new Error('upsertWallet: failed to read back');

  const txId = 'smoke-tx-' + Date.now();
  markProcessed(txId, 'smoke');
  if (!isProcessed(txId)) throw new Error('markProcessed: failed to record tx');
  const unprocessed = filterUnprocessed([txId + '-fresh']);
  if (!unprocessed.length) throw new Error('filterUnprocessed: should return unprocessed ids');
  const procCount = processedCount();
  if (procCount < 1) throw new Error(`processedCount: expected >=1 got ${procCount}`);

  const pos = insertPosition({
    id: 'smoke-mint-' + Date.now(),
    wallet_address: wallet.address,
    pool_address: 'SmokePool111111111111111111111111111111111',
    token_pair: 'SOL/USDC',
    entry_timestamp: Math.floor(Date.now() / 1000) - 3600,
    bin_step: 100,
    bin_lower: 95,
    bin_upper: 105,
    bin_range_width: 11,
    capital_usd: 500,
    status: 'open',
    position_mint: 'smoke-mint-' + Date.now(),
  });
  log('info', 'smoke: position opened');
  closePosition(pos.id, {
    exit_timestamp: Math.floor(Date.now() / 1000),
    pnl_usd: 25,
    pnl_pct: 5,
    fees_earned_usd: 3.5,
    fee_yield: 0.007,
    duration_hours: 1,
    is_profitable: 1,
    close_reason: 'smoke',
  });
  const allPos = listPositions({ wallet_address: wallet.address });
  if (allPos.length !== 1) throw new Error(`listPositions: expected 1 got ${allPos.length}`);

  insertSnapshot({
    pool_address: pos.pool_address,
    timestamp: pos.entry_timestamp,
    fee_apr: 1.2,
    volume_24h: 10000,
    tvl: 50000,
    fee_tvl_ratio: 0.05,
    active_bin: 100,
    price: 1.0,
    token_price: 1.0,
    token_price_change_24h: 0.01,
    token_volatility_24h: 0.05,
    token_volume_24h: 1000,
  });
  const snap = latestSnapshot(pos.pool_address);
  if (!snap) throw new Error('latestSnapshot: missing');
  const near = nearestSnapshotAt(pos.pool_address, pos.entry_timestamp, 24 * 3600);
  if (!near) throw new Error('nearestSnapshotAt: missing');

  const sigId = insertSignal({
    pool_address: pos.pool_address,
    token_pair: 'SOL/USDC',
    trigger_type: 'wallet_entry',
    triggered_by: wallet.address,
    wallet_score: 78,
    pool_score: 0.6,
    combined_confidence: 0.71,
    validation_reasons: ['smoke'],
    suggested_bin_step: 100,
    fee_apr: 1.2,
    volume_24h: 10000,
    tvl: 50000,
  });
  if (!sigId) throw new Error('insertSignal: no id returned');
  markSignalStatus(sigId, 'sent', Math.floor(Date.now() / 1000));
  const sigs = listSignals({ pool_address: pos.pool_address });
  if (sigs.length < 1) throw new Error('listSignals: expected >=1');

  insertTrainingRecord({
    position_id: pos.id,
    wallet_address: wallet.address,
    pool_address: pos.pool_address,
    entry_timestamp: pos.entry_timestamp,
    close_timestamp: pos.exit_timestamp,
    was_profitable: 1,
    pnl_usd: 25,
    fee_yield: 0.007,
    wallet_score_at_entry: 78,
    wallet_wr_at_entry: 0.7,
    wallet_discovery_source: 'manual',
    wallet_position_index: 1,
  });
  const recs = listAllTrainingRecords();
  if (recs.length < 1) throw new Error('listAllTrainingRecords: empty');

  const cands = listCandidatesNeedingEval(10);
  if (!cands.length) throw new Error('listCandidatesNeedingEval: empty');

  log('info', 'smoke: all CRUD paths verified OK');
  closeDb();
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  return true;
}

try {
  await run();
  process.stdout.write('\n✓ scout-db smoke test passed\n');
  process.exit(0);
} catch (err) {
  console.error(`\n✗ scout-db smoke test FAILED: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
}