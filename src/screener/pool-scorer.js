export const DEGEN_SCORE_TARGETS = {
  targetVolRatio: 20,
  targetLpCount: 40,
  targetFeeRatio: 0.2,
  targetLiquidity: 20_000,
};

export const DEGEN_SCORE_LIMITS = {
  min: 0,
  max: 100,
  subScoreMin: 0.01,
  subScoreMax: 5,
  liquidityMin: 1,
  liquidityMax: 100_000_000,
};

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function safeLog10(v) {
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.log10(v);
}

export function scoreCandidate(pool) {
  if (!pool) return 0;
  const ratio = Number(pool.fee_active_tvl_ratio) || 0;
  const organic = Number(pool.organic_score) || 0;
  const volume = Number(pool.volume_window) || 0;
  const holders = Number(pool.holders) || 0;
  if (Number.isFinite(pool.gmgn_score)) {
    return (Number(pool.gmgn_score) || 0) + ratio * 500;
  }
  return ratio * 1000 + organic * 10 + volume / 100 + holders / 100;
}

function tradingSubScore(pool) {
  const ratio = Number(pool.volume_active_tvl_ratio) || 0;
  return clamp(ratio / DEGEN_SCORE_TARGETS.targetVolRatio, DEGEN_SCORE_LIMITS.subScoreMin, DEGEN_SCORE_LIMITS.subScoreMax);
}

function lpSubScore(pool) {
  const uniqueLps = Number(pool.unique_lps) || 0;
  const positionsCreated = Number(pool.positions_created) || 0;
  const count = uniqueLps + positionsCreated;
  return clamp(count / DEGEN_SCORE_TARGETS.targetLpCount, DEGEN_SCORE_LIMITS.subScoreMin, DEGEN_SCORE_LIMITS.subScoreMax);
}

function feeSubScore(pool, timeframeScale = 1) {
  const ratio = (Number(pool.fee_active_tvl_ratio) || 0) * timeframeScale;
  return clamp(ratio / DEGEN_SCORE_TARGETS.targetFeeRatio, DEGEN_SCORE_LIMITS.subScoreMin, DEGEN_SCORE_LIMITS.subScoreMax);
}

function liquiditySubScore(pool) {
  const tvl = clamp(Number(pool.active_tvl) || 0, DEGEN_SCORE_LIMITS.liquidityMin, DEGEN_SCORE_LIMITS.liquidityMax);
  const log = safeLog10(tvl);
  const targetLog = safeLog10(DEGEN_SCORE_TARGETS.targetLiquidity);
  if (targetLog <= 0) return DEGEN_SCORE_LIMITS.subScoreMin;
  return clamp(log / targetLog, DEGEN_SCORE_LIMITS.subScoreMin, DEGEN_SCORE_LIMITS.subScoreMax);
}

export function degenScore(pool, opts = {}) {
  if (!pool) return 0;
  const targets = { ...DEGEN_SCORE_TARGETS, ...(opts.targets || {}) };
  const timeframeScale = Number(opts.timeframeScale) || 1;
  const trading = clamp(pool.volume_active_tvl_ratio != null ? pool.volume_active_tvl_ratio / targets.targetVolRatio : 0, DEGEN_SCORE_LIMITS.subScoreMin, DEGEN_SCORE_LIMITS.subScoreMax);
  const lpRaw = (Number(pool.unique_lps) || 0) + (Number(pool.positions_created) || 0);
  const lp = clamp(lpRaw / targets.targetLpCount, DEGEN_SCORE_LIMITS.subScoreMin, DEGEN_SCORE_LIMITS.subScoreMax);
  const fees = clamp(((Number(pool.fee_active_tvl_ratio) || 0) * timeframeScale) / targets.targetFeeRatio, DEGEN_SCORE_LIMITS.subScoreMin, DEGEN_SCORE_LIMITS.subScoreMax);
  const tvl = clamp(Number(pool.active_tvl) || 0, DEGEN_SCORE_LIMITS.liquidityMin, DEGEN_SCORE_LIMITS.liquidityMax);
  const log = safeLog10(tvl);
  const targetLog = safeLog10(targets.targetLiquidity);
  const liquidity = clamp(targetLog > 0 ? log / targetLog : 0, DEGEN_SCORE_LIMITS.subScoreMin, DEGEN_SCORE_LIMITS.subScoreMax);

  const geometric = Math.pow(trading * lp * fees * liquidity, 0.25);
  const scaled = ((geometric - 1) / (DEGEN_SCORE_LIMITS.subScoreMax - 1)) * DEGEN_SCORE_LIMITS.max;
  return clamp(scaled, DEGEN_SCORE_LIMITS.min, DEGEN_SCORE_LIMITS.max);
}

export function degenSubScores(pool, opts = {}) {
  const targets = { ...DEGEN_SCORE_TARGETS, ...(opts.targets || {}) };
  const timeframeScale = Number(opts.timeframeScale) || 1;
  return {
    trading: tradingSubScore(pool) * 25,
    lp: lpSubScore(pool) * 25,
    fees: feeSubScore(pool, timeframeScale) * 25,
    liquidity: liquiditySubScore(pool) * 25,
    targets,
  };
}

export function compositeScore(pool, opts = {}) {
  const score = scoreCandidate(pool);
  const degen = degenScore(pool, opts);
  return { score: Number(score.toFixed(2)), degen: Number(degen.toFixed(2)), combined: Number((score * 0.4 + degen * 0.6).toFixed(2)) };
}