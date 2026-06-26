import { scoreCandidate, degenScore, degenSubScores, compositeScore } from '../src/screener/pool-scorer.js';
import { condensePool, getRawPoolScreeningRejectReason, screenPool, pvpGuard } from '../src/screener/pool-screener.js';
import { TIMEFRAME_SCREENING_SCALES, normalizeTimeframe, getScreeningDefaultsForTimeframe, scaleScreeningToTimeframe } from '../src/screener/screening-scales.js';

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('  ✓', msg);
}

function makeRawPool(over = {}) {
  return {
    address: 'PoolAddr11111111111111111111111111111111111',
    name: 'SOL-USDC',
    token_x_symbol: 'SOL',
    token_y_symbol: 'USDC',
    token_x_mint: 'So11111111111111111111111111111111111111112',
    token_y_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    bin_step: 100,
    base_fee_pct: 0.2,
    tvl: 50_000,
    active_tvl: 45_000,
    fees: 200,
    volume: 8000,
    fee_active_tvl_ratio: 0.5,
    organic_score: 80,
    holders: 1200,
    mcap: 1_000_000,
    unique_lps: 30,
    positions_created: 25,
    volume_active_tvl_ratio: 25,
    active_positions: 5,
    price: 1.5,
    price_change_24h: 4,
    token_age_hours: 48,
    launchpad: 'pump',
    ...over,
  };
}

function run() {
  console.log('=== screening-scales ===');
  assert(normalizeTimeframe('4H') === '4h', 'normalize 4H -> 4h');
  assert(normalizeTimeframe('xyz') === '4h', 'normalize unknown -> 4h default');
  assert(normalizeTimeframe() === '4h', 'normalize empty -> 4h');
  const d4h = getScreeningDefaultsForTimeframe('4h');
  assert(d4h.minFeeActiveTvlRatio === 0.4, '4h minFeeActiveTvlRatio = 0.4');
  const scaled = scaleScreeningToTimeframe({}, '1h');
  assert(scaled.minFeeActiveTvlRatio === 0.2 && scaled.timeframe === '1h', 'scaleScreeningToTimeframe works');

  console.log('\n=== pool-scorer ===');
  const base = makeRawPool();
  const c = condensePool(base);
  assert(c.pool === base.address, 'condense: pool address kept');
  assert(c.base.symbol === 'SOL', 'condense: base symbol');
  assert(c.quote.symbol === 'USDC', 'condense: quote symbol');
  assert(c.bin_step === 100, 'condense: bin_step');
  assert(c.active_tvl === 45_000, 'condense: active_tvl');
  assert(c.unique_lps === 30, 'condense: unique_lps');

  const s1 = scoreCandidate(c);
  assert(s1 > 0, `scoreCandidate > 0 (got ${s1})`);
  const expected1 = 0.5 * 1000 + 80 * 10 + 8000 / 100 + 1200 / 100;
  assert(Math.abs(s1 - expected1) < 1e-6, `scoreCandidate formula correct (got ${s1}, expected ${expected1})`);

  const c2 = condensePool(makeRawPool({ gmgn_score: 60 }));
  const s2 = scoreCandidate(c2);
  const expected2 = 60 + 0.5 * 500;
  assert(Math.abs(s2 - expected2) < 1e-6, `scoreCandidate with gmgn_score (got ${s2}, expected ${expected2})`);

  const d = degenScore(c);
  assert(d >= 0 && d <= 100, `degenScore in [0,100] (got ${d})`);
  const subs = degenSubScores(c);
  assert(subs.trading >= 0 && subs.lp >= 0 && subs.fees >= 0 && subs.liquidity >= 0, 'degenSubScores all non-negative');

  const veryGood = condensePool(makeRawPool({
    active_tvl: 200_000,
    fee_active_tvl_ratio: 1.5,
    volume_active_tvl_ratio: 50,
    unique_lps: 100,
    positions_created: 50,
    organic_score: 95,
    volume: 50_000,
  }));
  const dGood = degenScore(veryGood);
  assert(dGood > d, `better pool scores higher (${dGood.toFixed(2)} > ${d.toFixed(2)})`);

  const composite = compositeScore(c);
  assert(typeof composite.score === 'number' && typeof composite.degen === 'number', 'compositeScore returns numbers');

  console.log('\n=== pool-screener ===');
  const screening = {
    minTvl: 10_000,
    maxTvl: 200_000,
    minFeeActiveTvlRatio: 0.4,
    minVolume: 1000,
    minOrganic: 60,
    minBinStep: 80,
    maxBinStep: 125,
    minTokenFeesSol: 30,
  };
  const pass = screenPool(c, screening);
  assert(pass, 'screenPool: pool passes default screening');

  const lowTvl = condensePool(makeRawPool({ active_tvl: 100 }));
  const reason1 = getRawPoolScreeningRejectReason(lowTvl, screening);
  assert(reason1 && reason1.startsWith('active_tvl'), `low tvl rejected (got: ${reason1})`);

  const lowRatio = condensePool(makeRawPool({ fee_active_tvl_ratio: 0.1 }));
  const reason2 = getRawPoolScreeningRejectReason(lowRatio, screening);
  assert(reason2 && reason2.startsWith('fee_active_tvl_ratio'), `low ratio rejected (got: ${reason2})`);

  const highBin = condensePool(makeRawPool({ bin_step: 200 }));
  const reason3 = getRawPoolScreeningRejectReason(highBin, screening);
  assert(reason3 && reason3.startsWith('bin_step'), `high bin_step rejected (got: ${reason3})`);

  const tooFewHolders = condensePool(makeRawPool({ holders: 100 }));
  const reason4 = getRawPoolScreeningRejectReason(tooFewHolders, screening);
  assert(reason4 && reason4.startsWith('holders'), `too few holders rejected (got: ${reason4})`);

  const candidates = [
    condensePool(makeRawPool({ token_x_mint: 'mintA', address: 'poolA', active_tvl: 30_000 })),
    condensePool(makeRawPool({ token_x_mint: 'mintA', address: 'poolA2', active_tvl: 30_000 })),
    condensePool(makeRawPool({ token_x_mint: 'mintA', address: 'poolA3', active_tvl: 30_000 })),
    condensePool(makeRawPool({ token_x_mint: 'mintB', address: 'poolB', active_tvl: 30_000 })),
  ];
  const guarded = pvpGuard(candidates, { limit: 2, rivalLimit: 2 });
  assert(guarded.length === 3, `pvpGuard keeps 2 from dominant pair + 1 from rival (got ${guarded.length})`);
  const fromA = guarded.filter((p) => p.base.mint === 'mintA').length;
  const fromB = guarded.filter((p) => p.base.mint === 'mintB').length;
  assert(fromA === 2 && fromB === 1, `pvpGuard split: 2 A + 1 B (got ${fromA} A, ${fromB} B)`);

  const strictGuard = pvpGuard(candidates, { limit: 1 });
  assert(strictGuard.length === 2, `pvpGuard with limit=1 keeps 1 per pair (got ${strictGuard.length})`);

  console.log('\n=== all pool-screener assertions passed ===');
}

try {
  run();
  console.log('\n✓ pool-screener smoke test passed');
  process.exit(0);
} catch (err) {
  console.error('\n✗ pool-screener smoke test FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
}