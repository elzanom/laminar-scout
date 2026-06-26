import * as walletsDb from '../db/wallets.js';
import { screenPoolDeep } from '../screener/pool-screener.js';
import { getConfig } from '../config/config.js';
import { recordSuccess, recordError, incrCounter } from '../utils/health.js';
import { log } from '../utils/logger.js';

function _walletPass(wallet, minScore) {
  if (!wallet) return { pass: false, reason: 'no_wallet' };
  if (wallet.status === 'top' || wallet.is_top_wallet === 1) return { pass: true };
  if (wallet.status !== 'tracked') return { pass: false, reason: `status_${wallet.status}` };
  if (typeof wallet.score === 'number' && wallet.score < minScore) {
    return { pass: false, reason: `score_${wallet.score}_below_${minScore}` };
  }
  return { pass: true };
}

function _combinedConfidence(walletScore, poolScore) {
  const w = Math.min(Math.max((walletScore || 0) / 100, 0), 1);
  const p = Math.min(Math.max(poolScore || 0, 0), 1);
  return (w * 0.4) + (p * 0.6);
}

export async function validateSignal({ walletAddress, poolAddress, triggerType, triggeredBy, timeframe, position }) {
  const cfg = getConfig();
  const minWalletScore = cfg.minWalletScore ?? 45;
  const minCombined = cfg.signal?.minCombinedConfidence ?? 0.70;
  const tf = timeframe || '4h';

  const wallet = walletsDb.getWallet(walletAddress);
  const walletCheck = _walletPass(wallet, minWalletScore);
  if (!walletCheck.pass) {
    incrCounter('signal_validator.wallet_reject');
    return { pass: false, stage: 'wallet', reason: walletCheck.reason, wallet };
  }

  let poolResult;
  try {
    poolResult = await screenPoolDeep(poolAddress, tf);
  } catch (err) {
    recordError('signal_validator.pool_screen', err, { pool: poolAddress });
    return { pass: false, stage: 'pool', reason: 'screen_error', error: err.message };
  }

  if (!poolResult?.passed) {
    incrCounter('signal_validator.pool_reject');
    return {
      pass: false,
      stage: 'pool',
      reason: poolResult?.reason || 'screen_failed',
      wallet,
      pool: poolResult?.pool || null,
    };
  }

  const pool = poolResult.pool;
  const poolScore = (typeof pool.combined === 'number') ? (pool.combined / 100) : 0;
  const walletScore = wallet.score ?? minWalletScore;
  const combined = _combinedConfidence(walletScore, poolScore);

  if (combined < minCombined) {
    incrCounter('signal_validator.confidence_reject');
    return {
      pass: false,
      stage: 'confidence',
      reason: `confidence_${combined.toFixed(3)}_below_${minCombined}`,
      wallet,
      pool,
      combined_confidence: combined,
    };
  }

  const reasons = [
    'top_wallet_entered',
    pool.fee_window ? 'fee_captured' : null,
    pool.tvl ? 'tvl_captured' : null,
    pool.volume_window ? 'volume_captured' : null,
    (pool.organic_score ?? 0) >= (cfg.poolScreening?.minOrganic ?? 60) ? 'organic_score_high' : null,
    'pool_screened',
  ].filter(Boolean);

  if (position) {
    if (position.bin_lower != null) reasons.push(`range_lower_${position.bin_lower}`);
    if (position.bin_upper != null) reasons.push(`range_upper_${position.bin_upper}`);
    if (position.bin_step != null) reasons.push(`bin_step_${position.bin_step}`);
  }

  const signal = {
    pool_address: poolAddress,
    token_pair: pool.name || null,
    trigger_type: triggerType || 'wallet_entry',
    triggered_by: triggeredBy || walletAddress,
    wallet_score: walletScore,
    pool_score: poolScore,
    combined_confidence: combined,
    validation_reasons: reasons,
    suggested_bin_step: position?.bin_step ?? null,
    suggested_range_lower: position?.bin_lower ?? null,
    suggested_range_upper: position?.bin_upper ?? null,
    fee_apr: pool.fee_window ?? null,
    volume_24h: pool.volume_window ?? null,
    tvl: pool.tvl ?? null,
  };

  recordSuccess('signal_validator', { pool: poolAddress, wallet: walletAddress, combined });
  incrCounter('signal_validator.passed');
  return { pass: true, stage: 'all', signal, wallet, pool, combined_confidence: combined };
}

export const _test = { _walletPass, _combinedConfidence };