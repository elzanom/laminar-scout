import { getDb } from '../db/index.js';
import { log, logAction } from '../utils/logger.js';
import { recordSuccess, recordError, incrCounter } from '../utils/health.js';

const MAX_RULE_LEN = 280;

function _safe(n) {
  if (n == null) return null;
  const v = typeof n === 'string' ? parseFloat(n) : n;
  return Number.isFinite(v) ? v : null;
}

function _safeStr(v, maxLen = 100) {
  if (v == null) return null;
  return String(v).slice(0, maxLen);
}

function _bucket(value, buckets) {
  for (const { min, max, label } of buckets) {
    if (value >= min && value < max) return label;
  }
  return null;
}

function _outcome(pnlPct, feeYieldPct) {
  if (pnlPct == null) return 'unknown';
  if (pnlPct >= 5) return 'good';
  if (pnlPct >= 0 && feeYieldPct != null && feeYieldPct >= 2) return 'good';
  if (pnlPct >= 0) return 'neutral';
  if (pnlPct >= -5) return 'poor';
  return 'bad';
}

function _confidence(perf) {
  let c = 0.35;
  const fee = _safe(perf.fee_earned_usd) || 0;
  const feeYield = _safe(perf.fee_yield) || 0;
  const pnl = _safe(perf.pnl_usd) || 0;
  const pnlPct = _safe(perf.pnl_pct) || 0;
  if (pnlPct >= 3) c += 0.15;
  if (pnlPct <= -5) c += 0.15;
  if (feeYield >= 1) c += 0.10;
  if (fee >= 3) c += 0.05;
  if (perf.out_of_range === 1 || perf.out_of_range === true) c += 0.05;
  return Math.min(0.95, Math.max(0.10, c));
}

function _fmtUsd(n) {
  if (n == null) return '?';
  const v = Number(n);
  if (!Number.isFinite(v)) return '?';
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}K`;
  return v.toFixed(0);
}

export function deriveLesson(rec) {
  if (!rec) return null;
  const pnlPct = _safe(rec.pnl_pct);
  const pnlUsd = _safe(rec.pnl_usd);
  const feeYield = _safe(rec.fee_yield);
  const feeUsd = _safe(rec.fee_earned_usd);
  const binStep = _safe(rec.pool_bin_step);
  const tvl = _safe(rec.pool_tvl);
  const vol = _safe(rec.pool_volume_24h);
  const feeTvlRatio = _safe(rec.fee_tvl_ratio);
  const organic = _safe(rec.token_x_organic_score);
  const isOor = rec.is_out_of_range === 1 || rec.is_out_of_range === true;
  const binLower = _safe(rec.bin_lower);
  const binUpper = _safe(rec.bin_upper);
  const tokenPair = _safeStr(rec.token_pair, 30);

  const outcome = _outcome(pnlPct, feeYield);
  if (outcome === 'neutral' || outcome === 'unknown') return null;

  const binBucket = binStep != null
    ? _bucket(binStep, [
        { min: 0, max: 5, label: 'tight' },
        { min: 5, max: 25, label: 'medium' },
        { min: 25, max: 100, label: 'wide' },
        { min: 100, max: 100000, label: 'very_wide' },
      ])
    : null;

  const tvlBucket = tvl != null
    ? _bucket(tvl, [
        { min: 0, max: 50_000, label: 'micro' },
        { min: 50_000, max: 500_000, label: 'small' },
        { min: 500_000, max: 5_000_000, label: 'medium' },
        { min: 5_000_000, max: 1e12, label: 'large' },
      ])
    : null;

  let rule = '';
  let category = null;
  const tags = [];
  if (binBucket) tags.push(`bin_${binBucket}`);
  if (tvlBucket) tags.push(`tvl_${tvlBucket}`);
  if (organic != null) {
    if (organic >= 70) tags.push('organic_high');
    else if (organic < 40) tags.push('organic_low');
  }

  if (isOor && outcome === 'bad') {
    const binRange = binLower != null && binUpper != null ? `bin_range=${binLower}..${binUpper}` : '';
    rule = `AVOID: ${tokenPair || 'unknown'} pool ${binRange ? `(${binRange}, bin_step=${binStep})` : `(bin_step=${binStep})`} went OOR — PnL ${pnlPct?.toFixed(1)}%. Use wider range or pick tighter bin_step.`;
    category = 'out_of_range';
    tags.push('oor', 'negative');
  } else if (outcome === 'good' && (pnlPct ?? 0) >= 5) {
    const conditions = [];
    if (binBucket) conditions.push(`bin_step=${binStep}(${binBucket})`);
    if (tvlBucket) conditions.push(`tvl=${_fmtUsd(tvl)}(${tvlBucket})`);
    if (feeTvlRatio != null) conditions.push(`fee/TVL=${(feeTvlRatio * 100).toFixed(2)}%`);
    rule = `PREFER: ${tokenPair || 'unknown'} pool ${conditions.join(', ')} → PnL +${pnlPct.toFixed(1)}%, fees $${_fmtUsd(feeUsd)}.`;
    category = 'profitable';
    tags.push('positive', 'profitable');
  } else if (outcome === 'good' && (feeYield ?? 0) >= 2) {
    rule = `WORKED: ${tokenPair || 'unknown'} pool bin_step=${binStep} yielded ${feeYield.toFixed(2)}% fees. PnL +${pnlPct.toFixed(1)}%.`;
    category = 'fee_yield';
    tags.push('positive', 'fee_yield');
  } else if (outcome === 'bad' && (vol ?? 0) < 1000) {
    rule = `AVOID: Low-volume pool ${tokenPair || 'unknown'} (vol24h=$${_fmtUsd(vol)}) — fees evaporated, PnL ${pnlPct?.toFixed(1)}%. Need sustained volume check.`;
    category = 'low_volume';
    tags.push('negative', 'low_volume', 'volume_collapse');
  } else if (outcome === 'bad') {
    rule = `FAILED: ${tokenPair || 'unknown'} pool bin_step=${binStep} → PnL ${pnlPct?.toFixed(1)}%, fees $${_fmtUsd(feeUsd)}.`;
    category = 'unprofitable';
    tags.push('negative', 'failed');
  }

  if (!rule) return null;

  return {
    rule: rule.slice(0, MAX_RULE_LEN),
    tags: JSON.stringify(tags),
    outcome,
    confidence: _confidence({
      pnl_pct: pnlPct, pnl_usd: pnlUsd, fee_yield: feeYield,
      fee_earned_usd: feeUsd, out_of_range: isOor,
    }),
    source: 'auto',
    context: JSON.stringify({
      token_pair: tokenPair, pool_bin_step: binStep, pool_tvl: tvl,
      pool_volume_24h: vol, fee_tvl_ratio: feeTvlRatio, organic: organic,
      pnl_pct: pnlPct, fee_yield: feeYield, out_of_range: isOor,
    }),
    category,
    pool_address: _safeStr(rec.pool_address, 50),
    wallet_address: _safeStr(rec.wallet_address, 50),
  };
}

export function recordLesson(lesson) {
  if (!lesson || !lesson.rule) return null;
  const db = getDb();
  try {
    const existing = db.prepare('SELECT id, sample_count FROM lessons WHERE rule = ?').get(lesson.rule);
    if (existing) {
      db.prepare('UPDATE lessons SET sample_count = sample_count + 1, created_at = ? WHERE id = ?')
        .run(Math.floor(Date.now() / 1000), existing.id);
      incrCounter('learning.lesson.dedup');
      return { id: existing.id, dedup: true };
    }
    const info = db.prepare(`
      INSERT INTO lessons (rule, tags, outcome, confidence, source, context, category, pool_address, wallet_address, sample_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(
      lesson.rule, lesson.tags || '[]', lesson.outcome, lesson.confidence || 0.35,
      lesson.source || 'auto', lesson.context || null, lesson.category || null,
      lesson.pool_address || null, lesson.wallet_address || null,
      Math.floor(Date.now() / 1000),
    );
    incrCounter('learning.lesson.created');
    return { id: info.lastInsertRowid, dedup: false };
  } catch (err) {
    recordError('learning.lesson', err);
    return null;
  }
}

export function recordLessonFromRecord(rec) {
  const lesson = deriveLesson(rec);
  if (!lesson) return null;
  return recordLesson(lesson);
}

export function listLessons({ category = null, limit = 50, since = null } = {}) {
  const db = getDb();
  let sql = 'SELECT * FROM lessons';
  const params = [];
  const conds = [];
  if (category) { conds.push('category = ?'); params.push(category); }
  if (since) { conds.push('created_at >= ?'); params.push(since); }
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params).map(_deserialize);
}

export function getLessonsSummary() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT category, outcome, COUNT(*) AS n, AVG(confidence) AS avg_confidence,
           SUM(sample_count) AS total_samples
    FROM lessons
    GROUP BY category, outcome
    ORDER BY n DESC
  `).all();
  const total = db.prepare('SELECT COUNT(*) AS n, SUM(sample_count) AS samples FROM lessons').get();
  return {
    total_lessons: total.n || 0,
    total_samples: total.samples || 0,
    by_category: rows,
    last_updated: db.prepare('SELECT MAX(created_at) AS ts FROM lessons').get()?.ts || null,
  };
}

export function recordLearningRun({ positionsAnalyzed, lessonsGenerated, cooldownsApplied, startedAt, finishedAt, error = null }) {
  const db = getDb();
  return db.prepare(`
    INSERT INTO learning_runs (positions_analyzed, lessons_generated, cooldowns_applied, started_at, finished_at, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    positionsAnalyzed, lessonsGenerated, cooldownsApplied,
    startedAt, finishedAt ?? Math.floor(Date.now() / 1000),
    error,
  );
}

export function getRecentLearningRuns({ limit = 10 } = {}) {
  return getDb().prepare('SELECT * FROM learning_runs ORDER BY started_at DESC LIMIT ?').all(limit);
}

function _deserialize(row) {
  if (!row) return null;
  return {
    ...row,
    tags: row.tags ? JSON.parse(row.tags) : [],
    context: row.context ? JSON.parse(row.context) : null,
  };
}

export const _test = { deriveLesson, _outcome, _confidence, _bucket };