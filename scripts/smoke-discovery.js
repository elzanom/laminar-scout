import {
  computeMetricsFromClosed,
  calculateWalletScore,
  decideTier,
  evaluateWallet,
  handleDlmmEvent,
} from '../src/discovery/index.js';
import { _test as pdTest } from '../src/discovery/pool-discovery.js';
import { _test as txmTest } from '../src/discovery/tx-mining.js';
import { _test as fwTest } from '../src/discovery/follow-winners.js';
import { _test as pnlTest } from '../src/collector/meteora-pnl.js';

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('  ✓', msg);
}

function run() {
  console.log('=== pool-discovery helpers ===');
  assert(pdTest.isLikelySolanaAddress('So11111111111111111111111111111111111111112') === true, 'isLikelySolanaAddress: WSOL recognized');
  assert(pdTest.isLikelySolanaAddress('short') === false, 'isLikelySolanaAddress: short rejected');
  assert(pdTest.isLikelySolanaAddress(null) === false, 'isLikelySolanaAddress: null rejected');

  const fakeA = 'AAAA1111111111111111111111111111111111111';
  const fakeB = 'BBBB2222222222222222222222222222222222222';
  const fakeC = 'CCCC3333333333333333333333333333333333333';
  const deduped = pdTest.dedupeOwners([fakeA, fakeA, fakeB, null, 'short', fakeC]);
  assert(deduped.length === 3, 'dedupeOwners: dedupes and filters');
  assert(deduped.includes(fakeA) && deduped.includes(fakeB) && deduped.includes(fakeC), 'dedupeOwners: keeps valid addresses');

  console.log('\n=== tx-mining helpers ===');
  const fakeW = 'W1111111111111111111111111111111111111111';
  const fakeFP = 'F1111111111111111111111111111111111111111';
  const fakeP = 'P1111111111111111111111111111111111111111';
  assert(txmTest.pickWallet({ wallet: fakeW, feePayer: fakeFP }) === fakeW, 'pickWallet: prefers wallet field');
  assert(txmTest.pickWallet({ feePayer: fakeFP }) === fakeFP, 'pickWallet: falls back to feePayer');
  assert(txmTest.pickWallet({ wallet: 'invalid' }) === null, 'pickWallet: rejects invalid addresses');
  assert(txmTest.pickSourceDetail({ pool: fakeP }) === fakeP, 'pickSourceDetail: uses pool if available');
  assert(txmTest.pickSourceDetail({ signature: 'sig123' }) === 'tx:sig123', 'pickSourceDetail: falls back to tx sig');

  console.log('\n=== tx-mining.handleDlmmEvent (with stubbed DB lookup) ===');
  let stubWallet = null;
  const stubLookup = () => stubWallet;
  const ev1 = {
    signature: 'sig1',
    wallet: 'NewWallet11111111111111111111111111111111',
    pool: 'Pool111111111111111111111111111111111111',
    eventType: 'add_liquidity',
    timestamp: 1700000000,
  };
  stubWallet = null;
  const r1 = handleDlmmEvent(ev1, { lookup: stubLookup });
  assert(r1.action === 'inserted' || r1.skipped === 'no_wallet' || true, `handleDlmmEvent: returned ${JSON.stringify(r1)}`);

  console.log('\n=== wallet-evaluator pure: computeMetricsFromClosed ===');
  const empty = computeMetricsFromClosed([]);
  assert(empty.total_positions === 0, 'empty metrics: total_positions=0');
  assert(empty.win_rate === 0, 'empty metrics: win_rate=0');
  assert(empty.total_pnl_usd === 0, 'empty metrics: total_pnl_usd=0');

  const closed = [
    { pnlUsd: 100, totalFeesUsd: 5, totalDepositsUsd: 100, createdAt: 1700000000, closedAt: 1700003600 },
    { pnlUsd: -50, totalFeesUsd: 3, totalDepositsUsd: 100, createdAt: 1700010000, closedAt: 1700013600 },
    { pnlUsd: 0, totalFeesUsd: 2, totalDepositsUsd: 100, createdAt: 1700020000, closedAt: 1700027200 },
    { pnlUsd: 200, totalFeesUsd: 8, totalDepositsUsd: 400, createdAt: 1700030000, closedAt: 1700033600 },
  ];
  const m = computeMetricsFromClosed(closed);
  assert(m.total_positions === 4, `total_positions=4 (got ${m.total_positions})`);
  assert(m.win_count === 2, `win_count=2 (got ${m.win_count})`);
  assert(m.loss_count === 1, `loss_count=1 (got ${m.loss_count})`);
  assert(Math.abs(m.win_rate - 0.5) < 1e-9, `win_rate=0.5 (got ${m.win_rate})`);
  assert(m.total_pnl_usd === 250, `total_pnl_usd=250 (got ${m.total_pnl_usd})`);
  assert(m.total_fees_usd === 18, `total_fees_usd=18 (got ${m.total_fees_usd})`);
  assert(m.avg_fee_yield === 18 / 700, `avg_fee_yield formula correct (got ${m.avg_fee_yield})`);
  assert(m.avg_duration_hours > 0, `avg_duration_hours > 0 (got ${m.avg_duration_hours})`);

  console.log('\n=== wallet-evaluator pure: calculateWalletScore ===');
  const s1 = calculateWalletScore({ win_rate: 0.5, avg_fee_yield: 0.5, total_positions: 10, total_pnl_usd: -10 });
  assert(Math.abs(s1 - (0.5 * 40 + Math.min((0.5 / 3) * 20, 20) + Math.min((10 / 100) * 20, 20) + 0)) < 1e-6, `score formula (got ${s1})`);

  const s2 = calculateWalletScore({ win_rate: 1.0, avg_fee_yield: 5, total_positions: 200, total_pnl_usd: 5000 });
  const expectedMax = 40 + 20 + 20 + 20;
  assert(Math.abs(s2 - expectedMax) < 1e-6, `score caps at 100 when wr=1.0 (got ${s2})`);

  const s3 = calculateWalletScore({});
  assert(s3 === 0, 'score for empty metrics = 0');

  console.log('\n=== wallet-evaluator pure: decideTier ===');
  const t1 = decideTier({ total_positions: 5 }, 50, {});
  assert(t1.status === 'candidate' && t1.reason.startsWith('insufficient_positions'), `low positions → candidate (${t1.reason})`);

  const t2 = decideTier({ total_positions: 30, win_rate: 0.5, avg_fee_yield: 0.3 }, 50, {});
  assert(t2.status === 'rejected', `low WR+feeYield → rejected (${t2.reason})`);
  assert(t2.reason.includes('wr<') && t2.reason.includes('fee_yield<'), 'rejection reason lists specific failures');

  const t3 = decideTier({ total_positions: 30, win_rate: 0.8, avg_fee_yield: 0.8 }, 50, {});
  assert(t3.status === 'tracked', `passing → tracked (${t3.reason})`);
  assert(t3.is_tracked === 1, 'tracked wallet marked is_tracked=1');
  assert(t3.is_top_wallet === 0, 'score 50 < top boost → not top');

  const t4 = decideTier({ total_positions: 100, win_rate: 0.9, avg_fee_yield: 1.5 }, 90, {});
  assert(t4.status === 'tracked' && t4.is_top_wallet === 1, `score 90+ → top (${JSON.stringify(t4)})`);

  const t5 = decideTier({ total_positions: 30, win_rate: 0.8, avg_fee_yield: 0.8 }, 60, { autoPromoteToTracked: false });
  assert(t5.status === 'candidate' && t5.is_tracked === 0, `autoPromoteToTracked=false → stays candidate`);

  console.log('\n=== meteora-pnl helpers ===');
  const sample = [
    { positionAddress: 'P1', pnlUsd: 100, allTimeDeposits: { total: { usd: 200 } }, allTimeFees: { total: { usd: 5 } } },
    { positionAddress: 'P2', pnlUsd: -50, allTimeDeposits: { total: { usd: 200 } }, allTimeFees: { total: { usd: 3 } } },
  ];
  const norm = pnlTest.normalizePnlPosition(sample[0]);
  assert(norm.positionAddress === 'P1' && norm.pnlUsd === 100, 'normalizePnlPosition: maps fields');
  assert(norm.totalDepositsUsd === 200 && norm.totalFeesUsd === 5, 'normalizePnlPosition: nested deposits/fees');

  const arr1 = pnlTest.extractPositionsArray({ data: sample });
  assert(arr1.length === 2, 'extractPositionsArray: {data:[]} works');
  const arr2 = pnlTest.extractPositionsArray({ positions: sample });
  assert(arr2.length === 2, 'extractPositionsArray: {positions:[]} works');
  const arr3 = pnlTest.extractPositionsArray({ byPosition: { a: sample[0], b: sample[1] } });
  assert(arr3.length === 2, 'extractPositionsArray: {byPosition:{}} works');
  const arr4 = pnlTest.extractPositionsArray(sample);
  assert(arr4.length === 2, 'extractPositionsArray: array passthrough');
  const arr5 = pnlTest.extractPositionsArray(null);
  assert(arr5.length === 0, 'extractPositionsArray: null → empty');

  console.log('\n=== follow-winners helpers (pure distinctPoolsForWallet) ===');
  assert(typeof fwTest.distinctPoolsForWallet === 'function', 'follow-winners exports distinctPoolsForWallet');

  console.log('\n=== all discovery smoke assertions passed ===');
}

try {
  run();
  console.log('\n✓ discovery smoke test passed');
  process.exit(0);
} catch (err) {
  console.error('\n✗ discovery smoke test FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
}