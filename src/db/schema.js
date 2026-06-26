import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getConfig } from '../config/config.js';
import { log } from '../utils/logger.js';

const SCHEMA_VERSION = 8;

const MIGRATIONS = [
  {
    version: 2,
    description: 'Add PnL + bin context fields to positions; richer features to training_records; wallet unique_pools',
    up: (db) => {
      const _addCol = (table, col, decl) => {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
        if (!cols.includes(col)) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
        }
      };
      _addCol('positions', 'pnl_sol', 'REAL');
      _addCol('positions', 'pnl_sol_pct', 'REAL');
      _addCol('positions', 'pool_active_bin_id', 'INTEGER');
      _addCol('positions', 'is_out_of_range', 'INTEGER');
      _addCol('positions', 'fee_per_tvl_24h', 'REAL');

      _addCol('wallets', 'unique_pools_traded', 'INTEGER DEFAULT 0');

      const tr = [
        'pnl_sol', 'pnl_sol_pct',
        'pool_apr', 'pool_apy', 'pool_launchpad', 'pool_has_farm', 'pool_farm_apr',
        'pool_dynamic_fee_pct', 'pool_current_price',
        'token_pair_base_mint', 'token_pair_quote_mint',
        'token_x_symbol', 'token_x_market_cap', 'token_x_fdv', 'token_x_holders',
        'token_x_organic_score', 'token_x_is_verified', 'token_x_freeze_disabled',
        'token_y_symbol', 'token_y_is_sol',
        'bin_lower', 'bin_upper', 'bin_center_distance', 'is_out_of_range', 'fee_per_tvl_24h',
        'wallet_pnl_at_entry', 'wallet_position_count_at_entry',
        'wallet_is_top_at_entry', 'wallet_is_tracked_at_entry',
        'wallet_recent_wr_30d', 'wallet_recent_fee_yield_30d',
        'wallet_recent_pnl_30d', 'wallet_recent_position_count_30d',
        'wallet_activity_span_days', 'wallet_unique_pools_traded',
      ];
      for (const c of tr) {
        const decl = (c.startsWith('token_') || c === 'pool_launchpad' || c === 'token_pair_base_mint' || c === 'token_pair_quote_mint' || c === 'token_x_symbol' || c === 'token_y_symbol') ? 'TEXT' : (c.startsWith('is_') || c === 'pool_has_farm' || c === 'token_x_is_verified' || c === 'token_x_freeze_disabled' || c === 'token_y_is_sol' || c === 'wallet_is_top_at_entry' || c === 'wallet_is_tracked_at_entry') ? 'INTEGER' : 'REAL';
        _addCol('training_records', c, decl);
      }
    },
  },
  {
    version: 3,
    description: 'Add pool_token_x_age_hours to training_records',
    up: (db) => {
      const cols = db.prepare(`PRAGMA table_info(training_records)`).all().map(r => r.name);
      if (!cols.includes('pool_token_x_age_hours')) {
        db.exec(`ALTER TABLE training_records ADD COLUMN pool_token_x_age_hours REAL`);
      }
    },
  },
  {
    version: 4,
    description: 'Add Jupiter-sourced token fields: mcap, liquidity, created_at, stats5m metrics, volatility proxy',
    up: (db) => {
      const _addCol = (table, col, decl) => {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
        if (!cols.includes(col)) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
        }
      };
      _addCol('training_records', 'token_x_mcap', 'REAL');
      _addCol('training_records', 'token_x_liquidity', 'REAL');
      _addCol('training_records', 'token_x_created_at', 'INTEGER');
      _addCol('training_records', 'token_volatility_24h', 'REAL');
      _addCol('training_records', 'token_num_buys_5m', 'INTEGER');
      _addCol('training_records', 'token_num_sells_5m', 'INTEGER');
      _addCol('training_records', 'token_buy_sell_ratio_5m', 'REAL');
    },
  },
  {
    version: 5,
    description: 'Add wallet_prior_* fields: wallet state computed from positions closed BEFORE this entry',
    up: (db) => {
      const _addCol = (table, col, decl) => {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
        if (!cols.includes(col)) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
        }
      };
      _addCol('training_records', 'wallet_prior_pnl_usd', 'REAL');
      _addCol('training_records', 'wallet_prior_fees_usd', 'REAL');
      _addCol('training_records', 'wallet_prior_capital_usd', 'REAL');
      _addCol('training_records', 'wallet_prior_position_count', 'INTEGER');
      _addCol('training_records', 'wallet_prior_win_rate', 'REAL');
      _addCol('training_records', 'wallet_prior_wins', 'INTEGER');
      _addCol('training_records', 'wallet_prior_losses', 'INTEGER');
    },
  },
  {
    version: 6,
    description: 'Add wallet_pool_revisit_* fields: position familiarity in the same pool BEFORE this entry',
    up: (db) => {
      const _addCol = (table, col, decl) => {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
        if (!cols.includes(col)) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
        }
      };
      _addCol('training_records', 'wallet_pool_revisit_count', 'INTEGER');
      _addCol('training_records', 'wallet_pool_revisit_pnl_usd', 'REAL');
      _addCol('training_records', 'wallet_pool_revisit_wr', 'REAL');
      _addCol('training_records', 'wallet_pool_revisit_fees_usd', 'REAL');
      _addCol('training_records', 'is_first_in_pool', 'INTEGER');
    },
  },
  {
    version: 7,
    description: 'Add token supply fields: token_x/y_total_supply + token_x_circ_supply (from Meteora pool-meta)',
    up: (db) => {
      const _addCol = (table, col, decl) => {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
        if (!cols.includes(col)) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
        }
      };
      _addCol('training_records', 'token_x_total_supply', 'REAL');
      _addCol('training_records', 'token_x_circ_supply', 'REAL');
      _addCol('training_records', 'token_y_total_supply', 'REAL');
      _addCol('training_records', 'token_y_circ_supply', 'REAL');
    },
  },
  {
    version: 8,
    description: 'Add position_in_pool_count: how many positions exist in this pool (competition density)',
    up: (db) => {
      const _addCol = (table, col, decl) => {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
        if (!cols.includes(col)) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
        }
      };
      _addCol('training_records', 'position_in_pool_count', 'INTEGER');
    },
  },
];

function migrationsDir(db, runtimeDataDir) {
  const dir = path.join(runtimeDataDir, 'migrations');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS wallets (
    address TEXT PRIMARY KEY,
    alias TEXT,
    source TEXT,
    discovered_from TEXT,
    first_seen INTEGER,
    last_active INTEGER,

    total_positions INTEGER DEFAULT 0,
    win_count INTEGER DEFAULT 0,
    loss_count INTEGER DEFAULT 0,
    win_rate REAL DEFAULT 0,
    total_pnl_usd REAL DEFAULT 0,
    total_fees_usd REAL DEFAULT 0,
    avg_fee_yield REAL DEFAULT 0,
    avg_duration_hours REAL DEFAULT 0,

    score REAL DEFAULT 0,
    score_updated INTEGER,

    status TEXT DEFAULT 'candidate',
    is_tracked INTEGER DEFAULT 0,
    is_top_wallet INTEGER DEFAULT 0,
    evaluation_count INTEGER DEFAULT 0,
    last_evaluated INTEGER,
    reject_reason TEXT,

    history_backfilled_until INTEGER DEFAULT 0,
    last_backfilled_sig TEXT,

    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
  )`,

  `CREATE INDEX IF NOT EXISTS idx_wallets_status ON wallets(status)`,
  `CREATE INDEX IF NOT EXISTS idx_wallets_is_top ON wallets(is_top_wallet)`,
  `CREATE INDEX IF NOT EXISTS idx_wallets_is_tracked ON wallets(is_tracked)`,
  `CREATE INDEX IF NOT EXISTS idx_wallets_score ON wallets(score DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_wallets_last_active ON wallets(last_active)`,

  `CREATE TABLE IF NOT EXISTS wallet_discovery_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address TEXT,
    discovery_source TEXT,
    source_detail TEXT,
    discovered_at INTEGER DEFAULT (unixepoch())
  )`,

  `CREATE INDEX IF NOT EXISTS idx_discovery_log_wallet ON wallet_discovery_log(wallet_address)`,
  `CREATE INDEX IF NOT EXISTS idx_discovery_log_source ON wallet_discovery_log(discovery_source)`,

  `CREATE TABLE IF NOT EXISTS positions (
    id TEXT PRIMARY KEY,
    wallet_address TEXT,
    pool_address TEXT,
    token_pair TEXT,

    entry_timestamp INTEGER,
    entry_price REAL,
    bin_step INTEGER,
    bin_lower INTEGER,
    bin_upper INTEGER,
    bin_range_width REAL,
    amount_token_x REAL,
    amount_token_y REAL,
    capital_usd REAL,
    entry_tx TEXT,

    exit_timestamp INTEGER,
    exit_price REAL,
    exit_tx TEXT,

    fees_earned_usd REAL,
    pnl_usd REAL,
    pnl_pct REAL,
    fee_yield REAL,
    duration_hours REAL,
    is_profitable INTEGER,
    close_reason TEXT,

    status TEXT DEFAULT 'open',
    position_mint TEXT,

    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch()),

    FOREIGN KEY (wallet_address) REFERENCES wallets(address) ON DELETE CASCADE
  )`,

  `CREATE INDEX IF NOT EXISTS idx_positions_wallet ON positions(wallet_address)`,
  `CREATE INDEX IF NOT EXISTS idx_positions_pool ON positions(pool_address)`,
  `CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status)`,
  `CREATE INDEX IF NOT EXISTS idx_positions_entry_ts ON positions(entry_timestamp DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_positions_mint ON positions(position_mint)`,

  `CREATE TABLE IF NOT EXISTS market_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pool_address TEXT,
    timestamp INTEGER,
    fee_apr REAL,
    volume_24h REAL,
    tvl REAL,
    fee_tvl_ratio REAL,
    active_bin INTEGER,
    price REAL,
    token_price REAL,
    token_price_change_24h REAL,
    token_volatility_24h REAL,
    token_volume_24h REAL,
    created_at INTEGER DEFAULT (unixepoch())
  )`,

  `CREATE INDEX IF NOT EXISTS idx_market_snapshots_pool_ts ON market_snapshots(pool_address, timestamp DESC)`,

  `CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pool_address TEXT,
    token_pair TEXT,
    trigger_type TEXT,
    triggered_by TEXT,
    wallet_score REAL,
    pool_score REAL,
    combined_confidence REAL,
    validation_reasons TEXT,
    suggested_bin_step INTEGER,
    suggested_range_lower INTEGER,
    suggested_range_upper INTEGER,
    fee_apr REAL,
    volume_24h REAL,
    tvl REAL,
    status TEXT DEFAULT 'pending',
    emitted_at INTEGER,
    created_at INTEGER DEFAULT (unixepoch())
  )`,

  `CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status)`,
  `CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_signals_pool ON signals(pool_address)`,

  `CREATE TABLE IF NOT EXISTS training_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    position_id TEXT,
    wallet_address TEXT,
    pool_address TEXT,
    entry_timestamp INTEGER,
    close_timestamp INTEGER,

    was_profitable INTEGER,
    pnl_usd REAL,
    pnl_pct REAL,
    fee_earned_usd REAL,
    fee_yield REAL,
    duration_hours REAL,

    pool_fee_apr REAL,
    pool_volume_24h REAL,
    pool_tvl REAL,
    fee_tvl_ratio REAL,
    pool_bin_step INTEGER,
    token_pair TEXT,
    days_since_pool_created REAL,

    token_volatility_24h REAL,
    token_price_change_24h REAL,
    volume_vs_7d_avg REAL,

    bin_range_width REAL,
    capital_usd REAL,
    hour_of_day INTEGER,
    day_of_week INTEGER,

    wallet_score_at_entry REAL,
    wallet_wr_at_entry REAL,
    wallet_discovery_source TEXT,
    wallet_discovered_at INTEGER,
    wallet_position_index INTEGER,

    exported_at INTEGER,
    created_at INTEGER DEFAULT (unixepoch())
  )`,

  `CREATE INDEX IF NOT EXISTS idx_training_wallet ON training_records(wallet_address)`,
  `CREATE INDEX IF NOT EXISTS idx_training_pool ON training_records(pool_address)`,
  `CREATE INDEX IF NOT EXISTS idx_training_position ON training_records(position_id)`,

  `CREATE TABLE IF NOT EXISTS processed_txs (
    tx_signature TEXT PRIMARY KEY,
    processed_at INTEGER DEFAULT (unixepoch()),
    source TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS idx_processed_txs_source ON processed_txs(source)`,
  `CREATE INDEX IF NOT EXISTS idx_processed_txs_at ON processed_txs(processed_at)`,
];

export function initSchema(db, options = {}) {
  const verbose = options.verbose !== false;
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  const tx = db.transaction(() => {
    for (const stmt of STATEMENTS) db.prepare(stmt).run();
    const existing = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get();
    const currentVersion = existing ? Number(existing.value) : 0;
    let finalVersion = currentVersion;
    for (const m of MIGRATIONS) {
      if (m.version > finalVersion) {
        m.up(db);
        finalVersion = m.version;
        log('info', `schema: migrated to v${m.version} (${m.description})`);
      }
    }
    if (!existing) {
      db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`).run(String(finalVersion));
      db.prepare(`INSERT INTO meta (key, value) VALUES ('created_at', ?)`).run(String(Date.now()));
    } else if (finalVersion !== currentVersion) {
      db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(String(finalVersion));
    }
  });
  tx();

  if (verbose) {
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all().map(r => r.name);
    log('info', `schema: initialized v${SCHEMA_VERSION}, tables=${tables.join(',')}`);
  }
  return SCHEMA_VERSION;
}

export function getSchemaVersion(db) {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get();
  return row ? Number(row.value) : 0;
}

export function ensureDataDir(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

export function openDatabase(opts = {}) {
  const cfg = getConfig();
  const dataDir = opts.dataDir || cfg.runtime.dataDir;
  ensureDataDir(dataDir);
  const dbPath = path.join(dataDir, opts.filename || 'scout.sqlite');
  const db = new Database(dbPath);
  initSchema(db, { verbose: opts.verbose !== false });
  return db;
}

export { migrationsDir };