import { getDb } from '../db/index.js';
import { log, logAction } from '../utils/logger.js';
import { recordSuccess, recordError, incrCounter } from '../utils/health.js';

const DEFAULT_COOLDOWN_HOURS = 24;
const DEFAULT_MIN_SAMPLES = 5;
const DEFAULT_BAD_WR_THRESHOLD = 0.40;

export function computePoolStats({ minSamples = DEFAULT_MIN_SAMPLES, badWrThreshold = DEFAULT_BAD_WR_THRESHOLD, since = null } = {}) {
  const db = getDb();
  const params = [];
  let sinceClause = '';
  if (since) {
    sinceClause = ' AND close_timestamp >= ?';
    params.push(since);
  }
  const rows = db.prepare(`
    SELECT
      pool_address,
      COUNT(*) AS sample_count,
      SUM(CASE WHEN was_profitable = 1 THEN 1 ELSE 0 END) AS wins,
      AVG(pnl_usd) AS avg_pnl_usd,
      AVG(fee_yield) AS avg_fee_yield,
      AVG(impermanent_loss_pct) AS avg_il_pct,
      MAX(close_timestamp) AS last_close_at
    FROM training_records
    WHERE pool_address IS NOT NULL${sinceClause}
    GROUP BY pool_address
    HAVING sample_count >= ?
  `).all(...params, minSamples);

  return rows.map((r) => {
    const wr = r.wins / r.sample_count;
    const avgPnl = r.avg_pnl_usd || 0;
    return {
      pool_address: r.pool_address,
      sample_count: r.sample_count,
      wins: r.wins,
      win_rate: wr,
      avg_pnl_usd: avgPnl,
      avg_fee_yield: r.avg_fee_yield || 0,
      avg_il_pct: r.avg_il_pct || 0,
      last_close_at: r.last_close_at,
      is_bad: wr < badWrThreshold && avgPnl < 0,
      severity: wr < 0.20 ? 'severe' : wr < 0.35 ? 'high' : 'moderate',
    };
  });
}

export function applyCooldown(poolAddress, reason, sampleCount, winRate, hours = DEFAULT_COOLDOWN_HOURS) {
  const db = getDb();
  const cooldownUntil = Math.floor(Date.now() / 1000) + hours * 3600;
  try {
    db.prepare(`
      INSERT INTO pool_cooldown (pool_address, reason, sample_count, win_rate, cooldown_until, auto_evolved_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(pool_address) DO UPDATE SET
        reason = excluded.reason,
        sample_count = excluded.sample_count,
        win_rate = excluded.win_rate,
        cooldown_until = excluded.cooldown_until,
        auto_evolved_at = excluded.auto_evolved_at
    `).run(poolAddress, reason, sampleCount, winRate, cooldownUntil, Math.floor(Date.now() / 1000));
    incrCounter('learning.cooldown.applied');
    logAction('learning.cooldown.applied', { pool: poolAddress, hours, win_rate: winRate, sample_count: sampleCount });
    return cooldownUntil;
  } catch (err) {
    recordError('learning.cooldown', err, { pool: poolAddress });
    return null;
  }
}

export function clearCooldown(poolAddress) {
  const db = getDb();
  const r = db.prepare('DELETE FROM pool_cooldown WHERE pool_address = ?').run(poolAddress);
  if (r.changes > 0) incrCounter('learning.cooldown.cleared');
  return r.changes > 0;
}

export function getActiveCooldowns() {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  return db.prepare('SELECT * FROM pool_cooldown WHERE cooldown_until > ? ORDER BY cooldown_until DESC').all(now);
}

export function isPoolOnCooldown(poolAddress) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare('SELECT cooldown_until, reason FROM pool_cooldown WHERE pool_address = ? AND cooldown_until > ?')
    .get(poolAddress, now);
  return row ? { until: row.cooldown_until, reason: row.reason } : null;
}

export function getCooldownPoolAddresses() {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  return db.prepare('SELECT pool_address FROM pool_cooldown WHERE cooldown_until > ?').all(now)
    .map((r) => r.pool_address);
}

export function runAutoCooldown({ minSamples, badWrThreshold, hours, dryRun = false, since = null } = {}) {
  const stats = computePoolStats({ minSamples, badWrThreshold, since });
  const candidates = stats.filter((s) => s.is_bad);
  const applied = [];
  for (const s of candidates) {
    const reason = `Auto-cooldown: WR ${(s.win_rate * 100).toFixed(1)}% in last ${s.sample_count} positions, avg PnL $${s.avg_pnl_usd.toFixed(2)}`;
    if (!dryRun) {
      applyCooldown(s.pool_address, reason, s.sample_count, s.win_rate, hours);
    }
    applied.push({ pool: s.pool_address, ...s, reason });
  }
  incrCounter('learning.cooldown.cycle', applied.length);
  return { candidates: candidates.length, applied: applied.length, details: applied };
}

export const _test = { computePoolStats, runAutoCooldown };