# laminar-scout

Self-discovering wallet tracker for Meteora DLMM LP wallets. Pure data pipeline that discovers LP wallets, scores their historical performance, tracks their positions in real time, and emits trade signals to Laminar.

No AI/LLM. No on-chain execution. No trading. Read-only data pipeline that produces a structured training dataset for Laminar (the upstream DLMM agent).

Includes a lightweight **dashboard** (Express + vanilla HTML/JS/CSS) on port 3002 for live monitoring.

---

## What it does

- **Discovers wallets automatically** — scans Meteora DLMM pools, enumerates LPers via Solana RPC `getProgramAccounts`, captures new wallets from live TX stream, follows top-wallet co-occurrence.
- **Evaluates wallets** — backfills 90 days of TX history via Helius, fetches closed-position outcomes from Meteora PnL API, computes WR/fee-yield/PnL, assigns score 0-100.
- **Tiers wallets** — `candidate` → `tracked` → `top` → `rejected`, with automatic promotion/demotion every 60 min.
- **Tracks in real time** — Helius webhook (port 3001) + 30s polling fallback. Every addLiquidity/removeLiquidity/claimFee from tracked wallets is recorded.
- **Emits signals** — when a `top` wallet opens a position in a pool that passes screening, writes a Laminar-compatible JSON to `signals-output.json`.
- **Builds dataset** — every closed position becomes a TrainingRecord (69 columns: 8 labels, 13 pool features, 14 token features, 9 position features, 16 wallet features, 2 audit + 7 identity) for Laminar training.
- **Dashboard** — read-only HTTP frontend on port 3002 for live inspection: wallet counts, top wallets, recent signals, recent positions, score distribution, discovery sources, subsystem health.

---

## Quick start

```bash
git clone git@github.com:elzanom/laminar-scout.git
cd laminar-scout
npm install

cp .env.example .env
# Edit .env: fill HELIUS_API_KEY, HELIUS_RPC_URL, HELIUS_WEBHOOK_SECRET
# (also available: WEBHOOK_PORT, LOG_LEVEL, DRY_RUN)

cp config/scout-config.example.json scout-config.json
# Tune thresholds if needed (see Configuration section)

# Run all smoke tests to verify the install
node scripts/smoke-db.js
node scripts/smoke-tx-parser.js
node scripts/smoke-pool-screener.js
node scripts/smoke-discovery.js
node scripts/smoke-step5.js

# Start the scout (foreground)
node src/index.js

# Or via PM2 for production (recommended for multi-process orchestration)
npm run start:all       # start all 3 processes (main + webhook + dashboard)
npm run status          # check status table (pid, uptime, cpu, mem, restarts)
npm run stop:all        # graceful SIGTERM stop for all processes
pm2 logs laminar-scout  # tail logs
```

On boot, scout:
1. Initializes SQLite schema (idempotent migrations to v3).
2. Starts Helius webhook listener on port 3001.
3. Starts polling fallback (30s interval).
4. Starts live event handlers (position-builder, record-builder, tx-mining, signal-on-open).
5. Schedules 7 cron jobs.

First signal typically fires within an hour if any `top` wallet opens a position.

---

## Architecture

```
+---------------------+        +-----------------+        +-------------------+
|  discovery (cron)   |        |  Helius webhook |        | Helius polling    |
|  pool-screener      |        |  POST :3001     |        | (fallback, 30s)   |
|  pool-discovery     |        +--------+--------+        +---------+---------+
|  tx-mining          |                 |                          |
|  follow-winners     |                 v                          v
+----------+----------+        +-------------------+    +------------------+
           |                   |   tx-parser       |    |  helius-history  |
           v                   +---------+---------+    |  backfill + sync |
+---------------------+                 |                   |
|    wallets table    |                 v                   |
|    (442 entries)    |       +-------------------+         |
+----------+----------+       |   event-bus        |<--------+
           ^                   |   (Node EE)        |
           |                   +----+-----+----+----+
           |                        |     |    |
           |                        v     v    v
           |               +---------+   |  +-----------------+
           |               |position |   |  | tx-mining       |
           |               |builder  |   |  | (global TX)     |
           |               +----+----+   |  +--------+--------+
           |                    |        |           |
           |                    v        |           v
           |               +---------+  |    +----------------+
           |               |positions|  |    |  candidate     |
           |               |  table  |  |    |  wallets       |
           |               +----+----+  |    +----------------+
           |                    |       |
           |                    v       |
           |               +---------+  |
           |               |  record |  |
           +---------------+builder  |  |
                           +----+----+  |
                                |       |
                                v       v
                          +-------------------+
                          |  training_records |
                          |  table (1000 rows)|
                          +---------+---------+
                                    |
                                    v
                          +-------------------+
                          | exporter → CSV   |
                          | dataset/training |
                          |   -records.csv   |
                          +-------------------+

+---------------------+
|  signal-on-open     | --validate--> emitter --> signals-output.json
+---------------------+
```

---

## Configuration

### Environment variables (`.env`)

| Variable | Required | Default | Purpose |
|----------|:--------:|---------|---------|
| `HELIUS_API_KEY` | yes | - | Helius API key (free tier at helius.dev) |
| `HELIUS_RPC_URL` | yes | - | Full RPC URL including `?api-key=...` |
| `HELIUS_WEBHOOK_SECRET` | yes | - | Shared secret for webhook HMAC verification. Use 32+ random chars |
| `WEBHOOK_PORT` | no | 3001 | HTTP port for webhook receiver |
| `LOG_LEVEL` | no | info | `debug`, `info`, `warn`, `error` |
| `DRY_RUN` | no | true | scout is read-only so this is just a flag |
| `BIRDEYE_API_KEY` | no | - | Optional, for token price/volume fallback |
| `DATA_DIR` | no | `./data` | SQLite directory |
| `LOG_DIR` | no | `./logs` | Daily log file directory |

### `scout-config.json` thresholds

All thresholds can be tuned without code changes. Key groups:

```json
{
  "discoveryIntervalMinutes": 60,
  "maxWalletCandidatesPerCycle": 100,
  "evaluationBackfillDays": 90,

  "minWalletScore": 40,
  "minWinRate": 0.55,
  "minTotalPositions": 20,
  "minFeeYield": 0.02,
  "topWalletLimit": 100,
  "autoPromoteToTracked": true,

  "minFeeActiveTvlRatio": 0.05,
  "minTvl": 10000,
  "maxTvl": 150000,
  "minVolume": 500,
  "minOrganic": 60,
  "minBinStep": 80,
  "maxBinStep": 125,

  "minCombinedConfidence": 0.70,
  "signalDedupWindowMinutes": 15,

  "backfillDays": 90,
  "snapshotIntervalMinutes": 15,
  "walletRankUpdateIntervalMinutes": 60,
  "screeningIntervalMinutes": 30,

  "poolDiscoveryCategory": "trending"
}
```

The `poolDiscoveryCategory` is a semantic mode that controls local ranking (`trending` = by score+organic, `new` = by recency, `all` = Meteora's default order). It is not a pool-type filter — scout is DLMM-only.

---

## Project structure

```
laminar-scout/
  src/
    db/                    # SQLite layer (better-sqlite3, schema v3, 9 tables)
      schema.js           #   CREATE TABLE statements + idempotent migrations
      wallets.js          #   wallet CRUD + tier decisions
      positions.js        #   position CRUD (PK = on-chain position mint)
      signals.js          #   signal staging with dedup
      training-records.js #   dataset rows (idempotent by position_id)
      market-snapshots.js #   time-series pool snapshots
      processed-txs.js    #   idempotency for TX ingestion
    collector/
      tx-parser.js        #   Helius enhanced TX → DLMM event (discriminator match)
      helius-stream.js    #   webhook receiver + polling fallback (native http)
      helius-history.js   #   paginated historical backfill (resumable)
      pool-lpers.js       #   getProgramAccounts enumeration (self-sufficient)
      subscription-manager.js  # Helius webhook address sync
      meteora-pnl.js      #   Meteora /positions/{pool}/pnl wrapper
      event-bus.js        #   Node EventEmitter for in-process pub/sub
    screener/
      pool-screener.js    #   discovery + filtering + PVP guard
      pool-scorer.js      #   degenScore + scoreCandidate
      metrics-fetcher.js  #   Meteora + Jupiter DATAPI with caching
      screening-scales.js #   timeframe-scaled defaults
    discovery/
      pool-discovery.js   #   top pools → enumerate owners → insert candidates
      tx-mining.js        #   global Helius stream → capture wallets
      follow-winners.js   #   co-occurrence from top wallets
      wallet-evaluator.js #   backfill + score + tier decision
    trackers/
      position-builder.js #   live TX events → positions table
    wallets/
      wallet-ranker.js    #   periodic re-ranking
      wallet-filter.js    #   tier promotion/demotion
      seed-wallets.js     #   manual seed import
    signals/
      validator.js        #   double validation: wallet OK + pool OK
      emitter.js          #   dedup + write signals-output.json
    dataset/
      record-builder.js   #   position close → TrainingRecord (69 cols)
      exporter.js         #   CSV/JSON export
    utils/
      logger.js           #   port of meridian logger (daily file, jsonl audit)
      retry.js            #   exponential backoff for API calls
      health.js           #   per-subsystem state + heartbeat
    config/config.js      #   dotenv + scout-config.json loader
    constants.js          #   DLMM program ID, discriminators, known mints
    index.js              #   entry point + cron scheduler + SIGTERM
  config/
    scout-config.example.json
  scripts/
    smoke-db.js           #   CRUD smoke (uses tmpdir)
    smoke-tx-parser.js    #   TX parsing smoke
    smoke-pool-screener.js
    smoke-discovery.js
    smoke-step5.js        #   signal/dataset/ranking smoke
    live-cycle.js         #   one-shot discovery + evaluation cycle
    build-dataset.js      #   rebuild training_records from closed positions
    export-dataset.js     #   CSV/JSON export for Laminar
    backfill-enrichment.js  # wallet_unique_pools + market_snapshots quick-fill
    seed.js, backfill.js  #   CLI utilities
    reevaluate-local.js   #   fast tier re-evaluation from local positions
  ecosystem.config.cjs    # PM2 (main + webhook processes)
  .env.example
  package.json
```

---

## How it works

### 1. Self-discovery

Three parallel mechanisms insert new wallets with `status='candidate'`:

| Source | Mechanism |
|--------|-----------|
| `pool_discovery` | Top DLMM pools from Meteora → enumerate LPers via `getProgramAccounts` (dataSize=8120, memcmp offset=8, dataSlice) |
| `tx_mining` | Subscribe to all Meteora DLMM TXs via Helius global stream → capture wallet from any addLiquidity |
| `follow_winner` | For each `top` wallet → enumerate LPers in pools where they LP'd (±24h window) |

The `getProgramAccounts` recipe is self-sufficient — no third-party API dependency. `agentMeridianApiKey` (optional) only enriches with per-LPer statistics.

### 2. Wallet evaluation

For each candidate (every 10 minutes):

1. Backfill 90 days of TX via Helius `/v0/addresses/{addr}/transactions` (paginated, resumable).
2. Parse TXs into events (addLiquidity, removeLiquidity, claimFee, claimReward) via discriminator matching.
3. Ingest events into `positions` table via position-builder.
4. Fetch closed-position outcomes from Meteora `/positions/{pool}/pnl?user={wallet}`.
5. Compute metrics: total_positions, win_rate, total_pnl_usd, total_fees_usd, avg_fee_yield, avg_duration_hours.
6. Compute score: `wr*40 + min(feeYield/3*20, 20) + min(positions/100*20, 20) + (pnl>0 ? 20 : 0)` (max 100).
7. Decide tier:
   - `insufficient_positions` → `candidate`
   - any threshold fails → `rejected` (re-eval after 168 hours)
   - all pass → `tracked`
   - score ≥ 55 → `top` (set via `applyTierFilters`)

### 3. Real-time tracking

- **Helius webhook** (port 3001): for each tracked+top wallet address, Helius delivers TXs as they happen. POST `/webhook/helius` validates HMAC and dispatches via tx-parser → event-bus.
- **Polling fallback** (30s interval): for any wallet that missed a webhook delivery, syncWallet polls the historical API for the latest sig.
- **Event-bus subscribers**:
  - `positionBuilder` → insertPosition / closePosition (writes to `positions` table)
  - `recordBuilder` → buildTrainingRecordFromPosition (writes to `training_records`)
  - `txMining` → handleDlmmEvent (insert new wallets as candidates)
  - `signal-on-open` → validateSignal → emitSignal (writes to `signals-output.json` if top wallet)

### 4. Signal generation

When a `top` wallet opens a new position:

1. `validator.validateSignal` runs two gates:
   - Wallet: `is_top_wallet = 1` and score ≥ 40
   - Pool: passes `screenPoolDeep` (TVL/volume/organic/bin_step/fee_active_tvl_ratio)
2. Computes `combined_confidence = wallet_score/100 * 0.4 + pool_combined * 0.6`
3. If ≥ 0.70 → `emitter.emitSignal`:
   - Dedup against recent signals in last 15 minutes for same pool
   - Insert into `signals` table (status: pending → sent)
   - Write to `signals-output.json` (Laminar-compatible)

### 5. Dataset export

```bash
# Rebuild from closed positions in DB
node scripts/build-dataset.js --limit 1000

# Export unexported records to CSV (default) or JSON
node scripts/export-dataset.js
node scripts/export-dataset.js --format json --path ./myset.json
```

Output is auto-tracked by `exported_at` timestamp to avoid re-emitting the same record. CSV columns follow SPEC §8 plus scout extensions (69 total).

---

## Database

Schema v3, 9 tables, all idempotent migrations via `meta.schema_version`:

| Table | Purpose |
|-------|---------|
| `wallets` | Discovered wallets with metrics, score, tier, backfill state |
| `wallet_discovery_log` | Audit of every discovery event (source, timestamp, referrer) |
| `positions` | LP positions with entry/exit, PnL, fees, bin context (PK = position mint) |
| `market_snapshots` | Pool time-series snapshots (cron every 15 min + manual quick-fill) |
| `signals` | Emitted trade signals with dedup window |
| `training_records` | Laminar training dataset (69 columns) |
| `processed_txs` | Idempotency tracker for TX ingestion |
| `meta` | Schema version + ad-hoc key-value |

WAL journal mode, foreign keys on, synchronous=NORMAL. All hot queries have indexes (`idx_wallets_status`, `idx_positions_wallet`, etc.).

---

## Signal output format

`signals-output.json`:

```json
{
  "id": 42,
  "pool": "ABCxyz...",
  "token_pair": "BONK/SOL",
  "confidence": 0.83,
  "trigger": {
    "type": "wallet_entry",
    "wallet": "WaLLeT...",
    "wallet_score": 51.3,
    "wallet_wr": 0.784
  },
  "pool_metrics": {
    "fee_apr": 2.61,
    "volume_24h": 485000,
    "tvl": 52000,
    "fee_tvl_ratio": 0.089,
    "organic_score": 74
  },
  "suggested": {
    "bin_step": 100,
    "range_lower": 95,
    "range_upper": 115
  },
  "validation_reasons": [
    "top_wallet_entered",
    "fee_apr_above_threshold",
    "volume_spike_detected",
    "organic_score_high"
  ],
  "created_at": 1750000000
}
```

Laminar can consume this directly (file polling, REST POST, or shared SQLite).

---

## Scripts reference

| Script | Purpose |
|--------|---------|
| `node src/index.js` | Full boot with cron + webhook + live handlers |
| `node scripts/dashboard.js --port 3002` | Start dashboard server (vanilla HTML/JS/CSS frontend) |
| `node scripts/start.js` | Start all PM2 processes (main + webhook + dashboard) via ecosystem.config.cjs |
| `node scripts/stop.js` | Gracefully stop all laminar-scout PM2 processes (SIGTERM) |
| `node scripts/status.js` | Show current state of all processes (status, pid, uptime, cpu, mem, restarts) |
| `node scripts/smoke-db.js` | CRUD smoke test (uses tmpdir) |
| `node scripts/smoke-tx-parser.js` | TX parser smoke |
| `node scripts/smoke-pool-screener.js` | Pool screener smoke |
| `node scripts/smoke-discovery.js` | Discovery smoke |
| `node scripts/smoke-step5.js` | Signal/dataset/ranking smoke |
| `node scripts/live-cycle.js --limit 5 --evaluate 3` | One-shot discovery + evaluation cycle |
| `node scripts/build-dataset.js --limit 1000` | Rebuild training records from closed positions |
| `node scripts/export-dataset.js` | Export unexported records to CSV |
| `node scripts/backfill-enrichment.js` | Backfill `wallet_unique_pools_traded` + quick-fill `market_snapshots` |
| `node scripts/seed.js --file wallets.txt` | Import seed wallets (optional bootstrap) |
| `node scripts/backfill.js --wallet <addr> --days 90` | Backfill one wallet manually |
| `node scripts/reevaluate-local.js` | Fast tier re-evaluation from local positions only |

---

## Dashboard

`npm run dashboard` starts an Express-based read-only dashboard on port 3002. It reads the same SQLite DB as the scout (no separate cache), so the data is always live.

**URL:** `http://localhost:3002`

**Sections**:
- 6 overview cards (wallets, positions, signals, training, processed TXs, snapshots)
- Top wallets table (top 10 by score)
- Recent signals (last 10)
- Recent closed positions (last 10)
- Recent discovery events (last 15)
- Score distribution histogram (0–20, 20–40, …, 80–100)
- Discovery source breakdown
- Subsystem health (last success, error count, stalled flag)
- Cron last-run timestamps

**API endpoints** (for direct querying / Grafana / custom tooling):

| Endpoint | Returns |
|----------|---------|
| `GET /api/overview` | Counts across all tables + uptime |
| `GET /api/wallets/top?limit=10` | Top wallets by score |
| `GET /api/wallets/recent?limit=20` | Recently seen wallets |
| `GET /api/signals/recent?limit=10` | Recent signals |
| `GET /api/positions/recent?status=closed&limit=10` | Recent closed positions |
| `GET /api/health` | Subsystem states + stalled flags |
| `GET /api/discovery-sources` | Wallet counts by source |
| `GET /api/score-distribution` | Histogram buckets |
| `GET /api/discovery-recent?limit=15` | Recent discovery events |
| `GET /api/cron-status` | Cron last-run timestamps |
| `GET /healthz` | Liveness check |

Frontend polls every 5s with `cache: 'no-store'`. No WebSocket dependency.

**Production**: PM2 manages dashboard as a separate process (`laminar-scout-dashboard` in `ecosystem.config.cjs`).

---

## What it does NOT do

- **No on-chain execution.** No swaps, no position deployment, no transactions. Read-only.
- **No AI/LLM.** All scoring is deterministic formulas. No OpenAI, no Anthropic, no completions API.
- **No Telegram/Discord bot, no interactive UI.** Output is file-based (`signals-output.json` + SQLite).
- **No real-time order book data.** Pool metrics come from Meteora DATAPI only.
- **No multi-chain support.** Solana only.
- **No `agent.js` / ReAct loop.** That's Laminar's responsibility.

---

## Security notes

- `.env` contains API keys — gitignored. Always use `.env.example` as template.
- `scout-config.json` contains Agent Meridian API key (public default) and your custom thresholds — gitignored.
- `HELIUS_WEBHOOK_SECRET` should be 32+ random characters. The constant-time check works regardless but short secrets are brute-forceable.
- The webhook receiver verifies the shared secret on every incoming POST.
- scout never requests write transactions or signs anything. It only reads.

---

## Dependencies

- `@meteora-ag/dlmm` — DLMM SDK for position enumeration
- `@solana/web3.js` — Solana RPC client
- `@solana/spl-token` — SPL token utilities
- `better-sqlite3` — synchronous SQLite (fast for embedded use)
- `bn.js`, `bs58` — number/encoding helpers
- `dotenv` — env file loader
- `node-cron` — cron scheduling
- `jsonrepair` — defensive JSON parse

Node.js 18+ (tested on 26.1). ESM modules (`"type": "module"` in package.json).

---

## License

ISC (or as per upstream meridian conventions).

## References

- Architecture spec: `SPEC.md`
- AI agent instructions: `CLAUDE.md`
- Base project: [meridian](https://github.com/yunus-0x/meridian) (used as reference for screening, scoring, retry, and config patterns — not vendored)