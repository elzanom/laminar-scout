import cron from 'node-cron';
import { getConfig, reloadConfig } from './config/config.js';
import { openDb, closeDb, dbStats } from './db/index.js';
import {
  configureHealth,
  emitHeartbeat,
  recordSuccess,
  recordError,
  getAllState,
} from './utils/health.js';
import { log, shutdownLogger, logAction } from './utils/logger.js';
import { POSITION_V2, PROGRAM_IDS } from './constants.js';
import * as discovery from './discovery/index.js';
import * as poolScreener from './screener/pool-screener.js';
import * as metricsFetcher from './screener/metrics-fetcher.js';
import * as marketSnapshots from './db/market-snapshots.js';
import * as signalsValidator from './signals/validator.js';
import * as signalsEmitter from './signals/emitter.js';
import * as recordBuilder from './dataset/record-builder.js';
import * as datasetExporter from './dataset/exporter.js';
import * as walletRanker from './wallets/wallet-ranker.js';
import * as walletFilter from './wallets/wallet-filter.js';
import * as positionsDb from './db/positions.js';
import * as walletsDb from './db/wallets.js';
import * as positionBuilder from './trackers/position-builder.js';
import {
  startWebhookServer,
  stopWebhookServer,
  startPollingLoop,
  stopPollingLoop,
} from './collector/helius-stream.js';
import { startTxMining } from './discovery/tx-mining.js';
import { onTxEvent, TX_EVENT_TYPES } from './collector/event-bus.js';

function banner() {
  const cfg = getConfig();
  log('info', 'laminar-scout starting');
  log('info', `meteora program id: ${cfg.meteora.programId}`);
  log('info', `dlmm program (constant): ${PROGRAM_IDS.DLMM}`);
  log('info', `position V2 size: ${POSITION_V2.ACCOUNT_SIZE}, owner offset: ${POSITION_V2.OFFSET_OWNER}`);
  log('info', `log dir: ${cfg.runtime.logDir}, data dir: ${cfg.runtime.dataDir}`);
  log('info', `discovery enabled: ${cfg.discovery.enabled}, webhook: ${cfg.helius.webhookEnabled}, polling fallback: ${cfg.helius.pollingFallbackEnabled}`);
}

function runSmoke() {
  const db = openDb();
  recordSuccess('startup', { pid: process.pid });
  const stats = dbStats();
  log('info', 'db: ready', stats);
  configureHealth({
    logDir: getConfig().runtime.logDir,
    healthHeartbeatMinutes: getConfig().health.heartbeatMinutes,
    healthStallWarnMinutes: getConfig().health.stallWarnMinutes,
  });
  emitHeartbeat(true);
  log('info', 'foundation smoke complete');
  return stats;
}

const busy = new Map();
async function withBusy(name, fn) {
  if (busy.get(name)) {
    log('info', `cron: ${name} already running, skipping`);
    return null;
  }
  busy.set(name, true);
  const started = Date.now();
  try {
    const result = await fn();
    log('info', `cron: ${name} done`, { duration_ms: Date.now() - started });
    return result;
  } catch (err) {
    recordError(`cron.${name}`, err);
    log('error', `cron: ${name} failed`, { error: err.message });
    return null;
  } finally {
    busy.set(name, false);
  }
}

async function cronDiscoveryCycle() {
  const cfg = getConfig();
  if (!cfg.discovery.enabled) return;
  const limit = cfg.discovery.maxWalletCandidatesPerCycle;
  const timeframe = cfg.poolScreening.timeframe;
  if (cfg.discovery.poolDiscoveryEnabled) {
    const r = await discovery.discoverFromTopPools({ limit, timeframe, useAgentMeridian: cfg.agentMeridian.enabled });
    logAction('cron.discovery.pool', r);
  }
  if (cfg.discovery.followWinnersEnabled) {
    const r = await discovery.discoverFromAllTopWallets({ limit });
    logAction('cron.discovery.follow', r);
  }
  return { ok: true };
}

async function cronEvaluationQueue() {
  const cfg = getConfig();
  if (!cfg.discovery.enabled) return;
  const limit = Math.max(1, Math.min(20, Math.floor((cfg.discovery.maxWalletCandidatesPerCycle || 100) / 5)));
  return discovery.processEvaluationQueue({ limit });
}

async function cronRanking() {
  const cfg = getConfig();
  if (!cfg.discovery.enabled) return;
  walletFilter.applyTierFilters();
  const limit = Math.min(50, cfg.topWalletLimit || 100);
  return walletRanker.rankAllTracked({ limit });
}

async function cronScreening() {
  const cfg = getConfig();
  const tf = cfg.poolScreening.timeframe || '4h';
  const result = await poolScreener.getTopCandidates({ limit: 10, timeframe: tf });
  return result;
}

async function cronMarketSnapshots() {
  const open = positionsDb.listOpenPositions();
  const dedupPools = new Set();
  for (const p of open) dedupPools.add(p.pool_address);
  let saved = 0;
  for (const pool of dedupPools) {
    try {
      const meta = await metricsFetcher.fetchMeteoraPoolMeta(pool);
      if (!meta) continue;
      marketSnapshots.insertSnapshot({
        pool_address: pool,
        timestamp: Math.floor(Date.now() / 1000),
        fee_apr: meta.fee_pct || null,
        volume_24h: meta.volume_window || null,
        tvl: meta.tvl || null,
        fee_tvl_ratio: meta.fee_active_tvl_ratio || null,
        active_bin: null,
        price: meta.price || null,
      });
      saved += 1;
    } catch (err) {
      recordError('cron.snapshot', err, { pool });
    }
  }
  return { pools: dedupPools.size, saved };
}

async function cronSignalMaintenance() {
  const expired = signalsEmitter.expireStaleSignals();
  return { expired };
}

async function cronDatasetExport() {
  const cfg = getConfig();
  if (!cfg.dataset?.autoExportOnClose) return null;
  return datasetExporter.exportUnexported({});
}

function buildCronTable() {
  const cfg = getConfig();
  return [
    { name: 'discovery', expr: `*/${Math.max(1, cfg.discovery.intervalMinutes || 60)} * * * *`, task: cronDiscoveryCycle },
    { name: 'evaluation', expr: '*/10 * * * *', task: cronEvaluationQueue },
    { name: 'ranking', expr: `*/${Math.max(15, cfg.collection.walletRankUpdateIntervalMinutes || 60)} * * * *`, task: cronRanking },
    { name: 'screening', expr: `*/${Math.max(5, cfg.collection.screeningIntervalMinutes || 30)} * * * *`, task: cronScreening },
    { name: 'snapshots', expr: `*/${Math.max(5, cfg.collection.snapshotIntervalMinutes || 15)} * * * *`, task: cronMarketSnapshots },
    { name: 'signal-maintenance', expr: '*/5 * * * *', task: cronSignalMaintenance },
    { name: 'dataset-export', expr: '0 */1 * * *', task: cronDatasetExport },
  ];
}

const cronHandles = [];
const liveHandles = [];
let webhookServer = null;

async function startCron() {
  for (const { name, expr, task } of buildCronTable()) {
    if (!cron.validate(expr)) {
      log('warn', `cron: invalid expression for ${name}`, { expr });
      continue;
    }
    const handle = cron.schedule(expr, () => withBusy(name, task));
    cronHandles.push({ name, handle });
    log('info', `cron: scheduled ${name} expr=${expr}`);
  }
}

function startLiveHandlers() {
  const pb = positionBuilder.startPositionBuilder();
  liveHandles.push(pb);

  const rb = recordBuilder.startRecordBuilder();
  liveHandles.push(rb);

  const tm = startTxMining();
  liveHandles.push(tm);

  onTxEvent(TX_EVENT_TYPES.POSITION_OPEN, async (event) => {
    if (!event?.wallet || !event?.pool) return;
    const walletRow = walletsDb.getWallet(event.wallet);
    if (!walletRow || (walletRow.is_top_wallet !== 1 && walletRow.status !== 'top')) return;
    const validated = await signalsValidator.validateSignal({
      walletAddress: event.wallet,
      poolAddress: event.pool,
      triggerType: 'wallet_entry',
      triggeredBy: event.wallet,
      position: event.position,
    });
    if (validated.pass) {
      const emitted = await signalsEmitter.emitSignal(validated);
      logAction('signal.live.emitted', emitted);
    }
  });

  log('info', 'live: started position-builder, record-builder, tx-mining, signal-on-open');
}

async function startWebhook() {
  const cfg = getConfig();
  if (!cfg.helius.webhookEnabled) {
    log('info', 'webhook: disabled by config');
    return;
  }
  try {
    webhookServer = await startWebhookServer(cfg.webhook.port);
    log('info', `webhook: started on port ${cfg.webhook.port}`);
  } catch (err) {
    recordError('webhook.start', err);
    log('warn', 'webhook: failed to start', { error: err.message });
  }
}

function startPolling() {
  const cfg = getConfig();
  if (!cfg.helius.pollingFallbackEnabled) {
    log('info', 'polling: disabled by config');
    return;
  }
  startPollingLoop();
  log('info', `polling: started with ${cfg.helius.pollingIntervalSeconds}s interval`);
}

async function shutdown(signal) {
  log('info', `laminar-scout: received ${signal}, shutting down`);
  try {
    for (const h of cronHandles) h.handle.stop();
  } catch (err) { log('warn', 'shutdown: cron stop error', { error: err.message }); }
  try {
    for (const h of liveHandles) { try { h.stop?.(); } catch {} }
  } catch (err) { log('warn', 'shutdown: live stop error', { error: err.message }); }
  try { if (webhookServer) await stopWebhookServer(webhookServer); } catch {}
  try { stopPollingLoop(); } catch {}
  try { emitHeartbeat(false); } catch {}
  try { closeDb(); } catch (err) { log('warn', 'shutdown: db close error', { error: err.message }); }
  try { shutdownLogger(); } catch {}
  process.exit(0);
}

function installSignalHandlers() {
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => shutdown(sig));
  }
  process.on('uncaughtException', (err) => {
    recordError('uncaught', err);
    log('error', 'uncaught exception', { error: err.message, stack: err.stack });
  });
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    recordError('unhandled_rejection', err);
    log('error', 'unhandled rejection', { error: err.message });
  });
}

async function main() {
  installSignalHandlers();
  banner();
  const stats = runSmoke();
  log('info', `laminar-scout: foundation ready (tables=${stats.tables.length})`);

  const cfg = getConfig();
  if (cfg.discovery.enabled) {
    await startCron();
    startLiveHandlers();
  } else {
    log('info', 'discovery disabled; skipping cron + live handlers');
  }

  await startWebhook();
  startPolling();

  log('info', 'laminar-scout: running');
}

main().catch((err) => {
  log('error', 'laminar-scout: fatal', { error: err.message, stack: err.stack });
  process.exit(1);
});