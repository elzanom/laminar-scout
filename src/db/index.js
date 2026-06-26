import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { initSchema } from './schema.js';
import { getConfig } from '../config/config.js';
import { log } from '../utils/logger.js';
import { configureHealth } from '../utils/health.js';

let dbInstance = null;

export function openDb(opts = {}) {
  const cfg = getConfig();
  const dataDir = opts.dataDir || cfg.runtime.dataDir;
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, opts.filename || 'scout.sqlite');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  initSchema(db, { verbose: opts.verbose !== false });
  if (dbInstance && dbInstance !== db) {
    try { dbInstance.close(); } catch {}
  }
  dbInstance = db;
  return db;
}

export function setDb(db) {
  dbInstance = db;
}

export function getDb() {
  if (!dbInstance) {
    dbInstance = openDb();
    configureHealth({ logDir: getConfig().runtime.logDir, healthHeartbeatMinutes: getConfig().health.heartbeatMinutes, healthStallWarnMinutes: getConfig().health.stallWarnMinutes });
    log('info', `db: opened ${dbInstance.name}`);
  }
  return dbInstance;
}

export function closeDb() {
  if (dbInstance) {
    try { dbInstance.close(); } catch (err) { log('warn', 'db: close error', { error: err.message }); }
    dbInstance = null;
  }
}

export function dbStats() {
  const db = getDb();
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name);
  const counts = {};
  for (const t of tables) {
    try { counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; } catch { counts[t] = -1; }
  }
  return { path: db.name, tables, counts };
}