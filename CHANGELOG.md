# Changelog

All notable changes to laminar-scout are documented here. This file tracks the development branch (which will be merged to main when ready).

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/), and this project does not yet follow [Semantic Versioning](https://semver.org/).

## [Unreleased] — development branch (25 commits ahead of main)

### Added — Schema migrations
- **v5 migration**: `wallet_prior_*` columns (7 fields) — at-entry wallet context computed from positions closed BEFORE this entry (PnL, fees, capital, position count, win rate, wins, losses). Provides a genuine "before-entry" wallet state vs the current-state snapshot in `wallet_*_at_entry`.
- **v6 migration**: `wallet_pool_revisit_*` columns (5 fields) + `is_first_in_pool` — captures pool familiarity (how many prior positions the wallet had in the same pool, with aggregates).
- **v7 migration**: `token_x/y_total_supply` + `token_x/y_circ_supply` columns (4 fields) — token supply from Meteora pool-meta. `circ_supply` is always NULL because Meteora pool-detail endpoint doesn't expose it (column kept in schema for future backfill).
- **v8 migration**: `position_in_pool_count` — competition density signal (how many positions exist in the pool at this entry's timestamp).
- **v9 migration**: GMGN-sourced token metrics — `token_num_holders` (INTEGER), `token_holder_concentration` (REAL, top-10 holders % from `gmgn-cli token holders`), `token_dev_hold_rate` (REAL, from `gmgn-cli token info`). Fills gaps that Jupiter / DexScreener / Meteora can't cover.

### Added — Backfill scripts
- `scripts/backfill-positions.js` — populate `positions.token_pair` + `bin_step` from Meteora pool-meta (one-time).
- `scripts/backfill-enrichment.js` — one-time backfill of `wallets.unique_pools_traded` + `market_snapshots` quick-fill.
- `scripts/backfill-pool-launchpad.js` — re-fetch pool-meta, update `pool_launchpad` for NULL pools.
- `scripts/backfill-meteora-summary.js` — re-fetch pool-meta, update `token_x_organic_score` and `token_x_fdv` (top 100 active DLMM pools).
- `scripts/backfill-dexscreener.js` — backfill `token_price_change_24h` + `token_x_fdv` via DexScreener free tier.
- `scripts/backfill-jupiter.js` — backfill token metrics via Jupiter Tokens V2 + Price V3 (mcap, liquidity, organic_score, is_verified, created_at, priceChange24h, stats5m). Free tier-safe defaults with retry-with-backoff.
- `scripts/backfill-gmgn.js` — backfill GMGN-sourced token metrics: `token_num_holders`, `token_holder_concentration`, `token_x_circ_supply` (fills Meteora NULLs), `token_x_created_at`, `token_dev_hold_rate`. Spawns `gmgn-cli` subprocess (Cloudflare-safe, IPv4 only). Defaults `--rate 2 --concurrency 1` tuned for free tier (~50 req/min).
- `src/collector/gmgn.js` — adapter for `gmgn-cli` binary with in-memory cache (1h TTL), rate limiting, and `extractHolderMetrics` helper for top-10 concentration.
- `scripts/backfill-pnl-all.js` — backfill `pnl_sol`, `is_out_of_range`, `fee_per_tvl_24h`, `pool_active_bin_id` from Meteora PnL API for all (wallet, pool) pairs.

### Added — Utility scripts
- `scripts/dataset-stats.js` — comprehensive dataset statistics (coverage %, value ranges, label distribution). Outputs both pretty text and JSON.
- `scripts/dataset-validate.js` — 12 data quality invariant checks (duplicate IDs, future timestamps, invalid fee_yield, PnL sign disagreement, etc.). `--strict` mode exits 1 on errors.
- `scripts/rebuild-all.js` — orchestrated full pipeline: build-dataset → backfills → export. Enforces correct order (build-dataset wipes training_records so backfills must run after).
- `scripts/test-all.js` — unified test runner: runs smoke-db, smoke-tx-parser, smoke-pool-screener, smoke-discovery, smoke-step5, dataset-stats, dataset-validate. Aggregates pass/fail with timing.
- `scripts/start.js` / `stop.js` / `scripts/status.js` — PM2 lifecycle: start all processes, graceful stop, status table with color coding.

### Added — Dashboard
- `src/dashboard/server.js` — Express-based dashboard server (port 1603) with 11 REST endpoints (`/api/overview`, `/api/wallets/top`, `/api/signals/recent`, `/api/positions/recent`, `/api/health`, `/api/discovery-sources`, `/api/score-distribution`, `/api/discovery-recent`, `/api/cron-status`, `/api/dataset-summary`, etc.).
- `public/index.html` + `public/app.js` + `public/style.css` — retro/terminal aesthetic matching Meteora LP Screener styling. Dark navy background with scanline overlay, JetBrains Mono typography, color-coded data quality indicators.
- "Dataset feature coverage (for Laminar)" panel — shows 25 most important feature fields with coverage % sorted descending.

### Added — CI / Tooling
- `.github/workflows/ci.yml` — GitHub Actions CI: runs `npm test` on every push to main/development and on PRs. Catches schema migration regressions, dataset coverage drops, smoke test failures.
- `package.json` convenience scripts: `npm test`, `npm run stats`, `npm run validate`, `npm run rebuild`, `npm run export`, `npm run build-dataset`, `npm run start:all`, `npm run stop:all`, `npm run status`, `npm run dashboard`.

### Added — Jupiter API integration
- `src/config/config.js` — added `gmgn` and `jupiter` config sections.
- `.env.example` — added `JUPITER_API_KEY` and `GMGN_API_KEY` with notes (GMGN is Cloudflare-gated, only works via gmgn-cli).
- `src/dashboard/server.js` — `/api/dataset-summary` includes Jupiter-sourced fields.

### Fixed
- `src/db/positions.js` — `listPositions` now supports `exit_before` filter and custom `orderBy` option. Required for the "recent form" / "prior at-entry" queries in record-builder.
- `src/dataset/record-builder.js` — added `pool_token_x_age_hours` field with fallback to `meta.created_at` when `token_x.created_at` is missing.
- `src/dataset/record-builder.js` — fixed `?? null` placeholder handling for SQLite binding.
- `.gitignore` — anchored `dataset/` to root (`/dataset/`) so `src/dataset/` (record-builder.js source code) is no longer incorrectly ignored.
- INSERT statement placeholder counts regenerated to match exact column count in schema v2-v8 migrations (via inline Node.js script that reads `PRAGMA table_info`).

### Documentation
- `README.md` — added "Dataset coverage" section with per-field coverage table, source attribution, and "Known limitations" section.
- `README.md` — "Scripts reference" section split into Lifecycle / Dataset pipeline / Discovery / Smoke tests / Convenience npm scripts.
- Documented v5/v6/v7/v8 schema fields in coverage table.
- Documented GMGN CLI limitation (Cloudflare-gated, not usable server-side).
- Documented Jupiter free tier rate limits and retry strategy.

### Known limitations (documented for Laminar)
- `wallet_*_at_entry` fields are current-state snapshots, not at-entry-state. Use `wallet_prior_*` (v5) for true at-entry context.
- `token_volatility_24h` is a proxy (|priceChange24h|), not a true standard deviation. True std dev requires candle history (Birdeye Pro / Jupiter Pro / DexScreener paid).
- `bin_lower` / `bin_upper` (89% missing) — closed positions' on-chain accounts are rent-reclaimed by Meteora close_position.
- `pool_volume_24h` / `fee_tvl_ratio` (96% missing) — historical market snapshots don't exist in Meteora's free API.
- Time diversity is limited (most positions cluster in 2026 due to 90-day Meteora backfill window).
- Wallet diversity is limited (11 distinct wallets, all from top tier evaluation).
- `wallet_recent_*` and `wallet_prior_*` coverage is low (~1%) because most wallets have all positions clustered in the same few days.
- GMGN API is Cloudflare-gated and only works via gmgn-cli browser tool, not from server-side fetch.

### Test results (as of latest commit on development)
- 7/7 checks pass: smoke-db, smoke-tx-parser, smoke-pool-screener, smoke-discovery, smoke-step5, dataset-stats, dataset-validate.
- Dataset: 3529 records × 90 user columns × 0.96MB CSV.

## [v1.0] — main branch (released)

Initial implementation of laminar-scout as described in SPEC.md and README.md. Self-discovering wallet tracker for Meteora DLMM LP wallets with all 7 SPEC phases implemented:
- Phase 1: Foundation (db, config, logger, retry, health, constants)
- Phase 2: Collector (tx-parser, helius-stream, helius-history, subscription-manager, pool-lpers, event-bus, meteora-pnl)
- Phase 3: Screener (pool-screener, pool-scorer, metrics-fetcher, screening-scales)
- Phase 4: Discovery (pool-discovery, tx-mining, follow-winners, wallet-evaluator)
- Phase 5: Ranking (position-builder, wallet-ranker, wallet-filter, seed-wallets)
- Phase 6: Signal/Dataset (validator, emitter, record-builder, exporter)
- Phase 7: Entry/PM2 (cron orchestration, lifecycle scripts, ecosystem.config.cjs)

Plus initial backfill scripts (backfill-enrichment, backfill-positions) and the first version of the dashboard (aabf12, b986f46).

[Unreleased]: https://github.com/elzanom/laminar-scout/compare/main...development
[v1.0]: https://github.com/elzanom/laminar-scout/tree/main
