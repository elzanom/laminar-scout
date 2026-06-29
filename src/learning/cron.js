import { getDb } from '../db/index.js';
import { getConfig } from '../config/config.js';
import { log, logAction } from '../utils/logger.js';
import { recordSuccess, recordError, incrCounter } from '../utils/health.js';
import {
  recordLessonFromRecord,
  recordLearningRun,
  listLessons,
  getLessonsSummary,
} from './lessons.js';
import {
  runAutoCooldown,
  getActiveCooldowns,
} from './cooldown.js';
import {
  exportLessons,
  exportPoolCooldowns,
  exportPerformanceSnapshot,
  exportAll,
} from './exporter.js';

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_LOOKBACK_HOURS = 168;

export async function runLearningCycle(opts = {}) {
  const cfg = getConfig();
  const learning = cfg.learning || {};
  const batchSize = opts.batchSize || learning.batchSize || DEFAULT_BATCH_SIZE;
  const lookbackHours = opts.lookbackHours || learning.lookbackHours || DEFAULT_LOOKBACK_HOURS;
  const dryRun = opts.dryRun ?? false;
  const cooldownHours = opts.cooldownHours || learning.cooldownHours || 24;
  const minSamples = opts.minSamples || learning.minSamples || 5;
  const badWrThreshold = opts.badWrThreshold || learning.badWrThreshold || 0.40;

  const startedAt = Math.floor(Date.now() / 1000);
  const sinceTs = startedAt - lookbackHours * 3600;

  let positionsAnalyzed = 0;
  let lessonsGenerated = 0;
  let cooldownsApplied = 0;
  let error = null;

  try {
    const db = getDb();
    const positions = db.prepare(`
      SELECT *
      FROM training_records
      WHERE close_timestamp IS NOT NULL
        AND close_timestamp >= ?
      ORDER BY close_timestamp DESC
      LIMIT ?
    `).all(sinceTs, batchSize);

    positionsAnalyzed = positions.length;
    log('info', 'learning: cycle start', {
      batch_size: batchSize, lookback_hours: lookbackHours,
      positions_to_analyze: positions.length, dry_run: dryRun,
    });

    if (!dryRun) {
      for (const rec of positions) {
        const result = recordLessonFromRecord(rec);
        if (result && !result.dedup) lessonsGenerated += 1;
      }
    } else {
      for (const rec of positions) {
        const lesson = (await import('./lessons.js')).deriveLesson(rec);
        if (lesson) lessonsGenerated += 1;
      }
    }

    const cooldownResult = runAutoCooldown({ minSamples, badWrThreshold, hours: cooldownHours, dryRun, since: sinceTs });
    cooldownsApplied = cooldownResult.applied;

    incrCounter('learning.cycle.run');
    recordSuccess('learning.cycle', {
      positions_analyzed: positionsAnalyzed,
      lessons_generated: lessonsGenerated,
      cooldowns_applied: cooldownsApplied,
    });

    if (!dryRun) {
      recordLearningRun({
        positionsAnalyzed,
        lessonsGenerated,
        cooldownsApplied,
        startedAt,
      });
    }

    log('info', 'learning: cycle complete', {
      positions_analyzed: positionsAnalyzed,
      lessons_generated: lessonsGenerated,
      cooldowns_applied: cooldownsApplied,
      cooldown_candidates: cooldownResult.candidates,
    });

    logAction('learning.cycle', {
      positions_analyzed: positionsAnalyzed,
      lessons_generated: lessonsGenerated,
      cooldowns_applied: cooldownsApplied,
    });

    if (!dryRun) {
      try {
        const exportResult = exportAll({ batchSize, sinceDays: Math.ceil(lookbackHours / 24), outputDir: null });
        log('info', 'learning: export complete', {
          manifest: exportResult.manifest,
          counts: exportResult.counts,
        });
      } catch (exportErr) {
        log('warn', 'learning: export failed (non-fatal)', { error: exportErr.message });
      }
    }

    return {
      ok: true,
      positions_analyzed: positionsAnalyzed,
      lessons_generated: lessonsGenerated,
      cooldowns_applied: cooldownsApplied,
      duration_ms: Math.floor(Date.now() / 1000) - startedAt,
      dry_run: dryRun,
    };
  } catch (err) {
    error = err.message || String(err);
    recordError('learning.cycle', err);
    log('error', 'learning: cycle failed', { error: error });
    recordLearningRun({
      positionsAnalyzed,
      lessonsGenerated,
      cooldownsApplied,
      startedAt,
      error,
    });
    return { ok: false, error, positions_analyzed: positionsAnalyzed, lessons_generated: lessonsGenerated, cooldowns_applied: cooldownsApplied };
  }
}

export function getLearningStatus() {
  return {
    summary: getLessonsSummary(),
    active_cooldowns: getActiveCooldowns(),
    recent_lessons: listLessons({ limit: 20 }),
  };
}

export async function getLessonForPool(poolAddress) {
  return listLessons({ since: null }).filter((l) => {
    try {
      const ctx = typeof l.context === 'string' ? JSON.parse(l.context) : l.context;
      return ctx?.pool_address === poolAddress || l.pool_address === poolAddress;
    } catch {
      return l.pool_address === poolAddress;
    }
  });
}