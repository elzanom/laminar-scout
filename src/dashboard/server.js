import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { openDb, getDb } from '../db/index.js';
import * as walletsDb from '../db/wallets.js';
import * as positionsDb from '../db/positions.js';
import * as signalsDb from '../db/signals.js';
import * as marketSnapshotsDb from '../db/market-snapshots.js';
import { log, logAction } from '../utils/logger.js';
import { getSubsystemState, getStalledSubsystems, getCounters, emitHeartbeat } from '../utils/health.js';
import { getConfig } from '../config/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '../../public');

const cfg = () => getConfig();
const POLL_INTERVAL_MS = 5000;

function jsonError(res, status, msg) {
  res.status(status).json({ ok: false, error: msg });
}

function safeQuery(fn) {
  try {
    return { ok: true, data: fn() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  app.get('/api/overview', (_req, res) => {
    const r = safeQuery(() => {
      const totalWallets = walletsDb.countWallets();
      const topWallets = walletsDb.countWallets({ status: 'top' });
      const trackedWallets = walletsDb.countWallets({ status: 'tracked' });
      const candidateWallets = walletsDb.countWallets({ status: 'candidate' });
      const rejectedWallets = walletsDb.countWallets({ status: 'rejected' });
      const totalPositions = positionsDb.countPositions();
      const openPositions = positionsDb.countPositions({ status: 'open' });
      const closedPositions = positionsDb.countPositions({ status: 'closed' });
      const totalSignals = signalsDb.countSignals ? signalsDb.countSignals() : getDb().prepare('SELECT COUNT(*) AS n FROM signals').get().n;
      const pendingSignals = getDb().prepare(`SELECT COUNT(*) AS n FROM signals WHERE status = 'pending'`).get().n;
      const sentSignals = getDb().prepare(`SELECT COUNT(*) AS n FROM signals WHERE status = 'sent'`).get().n;
      const totalSnapshots = marketSnapshotsDb.countSnapshots ? marketSnapshotsDb.countSnapshots() : getDb().prepare('SELECT COUNT(*) AS n FROM market_snapshots').get().n;
      const totalTrainingRecords = getDb().prepare('SELECT COUNT(*) AS n FROM training_records').get().n;
      const exportedRecords = getDb().prepare('SELECT COUNT(*) AS n FROM training_records WHERE exported_at IS NOT NULL').get().n;
      const processedTxs = getDb().prepare('SELECT COUNT(*) AS n FROM processed_txs').get().n;
      return {
        wallets: { total: totalWallets, top: topWallets, tracked: trackedWallets, candidate: candidateWallets, rejected: rejectedWallets },
        positions: { total: totalPositions, open: openPositions, closed: closedPositions },
        signals: { total: totalSignals, pending: pendingSignals, sent: sentSignals },
        snapshots: totalSnapshots,
        training_records: { total: totalTrainingRecords, exported: exportedRecords },
        processed_txs: processedTxs,
        uptime_s: Math.floor(process.uptime()),
        timestamp: Math.floor(Date.now() / 1000),
      };
    });
    if (!r.ok) return jsonError(res, 500, r.error);
    res.json({ ok: true, data: r.data });
  });

  app.get('/api/wallets/top', (req, res) => {
    const limit = Math.min(Number(req.query.limit || 10), 100);
    const r = safeQuery(() => walletsDb.listWallets({ status: 'top' }, { limit }).map((w) => ({
      address: w.address,
      short: w.address.slice(0, 6) + '…' + w.address.slice(-4),
      score: Number((w.score || 0).toFixed(2)),
      win_rate: Number(((w.win_rate || 0) * 100).toFixed(1)),
      total_positions: w.total_positions || 0,
      total_pnl_usd: Number((w.total_pnl_usd || 0).toFixed(2)),
      unique_pools_traded: w.unique_pools_traded || 0,
      last_active: w.last_active,
      source: w.source,
    })));
    if (!r.ok) return jsonError(res, 500, r.error);
    res.json({ ok: true, data: r.data });
  });

  app.get('/api/wallets/recent', (req, res) => {
    const limit = Math.min(Number(req.query.limit || 20), 100);
    const r = safeQuery(() => walletsDb.listWallets({}, { limit }).map((w) => ({
      address: w.address,
      short: w.address.slice(0, 6) + '…' + w.address.slice(-4),
      status: w.status,
      score: Number((w.score || 0).toFixed(2)),
      first_seen: w.first_seen,
      last_active: w.last_active,
      source: w.source,
    })));
    if (!r.ok) return jsonError(res, 500, r.error);
    res.json({ ok: true, data: r.data });
  });

  app.get('/api/signals/recent', (req, res) => {
    const limit = Math.min(Number(req.query.limit || 10), 100);
    const r = safeQuery(() => signalsDb.listSignals({}, { limit }).map((s) => ({
      ...s,
      validation_reasons: s.validation_reasons ? JSON.parse(s.validation_reasons) : [],
    })));
    if (!r.ok) return jsonError(res, 500, r.error);
    res.json({ ok: true, data: r.data });
  });

  app.get('/api/positions/recent', (req, res) => {
    const limit = Math.min(Number(req.query.limit || 10), 100);
    const status = req.query.status || 'closed';
    const r = safeQuery(() => positionsDb.listPositions({ status }, { limit }).map((p) => ({
      id: p.id,
      short: p.id.slice(0, 6) + '…' + p.id.slice(-4),
      wallet_address: p.wallet_address,
      wallet_short: p.wallet_address.slice(0, 6) + '…' + p.wallet_address.slice(-4),
      pool_address: p.pool_address,
      token_pair: p.token_pair,
      entry_timestamp: p.entry_timestamp,
      exit_timestamp: p.exit_timestamp,
      pnl_usd: Number((p.pnl_usd || 0).toFixed(4)),
      pnl_sol: Number((p.pnl_sol || 0).toFixed(4)),
      fees_earned_usd: Number((p.fees_earned_usd || 0).toFixed(4)),
      duration_hours: Number((p.duration_hours || 0).toFixed(2)),
      capital_usd: Number((p.capital_usd || 0).toFixed(2)),
      is_profitable: p.is_profitable,
    })));
    if (!r.ok) return jsonError(res, 500, r.error);
    res.json({ ok: true, data: r.data });
  });

  app.get('/api/health', (_req, res) => {
    const subsystems = getSubsystemState();
    const stalled = getStalledSubsystems();
    const counters = getCounters();
    res.json({
      ok: true,
      data: {
        subsystems,
        stalled,
        counters,
        timestamp: Math.floor(Date.now() / 1000),
      },
    });
  });

  app.get('/api/discovery-sources', (_req, res) => {
    const r = safeQuery(() => {
      const db = getDb();
      const rows = getDb().prepare(`
        SELECT COALESCE(source, 'unknown') AS source, COUNT(*) AS n
        FROM wallets
        GROUP BY source
        ORDER BY n DESC
      `).all();
      const total = rows.reduce((a, r) => a + r.n, 0);
      return { rows, total };
    });
    if (!r.ok) return jsonError(res, 500, r.error);
    res.json({ ok: true, data: r.data });
  });

  app.get('/api/score-distribution', (_req, res) => {
    const r = safeQuery(() => {
      const db = getDb();
      const rows = getDb().prepare(`
        SELECT
          CASE
            WHEN score >= 80 THEN '80-100'
            WHEN score >= 60 THEN '60-80'
            WHEN score >= 40 THEN '40-60'
            WHEN score >= 20 THEN '20-40'
            WHEN score > 0  THEN '1-20'
            ELSE '0'
          END AS bucket,
          COUNT(*) AS n
        FROM wallets
        WHERE score IS NOT NULL
        GROUP BY bucket
        ORDER BY bucket DESC
      `).all();
      return rows;
    });
    if (!r.ok) return jsonError(res, 500, r.error);
    res.json({ ok: true, data: r.data });
  });

  app.get('/api/cron-status', (_req, res) => {
    const r = safeQuery(() => {
      const db = getDb();
      const rows = getDb().prepare(`
        SELECT key, value FROM meta WHERE key LIKE 'last_%' OR key LIKE 'cron_%' ORDER BY key
      `).all();
      const obj = {};
      for (const r of rows) obj[r.key] = r.value;
      return obj;
    });
    if (!r.ok) return jsonError(res, 500, r.error);
    res.json({ ok: true, data: r.data });
  });

  app.get('/api/discovery-recent', (req, res) => {
    const r = safeQuery(() => getDb().prepare(`
        SELECT wallet_address, discovery_source, source_detail, discovered_at
        FROM wallet_discovery_log
        ORDER BY discovered_at DESC
        LIMIT ?
      `).all(Math.min(Number(req.query.limit) || 20, 100)));
    if (!r.ok) return jsonError(res, 500, r.error);
    res.json({ ok: true, data: r.data });
  });

  app.use(express.static(PUBLIC_DIR, { index: 'index.html', extensions: ['html'] }));

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  return app;
}

let server = null;

export function startDashboard(opts = {}) {
  const port = opts.port || Number(process.env.DASHBOARD_PORT || 3002);
  openDb();
  const app = createApp();
  server = app.listen(port, () => {
    log('info', `dashboard: started on :${port}`, { pollIntervalMs: POLL_INTERVAL_MS });
    logAction('dashboard.start', { port });
    emitHeartbeat();
  });
  return {
    port,
    stop() {
      return new Promise((resolve) => {
        if (!server) return resolve();
        server.close(() => {
          log('info', 'dashboard: stopped');
          logAction('dashboard.stop');
          resolve();
        });
      });
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startDashboard();
}