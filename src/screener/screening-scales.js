export const TIMEFRAME_SCREENING_SCALES = {
  '5m':  { minFeeActiveTvlRatio: 0.02, minVolume: 500 },
  '30m': { minFeeActiveTvlRatio: 0.15, minVolume: 1000 },
  '1h':  { minFeeActiveTvlRatio: 0.2,  minVolume: 10000 },
  '2h':  { minFeeActiveTvlRatio: 0.4,  minVolume: 20000 },
  '4h':  { minFeeActiveTvlRatio: 0.4,  minVolume: 2000 },
  '12h': { minFeeActiveTvlRatio: 1.5,  minVolume: 60000 },
  '24h': { minFeeActiveTvlRatio: 2.0,  minVolume: 10000 },
};

export const DEFAULT_TIMEFRAME = '4h';
export const VALID_TIMEFRAMES = new Set(Object.keys(TIMEFRAME_SCREENING_SCALES));

export function normalizeTimeframe(input) {
  if (!input) return DEFAULT_TIMEFRAME;
  const key = String(input).toLowerCase();
  return VALID_TIMEFRAMES.has(key) ? key : DEFAULT_TIMEFRAME;
}

export function getScreeningDefaultsForTimeframe(timeframe) {
  const key = normalizeTimeframe(timeframe);
  return { ...TIMEFRAME_SCREENING_SCALES[key] };
}

export function scaleScreeningToTimeframe(baseScreening, timeframe) {
  const base = baseScreening || {};
  const defaults = getScreeningDefaultsForTimeframe(timeframe);
  return {
    ...base,
    minFeeActiveTvlRatio: base.minFeeActiveTvlRatio ?? defaults.minFeeActiveTvlRatio,
    minVolume: base.minVolume ?? defaults.minVolume,
    timeframe,
  };
}