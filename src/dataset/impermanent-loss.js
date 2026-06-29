import { log } from '../utils/logger.js';

export function priceRatio(entryPrice, exitPrice) {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(exitPrice)) return null;
  if (entryPrice <= 0) return null;
  return exitPrice / entryPrice;
}

export function impermanentLossPct(ratio) {
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  const k = Math.sqrt(ratio);
  const il = (2 * k) / (1 + ratio) - 1;
  return Number.isFinite(il) ? il : null;
}

export function impermanentLossUsd(capitalUsd, ilPct) {
  if (!Number.isFinite(capitalUsd) || !Number.isFinite(ilPct)) return null;
  return capitalUsd * ilPct;
}

export function computeIl({ entryPrice, exitPrice, capitalUsd }) {
  const ratio = priceRatio(entryPrice, exitPrice);
  const ilPct = impermanentLossPct(ratio);
  const ilUsd = impermanentLossUsd(capitalUsd, ilPct);
  return {
    price_ratio_at_close: ratio,
    impermanent_loss_pct: ilPct,
    impermanent_loss_usd: ilUsd,
  };
}

export function computeDlmmIl({ entryPrice, exitPrice, binLower, binUpper, capitalUsd, currentPrice }) {
  const ratio = priceRatio(entryPrice, exitPrice);
  if (!Number.isFinite(ratio)) {
    return { price_ratio_at_close: null, impermanent_loss_pct: null, impermanent_loss_usd: null, method: 'unavailable' };
  }
  const basicIl = impermanentLossPct(ratio);
  let ilPct = basicIl;
  let method = 'closed_form';
  if (
    Number.isFinite(binLower) && Number.isFinite(binUpper) &&
    Number.isFinite(entryPrice) && Number.isFinite(currentPrice) &&
    binLower < binUpper && entryPrice > 0
  ) {
    const rangeLow = entryPrice * Math.pow(1 + (binLower / 10_000), 1);
    const rangeHigh = entryPrice * Math.pow(1 + (binUpper / 10_000), 1);
    if (currentPrice >= rangeLow && currentPrice <= rangeHigh) {
      ilPct = 0;
      method = 'in_range';
    } else if (currentPrice < rangeLow) {
      const ratioOut = currentPrice / rangeLow;
      ilPct = impermanentLossPct(ratioOut);
      method = 'below_range';
    } else {
      const ratioOut = currentPrice / rangeHigh;
      ilPct = impermanentLossPct(ratioOut);
      method = 'above_range';
    }
  }
  const ilUsd = impermanentLossUsd(capitalUsd, ilPct);
  log('debug', 'il-calc: computed', {
    ratio,
    ilPct,
    ilUsd,
    method,
    capitalUsd,
    entryPrice,
    exitPrice,
    binLower,
    binUpper,
    currentPrice,
  });
  return {
    price_ratio_at_close: ratio,
    impermanent_loss_pct: ilPct,
    impermanent_loss_usd: ilUsd,
    method,
  };
}