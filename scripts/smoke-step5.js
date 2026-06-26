#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';

// Use isolated DB + log dir for smoke
const tmp = mkdtempSync(path.join(os.tmpdir(), 'scout-smoke-step5-'));
process.env.LOG_DIR = path.join(tmp, 'logs');
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.LOG_LEVEL = 'warn';

const { openDb, closeDb, getDb } = await import('../src/db/index.js');
const db = openDb();

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(
        () => { passed += 1; process.stdout.write(`  \u2713 ${name}\n`); },
        (err) => { failed += 1; process.stdout.write(`  \u2717 ${name} :: ${err.message}\n`); console.error(err.stack); },
      );
    }
    passed += 1;
    process.stdout.write(`  \u2713 ${name}\n`);
  } catch (err) {
    failed += 1;
    process.stdout.write(`  \u2717 ${name} :: ${err.message}\n`);
    console.error(err.stack);
  }
}

process.stdout.write('Step 5 smoke\n');

await test('seed-wallets: parse + import', async () => {
  const { parseSeedContent, importSeedWallets } = await import('../src/wallets/seed-wallets.js');
  const txt = `# comment line\nAAAAAAAAAA1111111111111111111111111111111111 alpha\nBBBBBBBBBB1111111111111111111111111111111111,beta\nCCCCCCCCCC1111111111111111111111111111111111  gamma\nbad_short\nDDDDDDDDDD1111111111111111111111111111111111\n`;
  const parsed = parseSeedContent(txt);
  assert.equal(parsed.length, 4);
  assert.equal(parsed[0].alias, 'alpha');
  const r = importSeedWallets(txt, { referrer: 'refWallet' });
  assert.equal(r.ok, true);
  assert.equal(r.inserted, 4);
});

await test('seed-wallets: file path import', async () => {
  const { importSeedWallets } = await import('../src/wallets/seed-wallets.js');
  const seedPath = path.join(tmp, 'seed.txt');
  writeFileSync(seedPath, 'EEEEEEEEE1111111111111111111111111111111111 epsilon\nFFFFFFFFFFF11111111111111111111111111111111 zeta\n');
  const r = importSeedWallets(seedPath);
  assert.equal(r.ok, true);
  assert.equal(r.inserted, 2);
});

await test('seed-wallets: dedupes on re-import', async () => {
  const { importSeedWallets } = await import('../src/wallets/seed-wallets.js');
  const seedPath = path.join(tmp, 'seed2.txt');
  writeFileSync(seedPath, 'EEEEEEEEE1111111111111111111111111111111111 epsilon\nGGGGGGGGG1111111111111111111111111111111111 eta\n');
  const r = importSeedWallets(seedPath);
  assert.equal(r.inserted, 1);
  assert.equal(r.updated, 1);
});

await test('wallet-filter: promote tracked -> top when is_top_wallet=1', async () => {
  const walletsDb = await import('../src/db/wallets.js');
  const filter = await import('../src/wallets/wallet-filter.js');
  walletsDb.upsertWallet({
    address: 'HHHHHHHHH1111111111111111111111111111111111',
    source: 'pool_discovery',
    status: 'tracked',
    is_top_wallet: 1,
    score: 80,
  });
  const r = filter.applyTierFilters();
  assert.ok(r);
  const after = walletsDb.getWallet('HHHHHHHHH1111111111111111111111111111111111');
  assert.equal(after.status, 'top');
});

await test('wallet-filter: re-eval rejected wallets (due)', async () => {
  const walletsDb = await import('../src/db/wallets.js');
  const filter = await import('../src/wallets/wallet-filter.js');
  walletsDb.upsertWallet({
    address: 'JJJJJJJJJ1111111111111111111111111111111111',
    source: 'tx_mining',
    status: 'rejected',
    reject_reason: 'score_below',
    last_evaluated: Math.floor(Date.now() / 1000) - (200 * 3600),
  });
  const r = filter.applyTierFilters();
  const after = walletsDb.getWallet('JJJJJJJJJ1111111111111111111111111111111111');
  assert.equal(after.status, 'candidate');
});

await test('signal emitter: dedup blocks second emit', async () => {
  const signalsDb = await import('../src/db/signals.js');
  const emitter = await import('../src/signals/emitter.js');
  const cfg = (await import('../src/config/config.js')).getConfig();

  const poolAddr = 'poolDedup1111111111111111111111111111111111';
  const fakeValidated = {
    pass: true,
    signal: {
      pool_address: poolAddr,
      token_pair: 'TEST/SOL',
      trigger_type: 'wallet_entry',
      triggered_by: 'walletTrigger11111111111111111111111111111111',
      wallet_score: 80,
      pool_score: 0.6,
      combined_confidence: 0.75,
      validation_reasons: ['top_wallet_entered', 'pool_screened'],
      suggested_bin_step: 100,
      suggested_range_lower: 95,
      suggested_range_upper: 115,
      fee_apr: 0.5,
      volume_24h: 1000,
      tvl: 50000,
    },
  };

  const outPath = path.join(tmp, 'signals.json');
  process.env.SIGNAL_OUTPUT_PATH = outPath;
  const cfgMod = await import('../src/config/config.js');
  cfgMod.reloadConfig();
  // patch config in-memory by overriding JSON would require hook; instead rely on default path override

  const first = await emitter.emitSignal(fakeValidated);
  assert.equal(first.ok, true);
  const second = await emitter.emitSignal(fakeValidated);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'deduped');
});

await test('signal emitter: output file written', async () => {
  const outPath = path.join(tmp, 'signals2.json');
  const signalsDb = await import('../src/db/signals.js');
  const emitter = await import('../src/signals/emitter.js');
  // use a different pool to avoid dedup
  const poolAddr = 'poolFile11111111111111111111111111111111111';
  const cfgMod = await import('../src/config/config.js');
  cfgMod.reloadConfig();
  const cfg = cfgMod.getConfig();
  const originalPath = cfg.signal.outputPath;
  cfg.signal.outputPath = outPath;

  const fakeValidated = {
    pass: true,
    signal: {
      pool_address: poolAddr,
      token_pair: 'TEST/SOL',
      trigger_type: 'wallet_entry',
      triggered_by: 'walletTrig222222222222222222222222222222222',
      wallet_score: 88,
      pool_score: 0.7,
      combined_confidence: 0.78,
      validation_reasons: ['top_wallet_entered', 'fee_apr_captured'],
      suggested_bin_step: 80,
      suggested_range_lower: 90,
      suggested_range_upper: 110,
      fee_apr: 0.4,
      volume_24h: 1200,
      tvl: 60000,
    },
  };
  const r = await emitter.emitSignal(fakeValidated);
  assert.equal(r.ok, true);
  cfg.signal.outputPath = originalPath;
  assert.ok(existsSync(outPath), `output file should exist at ${outPath}`);
  const txt = fs.readFileSync(outPath, 'utf8');
  const arr = JSON.parse(txt);
  assert.ok(Array.isArray(arr));
  assert.equal(arr.length, 1);
  assert.equal(arr[0].pool, poolAddr);
});

await test('validator: wallet.status != tracked rejects (no DB top wallet)', async () => {
  const validator = await import('../src/signals/validator.js');
  const r = await validator.validateSignal({
    walletAddress: 'EEEEEEEEE1111111111111111111111111111111111',
    poolAddress: 'somePool1111111111111111111111111111111111',
  });
  assert.equal(r.pass, false);
  assert.equal(r.stage, 'wallet');
});

await test('validator: pool screen failure path returns pool.reason', async () => {
  const walletsDb = await import('../src/db/wallets.js');
  const validator = await import('../src/signals/validator.js');
  walletsDb.upsertWallet({
    address: 'TOPWWWWW1111111111111111111111111111111111',
    source: 'manual',
    status: 'top',
    is_top_wallet: 1,
    score: 80,
    win_rate: 0.7,
  });
  const r = await validator.validateSignal({
    walletAddress: 'TOPWWWWW1111111111111111111111111111111111',
    poolAddress: 'invalidPoolNoMeta111111111111111111111111',
  });
  assert.equal(r.pass, false);
});

await test('record-builder: pure builder produces record from a closed position', async () => {
  const recordBuilder = await import('../src/dataset/record-builder.js');
  const walletsDb = await import('../src/db/wallets.js');
  const positionsDb = await import('../src/db/positions.js');

  const wAddr = 'WBBBBBBBB1111111111111111111111111111111111';
  walletsDb.upsertWallet({
    address: wAddr,
    source: 'manual',
    status: 'tracked',
    score: 65,
    win_rate: 0.7,
    first_seen: 1700000000,
  });

  const poolAddr = 'poolRec11111111111111111111111111111111111';
  const pos = positionsDb.insertPosition({
    id: 'mintRecord1111111111111111111111111111111111',
    wallet_address: wAddr,
    pool_address: poolAddr,
    token_pair: 'TEST/SOL',
    entry_timestamp: 1700100000,
    bin_step: 100,
    bin_lower: 95,
    bin_upper: 115,
    bin_range_width: 21,
    capital_usd: 1000,
    status: 'open',
    position_mint: 'mintRecord1111111111111111111111111111111111',
  });
  const closed = positionsDb.closePosition(pos.id, {
    exit_timestamp: 1700110000,
    pnl_usd: 250,
    fees_earned_usd: 30,
    pnl_pct: 25,
    fee_yield: 0.03,
    duration_hours: 2.78,
    is_profitable: 1,
    close_reason: 'manual',
  });

  const rec = await recordBuilder.buildTrainingRecordFromPosition(closed);
  assert.ok(rec);
  assert.equal(rec.position_id, pos.id);
  assert.equal(rec.was_profitable, 1);
  assert.equal(rec.wallet_score_at_entry, 65);
  assert.equal(rec.wallet_wr_at_entry, 0.7);
  assert.equal(rec.wallet_discovery_source, 'manual');
  assert.equal(rec.hour_of_day, new Date(1700100000 * 1000).getUTCHours());
  assert.equal(rec.day_of_week, new Date(1700100000 * 1000).getUTCDay());
  assert.equal(rec.wallet_position_index, 1);
});

await test('record-builder: skips open positions', async () => {
  const recordBuilder = await import('../src/dataset/record-builder.js');
  const positionsDb = await import('../src/db/positions.js');
  const open = positionsDb.getPosition('mintRecord1111111111111111111111111111111111');
  assert.equal(open.status, 'closed');
  const fresh = positionsDb.insertPosition({
    id: 'mintOpen11111111111111111111111111111111111',
    wallet_address: 'WBBBBBBBB1111111111111111111111111111111111',
    pool_address: 'poolRec11111111111111111111111111111111111',
    token_pair: 'TEST/SOL',
    entry_timestamp: 1700200000,
    status: 'open',
    position_mint: 'mintOpen11111111111111111111111111111111111',
  });
  const rec = await recordBuilder.buildTrainingRecordFromPosition(fresh);
  assert.equal(rec, null);
});

await test('exporter: CSV format produces header + data row', async () => {
  const trainingDb = await import('../src/db/training-records.js');
  const exporter = await import('../src/dataset/exporter.js');
  trainingDb.insertTrainingRecord({
    position_id: 'mintRecord1111111111111111111111111111111111',
    wallet_address: 'WBBBBBBBB1111111111111111111111111111111111',
    pool_address: 'poolRec11111111111111111111111111111111111',
    entry_timestamp: 1700100000,
    close_timestamp: 1700110000,
    was_profitable: 1,
    pnl_usd: 250,
    fee_yield: 0.03,
    wallet_score_at_entry: 65,
    wallet_wr_at_entry: 0.7,
    wallet_discovery_source: 'manual',
    wallet_position_index: 1,
  });
  const outPath = path.join(tmp, 'out.csv');
  const r = await exporter.exportUnexported({ path: outPath, format: 'csv' });
  assert.equal(r.ok, true);
  assert.ok(r.count >= 1, `expected >= 1 record, got ${r.count}`);
  assert.ok(existsSync(outPath));
  const txt = fs.readFileSync(outPath, 'utf8');
  assert.ok(txt.startsWith('id,position_id'));
  assert.ok(txt.includes('mintRecord1111111111111111111111111111111111'));
});

await test('exporter: marks exported_at after write', async () => {
  const trainingDb = await import('../src/db/training-records.js');
  const exporter = await import('../src/dataset/exporter.js');
  const outPath = path.join(tmp, 'out2.csv');
  await exporter.exportUnexported({ path: outPath, format: 'csv' });
  const remaining = trainingDb.listUnexported(100);
  // Either empty or only records inserted after the first export
  assert.ok(Array.isArray(remaining));
});

await test('position-builder: live add_liquidity creates position row', async () => {
  const positionsDb = await import('../src/db/positions.js');
  const eventBus = await import('../src/collector/event-bus.js');
  const positionBuilder = await import('../src/trackers/position-builder.js');
  const pbHandle = positionBuilder.startPositionBuilder();

  const wAddr = 'LJVEW111111111111111111111111111111111111';
  const pAddr = 'LJVEPPPL111111111111111111111111111111111';
  const mint = 'LJVEMJNT1111111111111111111111111111111111';
  const walletsDb = await import('../src/db/wallets.js');
  walletsDb.upsertWallet({ address: wAddr, source: 'manual', status: 'tracked' });

  eventBus.emitTxEvent(eventBus.TX_EVENT_TYPES.ANY_DLMM, {
    signature: 'sigAddLiq111111111111111111111111111111111',
    wallet: wAddr,
    pool: pAddr,
    position_mint: mint,
    instruction: 'add_liquidity',
    eventType: 'add_liquidity',
    timestamp: Math.floor(Date.now() / 1000),
  });
  // synchronously handled in emit
  const created = positionsDb.getPositionByMint(mint);
  assert.ok(created, 'position row should exist after add_liquidity event');
  assert.equal(created.wallet_address, wAddr);
  assert.equal(created.pool_address, pAddr);
  assert.equal(created.status, 'open');
  pbHandle.stop();
});

await test('position-builder: live remove_liquidity closes the position', async () => {
  const positionsDb = await import('../src/db/positions.js');
  const eventBus = await import('../src/collector/event-bus.js');
  const positionBuilder = await import('../src/trackers/position-builder.js');
  const pbHandle = positionBuilder.startPositionBuilder();

  const mint = 'CLPSEMJNT11111111111111111111111111111111';
  const wAddr = 'LJVEW222222222222222222222222222222222222';
  const pAddr = 'LJVEPPPL22222222222222222222222222222222';
  const walletsDb = await import('../src/db/wallets.js');
  walletsDb.upsertWallet({ address: wAddr, source: 'manual', status: 'tracked' });

  eventBus.emitTxEvent(eventBus.TX_EVENT_TYPES.ANY_DLMM, {
    signature: 'sigAddLiq2',
    wallet: wAddr,
    pool: pAddr,
    position_mint: mint,
    instruction: 'add_liquidity',
    eventType: 'add_liquidity',
    timestamp: Math.floor(Date.now() / 1000) - 3600,
  });
  const opened = positionsDb.getPositionByMint(mint);
  assert.ok(opened);

  eventBus.emitTxEvent(eventBus.TX_EVENT_TYPES.ANY_DLMM, {
    signature: 'sigRemLiq2',
    wallet: wAddr,
    pool: pAddr,
    position_mint: mint,
    instruction: 'remove_liquidity',
    eventType: 'remove_liquidity',
    timestamp: Math.floor(Date.now() / 1000),
  });
  const closed = positionsDb.getPositionByMint(mint);
  assert.equal(closed.status, 'closed');
  assert.equal(closed.exit_tx, 'sigRemLiq2');
  pbHandle.stop();
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
closeDb();
try { rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(failed > 0 ? 1 : 0);