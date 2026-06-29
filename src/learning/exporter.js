import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getDb } from '../db/index.js';
import { getConfig } from '../config/config.js';
import { log, logAction } from '../utils/logger.js';
import { recordSuccess, recordError, incrCounter } from '../utils/health.js';

const DEFAULT_EXPORT_DIR = './learning-exports';

function _getExportDir() {
  const cfg = getConfig();
  return process.env.SCOUT_LEARNING_EXPORT_DIR
    || cfg.learning?.exportDir
    || DEFAULT_EXPORT_DIR;
}

function _nowIso() {
  return new Date().toISOString();
}

function _rowToLesson(row) {
  if (!row) return null;
  let ctx = row.context;
  if (typeof ctx === 'string') {
    try { ctx = JSON.parse(ctx); } catch { ctx = { raw: ctx }; }
  }
  let tags = row.tags;
  if (typeof tags === 'string') {
    try { tags = JSON.parse(tags); } catch { tags = []; }
  }
  const createdIso = row.created_at
    ? new Date(Number(row.created_at) * 1000).toISOString()
    : _nowIso();
  const ctxFlat = ctx && typeof ctx === 'object'
    ? Object.entries(ctx)
      .filter(([k]) => !['token_pair', 'pool_bin_step', 'pool_tvl', 'pool_volume_24h', 'fee_tvl_ratio', 'organic', 'pnl_pct', 'fee_yield', 'out_of_range'].includes(k))
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')
    : '';
  const ctxStr = ctx && typeof ctx === 'object'
    ? Object.entries(ctx)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')
    : String(ctx || '');
  return {
    id: `scout:lesson:${row.id}`,
    rule: row.rule,
    tags: tags || [],
    role: null,
    outcome: row.outcome,
    sourceType: 'scout_learning',
    score: Number(row.confidence || 0.5),
    confidence: Number(row.confidence || 0.5),
    pinned: false,
    context: ctxStr,
    sample_count: row.sample_count || 1,
    pool: row.pool_address || null,
    category: row.category || null,
    source: row.source || 'auto',
    created_at: createdIso,
  };
}

function _rowToPerformance(row) {
  if (!row) return null;
  return {
    position: row.id?.toString() || row.position_id || null,
    pool: row.pool_address || null,
    pool_name: row.token_pair || null,
    base_mint: row.token_pair_base_mint || null,
    strategy: row.wallet_is_top_at_entry ? 'top_wallet' : 'tracked_wallet',
    bin_range: {
      min: row.bin_lower,
      max: row.bin_upper,
      bins_below: row.bin_range_width,
    },
    bin_step: row.pool_bin_step,
    fee_tvl_ratio: row.fee_tvl_ratio,
    organic_score: row.token_x_organic_score,
    fees_earned_usd: row.fee_earned_usd,
    final_value_usd: row.fee_earned_usd,
    initial_value_usd: row.capital_usd,
    pnl_pct: row.pnl_pct,
    pnl_usd: row.pnl_usd,
    pnl_sol: row.pnl_sol,
    range_efficiency: row.is_out_of_range === 1 ? 0 : 100,
    close_reason: 'scout_tracked_close',
    impermanent_loss_usd: row.impermanent_loss_usd,
    impermanent_loss_pct: row.impermanent_loss_pct,
    wallet: row.wallet_address,
    pool_address: row.pool_address,
    token_pair: row.token_pair,
    close_timestamp: row.close_timestamp,
    entry_timestamp: row.entry_timestamp,
    duration_hours: row.duration_hours,
  };
}

function _rowToCooldown(row) {
  if (!row) return null;
  const untilIso = new Date(Number(row.cooldown_until) * 1000).toISOString();
  return {
    pool: row.pool_address,
    pool_address: row.pool_address,
    reason: row.reason,
    sample_count: row.sample_count,
    win_rate: Number(row.win_rate),
    cooldown_until: Number(row.cooldown_until),
    cooldown_until_iso: untilIso,
    auto_evolved_at: Number(row.auto_evolved_at),
    auto_evolved_at_iso: new Date(Number(row.auto_evolved_at) * 1000).toISOString(),
  };
}

export function exportLessons({ limit = 500, sinceDays = null, outputDir = null } = {}) {
  const db = getDb();
  const dir = outputDir || _getExportDir();
  mkdirSync(dir, { recursive: true });

  let sinceTs = null;
  if (sinceDays) sinceTs = Math.floor(Date.now() / 1000) - sinceDays * 86400;

  const lessons = db.prepare(`
    SELECT * FROM lessons
    WHERE ? IS NULL OR created_at >= ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(sinceTs, sinceTs, limit).map(_rowToLesson).filter(Boolean);

  const payload = {
    schema: 'laminar-scout-lessons-v1',
    exported_at: _nowIso(),
    total: lessons.length,
    source: 'laminar-scout',
    lessons,
    meta: {
      compatible_with: ['vipera', 'laminar'],
      fields_mapping: {
        rule: 'lesson text (PREFER/AVOID/WORKED/FAILED)',
        confidence: '0-1 score (0.35 base + bonuses)',
        outcome: 'good | bad | poor | neutral | unknown',
        sourceType: 'scout_learning (instead of performance for compatibility)',
        context: 'stringified context (matches vipera string format)',
        pool: 'pool_address',
      },
    },
  };

  const outPath = resolve(dir, 'lessons.json');
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  logAction('learning.export.lessons', { path: outPath, count: lessons.length });
  incrCounter('learning.export.lessons', lessons.length);
  return { path: outPath, count: lessons.length };
}

export function exportPoolCooldowns({ outputDir = null } = {}) {
  const db = getDb();
  const dir = outputDir || _getExportDir();
  mkdirSync(dir, { recursive: true });

  const rows = db.prepare('SELECT * FROM pool_cooldown ORDER BY cooldown_until DESC').all();
  const cooldowns = rows.map(_rowToCooldown).filter(Boolean);

  const byPool = {};
  for (const cd of cooldowns) {
    byPool[cd.pool] = {
      pool_address: cd.pool,
      cooldown_until: cd.cooldown_until,
      cooldown_until_iso: cd.cooldown_until_iso,
      reason: cd.reason,
      sample_count: cd.sample_count,
      win_rate: cd.win_rate,
      auto_evolved_at_iso: cd.auto_evolved_at_iso,
      source: 'laminar-scout',
    };
  }

  const payload = {
    schema: 'laminar-scout-pool-cooldowns-v1',
    exported_at: _nowIso(),
    total: cooldowns.length,
    active_count: cooldowns.filter((c) => c.cooldown_until * 1000 > Date.now()).length,
    source: 'laminar-scout',
    cooldowns: byPool,
    meta: {
      compatible_with: ['vipera (pool-memory.json cooldowns)', 'laminar'],
      fields_mapping: {
        cooldown_until: 'unix timestamp seconds',
        cooldown_until_iso: 'ISO 8601 string',
        win_rate: 'decimal 0-1',
        sample_count: 'number of positions analyzed',
      },
    },
  };

  const outPath = resolve(dir, 'pool-cooldowns.json');
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  logAction('learning.export.cooldowns', { path: outPath, count: cooldowns.length });
  incrCounter('learning.export.cooldowns', cooldowns.length);
  return { path: outPath, count: cooldowns.length };
}

export function exportPerformanceSnapshot({ limit = 100, outputDir = null } = {}) {
  const db = getDb();
  const dir = outputDir || _getExportDir();
  mkdirSync(dir, { recursive: true });

  const rows = db.prepare(`
    SELECT * FROM training_records
    WHERE close_timestamp IS NOT NULL
    ORDER BY close_timestamp DESC
    LIMIT ?
  `).all(limit).map(_rowToPerformance).filter(Boolean);

  const payload = {
    schema: 'laminar-scout-performance-v1',
    exported_at: _nowIso(),
    total: rows.length,
    source: 'laminar-scout',
    performance: rows,
    meta: {
      compatible_with: ['vipera (lessons.json performance array)'],
      fields_mapping: {
        pnl_pct: 'decimal (0.05 = 5%)',
        range_efficiency: '100 if in range else 0 (binary — vipera computes continuous)',
        close_reason: '"scout_tracked_close" (scout is read-only, no manual close)',
        strategy: 'inferred from wallet tier at entry',
      },
    },
  };

  const outPath = resolve(dir, 'performance.json');
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  logAction('learning.export.performance', { path: outPath, count: rows.length });
  incrCounter('learning.export.performance', rows.length);
  return { path: outPath, count: rows.length };
}

export function exportAll({ limit = 500, sinceDays = null, outputDir = null } = {}) {
  const dir = outputDir || _getExportDir();
  mkdirSync(dir, { recursive: true });

  const lessons = exportLessons({ limit, sinceDays, outputDir: dir });
  const cooldowns = exportPoolCooldowns({ outputDir: dir });
  const performance = exportPerformanceSnapshot({ limit, outputDir: dir });

  const manifest = {
    schema: 'laminar-scout-learning-bundle-v1',
    exported_at: _nowIso(),
    source: 'laminar-scout',
    files: {
      lessons: lessons.path,
      pool_cooldowns: cooldowns.path,
      performance: performance.path,
    },
    counts: {
      lessons: lessons.count,
      cooldowns: cooldowns.count,
      performance: performance.count,
    },
    compatibility: {
      vipera: 'lessons.json + pool-memory.json (cooldowns field)',
      laminar: 'training-records.csv (already exported)',
      hivemind: 'lessons.json can be ingested if Hivemind endpoint extended',
    },
    usage: {
      vipera_ingest: 'Copy lessons.json to vipera/lessons.json, scout lessons will appear as new entries with sourceType="scout_learning"',
      laminar_ingest: 'Read pool-cooldowns.json to skip bad pools, read performance.json for ML training',
    },
  };

  const manifestPath = resolve(dir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  logAction('learning.export.all', {
    lessons: lessons.count, cooldowns: cooldowns.count, performance: performance.count,
  });

  return {
    manifest: manifestPath,
    files: manifest.files,
    counts: manifest.counts,
  };
}

export const _test = { _rowToLesson, _rowToPerformance, _rowToCooldown };