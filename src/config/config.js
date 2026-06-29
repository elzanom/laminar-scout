import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { PROGRAM_IDS, KNOWN_MINTS, POSITION_V2 } from '../constants.js';

dotenv.config();

function readJsonIfExists(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function findConfigFile() {
  const candidates = [
    process.env.SCOUT_CONFIG_PATH,
    path.resolve(process.cwd(), 'scout-config.json'),
    path.resolve(process.cwd(), 'config/scout-config.json'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function bool(v, d) {
  if (v === undefined || v === null || v === '') return d;
  if (typeof v === 'boolean') return v;
  return /^(1|true|yes|on)$/i.test(String(v));
}

function loadFileConfig() {
  const file = findConfigFile();
  if (!file) return {};
  return readJsonIfExists(file);
}

function buildConfig() {
  const fileCfg = loadFileConfig();

  const cfg = {
    configPath: findConfigFile(),

    meteora: {
      programId: fileCfg.meteoraProgramId || PROGRAM_IDS.DLMM,
      positionV2: POSITION_V2,
    },

    knownMints: KNOWN_MINTS,

    helius: {
      apiKey: process.env.HELIUS_API_KEY || '',
      rpcUrl: process.env.HELIUS_RPC_URL || '',
      webhookSecret: process.env.HELIUS_WEBHOOK_SECRET || '',
      webhookEnabled: bool(fileCfg.webhookEnabled, true),
      pollingFallbackEnabled: bool(fileCfg.pollingFallbackEnabled, true),
      pollingIntervalSeconds: num(fileCfg.pollingIntervalSeconds, 30),
      rateLimitPerMinute: num(fileCfg.heliusRateLimitPerMinute, 60),
    },

    birdeye: {
      apiKey: process.env.BIRDEYE_API_KEY || '',
    },

    gmgn: {
      // NOTE: gmgn.ai REST endpoints are Cloudflare-gated and return 403
      // server-side even with a valid x-api-key. Use gmgn-cli locally to
      // backfill from GMGN, then pipe into the dataset. Reserved for future.
      apiKey: process.env.GMGN_API_KEY || '',
      baseUrl: 'https://gmgn.ai/defi/quotation/v1',
      enabled: false,
    },

    jupiter: {
      apiKey: process.env.JUPITER_API_KEY || '',
      baseUrl: 'https://api.jup.ag',
    },

    webhook: {
      port: num(process.env.WEBHOOK_PORT, 3001),
    },

    runtime: {
      logLevel: (process.env.LOG_LEVEL || fileCfg.logLevel || 'info').toLowerCase(),
      logDir: process.env.LOG_DIR || fileCfg.logDir || './logs',
      dataDir: process.env.DATA_DIR || fileCfg.dataDir || './data',
      dryRun: bool(process.env.DRY_RUN, true),
    },

    retry: {
      maxAttempts: num(fileCfg.retryMaxAttempts, 5),
      maxElapsedMs: num(fileCfg.retryMaxElapsedMs, 60_000),
      perAttemptTimeoutMs: num(fileCfg.retryPerAttemptTimeoutMs, 15_000),
    },

    discovery: {
      enabled: bool(fileCfg.discoveryEnabled, true),
      intervalMinutes: num(fileCfg.discoveryIntervalMinutes, 60),
      poolDiscoveryEnabled: bool(fileCfg.poolDiscoveryEnabled, true),
      txMiningEnabled: bool(fileCfg.txMiningEnabled, true),
      followWinnersEnabled: bool(fileCfg.followWinnersEnabled, true),
      maxWalletCandidatesPerCycle: num(fileCfg.maxWalletCandidatesPerCycle, 100),
      minPositionsToEvaluate: num(fileCfg.minPositionsToEvaluate, 10),
      evaluationBackfillDays: num(fileCfg.evaluationBackfillDays, 90),
      reEvaluateIntervalHours: num(fileCfg.reEvaluateIntervalHours, 168),
    },

    walletTier: {
      minWalletScore: num(fileCfg.minWalletScore, 45),
      minWinRate: num(fileCfg.minWinRate, 0.65),
      minTotalPositions: num(fileCfg.minTotalPositions, 20),
      minFeeYield: num(fileCfg.minFeeYield, 0.5),
      topWalletLimit: num(fileCfg.topWalletLimit, 100),
      autoPromoteToTracked: bool(fileCfg.autoPromoteToTracked, true),
      autoDemoteTopWallet: bool(fileCfg.autoDemoteTopWallet, true),
    },

    poolScreening: {
      onlySolPairs: bool(fileCfg.onlySolPairs, true),
      minFeeActiveTvlRatio: num(fileCfg.minFeeActiveTvlRatio, 0.05),
      minTvl: num(fileCfg.minTvl, 10_000),
      maxTvl: num(fileCfg.maxTvl, 150_000),
      minVolume: num(fileCfg.minVolume, 500),
      minOrganic: num(fileCfg.minOrganic, 60),
      minBinStep: num(fileCfg.minBinStep, 80),
      maxBinStep: num(fileCfg.maxBinStep, 125),
      minTokenFeesSol: num(fileCfg.minTokenFeesSol, 30),
      timeframe: fileCfg.screeningTimeframe || '4h',
      category: fileCfg.poolDiscoveryCategory || 'trending',
    },

    signal: {
      minCombinedConfidence: num(fileCfg.minCombinedConfidence, 0.70),
      expiryMinutes: num(fileCfg.signalExpiryMinutes, 60),
      dedupWindowMinutes: num(fileCfg.signalDedupWindowMinutes, 15),
      outputMode: fileCfg.signalOutputMode || 'file',
      outputPath: fileCfg.signalOutputPath || './signals-output.json',
      apiEndpoint: fileCfg.signalApiEndpoint || '',
    },

    collection: {
      backfillDays: num(fileCfg.backfillDays, 90),
      snapshotIntervalMinutes: num(fileCfg.snapshotIntervalMinutes, 15),
      walletRankUpdateIntervalMinutes: num(fileCfg.walletRankUpdateIntervalMinutes, 60),
      screeningIntervalMinutes: num(fileCfg.screeningIntervalMinutes, 30),
    },

    dataset: {
      exportPath: fileCfg.datasetExportPath || './dataset/training-records.csv',
      autoExportOnClose: bool(fileCfg.autoExportOnClose, true),
    },

    seed: {
      walletsFile: fileCfg.seedWalletsFile || '',
      onStartup: bool(fileCfg.seedWalletsOnStartup, false),
    },

    health: {
      heartbeatMinutes: num(fileCfg.healthHeartbeatMinutes, 60),
      stallWarnMinutes: num(fileCfg.healthStallWarnMinutes, 180),
    },

    agentMeridian: {
      url: process.env.AGENT_MERIDIAN_URL
        || fileCfg.agentMeridianUrl
        || 'https://api.agentmeridian.xyz/api',
      apiKey: process.env.AGENT_MERIDIAN_API_KEY
        || fileCfg.agentMeridianApiKey
        || 'bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz',
      enabled: process.env.AGENT_MERIDIAN_ENABLED !== undefined
        ? process.env.AGENT_MERIDIAN_ENABLED === 'true' || process.env.AGENT_MERIDIAN_ENABLED === '1'
        : bool(fileCfg.agentMeridianEnabled, false),
    },

    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN || fileCfg.telegramBotToken || '',
      chatId: process.env.TELEGRAM_CHAT_ID || fileCfg.telegramChatId || '',
      allowedUserIds: process.env.TELEGRAM_ALLOWED_USER_IDS || fileCfg.telegramAllowedUserIds || '',
      notifyOnSignal: bool(fileCfg.telegramNotifyOnSignal, true),
      notifyOnPromote: bool(fileCfg.telegramNotifyOnPromote, false),
      persistChatId: bool(fileCfg.telegramPersistChatId, true),
      enabled: bool(process.env.TELEGRAM_ENABLED, fileCfg.telegramEnabled !== false),
    },

    llm: {
      apiKey: process.env.OPENROUTER_API_KEY || process.env.LLM_API_KEY || fileCfg.llmApiKey || '',
      model: process.env.LLM_MODEL || fileCfg.llmModel || 'openrouter/auto',
      baseUrl: process.env.LLM_BASE_URL || fileCfg.llmBaseUrl || 'https://openrouter.ai/api/v1',
      siteName: process.env.LLM_SITE_NAME || 'laminar-scout',
    },

    learning: {
      enabled: process.env.LEARNING_ENABLED !== undefined
        ? (process.env.LEARNING_ENABLED === 'true' || process.env.LEARNING_ENABLED === '1')
        : bool(fileCfg.learningEnabled, true),
      intervalMinutes: num(process.env.LEARNING_INTERVAL_MINUTES, fileCfg.learningIntervalMinutes, 60),
      batchSize: num(fileCfg.learningBatchSize, 200),
      lookbackHours: num(fileCfg.learningLookbackHours, 168),
      minSamples: num(fileCfg.learningMinSamples, 5),
      badWrThreshold: num(fileCfg.learningBadWrThreshold, 0.40),
      cooldownHours: num(fileCfg.learningCooldownHours, 24),
      notifyTelegram: bool(fileCfg.learningNotifyTelegram, true),
    },
  };

  if (cfg.runtime.dryRun === false) {
    process.stderr.write('[scout] WARNING: DRY_RUN=false but laminar-scout is read-only and never executes on-chain.\n');
  }

  return cfg;
}

let cached = buildConfig();

export function getConfig() {
  return cached;
}

export function reloadConfig() {
  cached = buildConfig();
  return cached;
}

export default cached;