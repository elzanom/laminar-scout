import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function resolveLogDir() {
  if (process.env.SCOUT_LOG_DIR) return process.env.SCOUT_LOG_DIR;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'scout-config.json'), 'utf8'));
    if (cfg.logDir) return cfg.logDir;
  } catch {}
  return './logs';
}

const LOG_DIR = resolveLogDir();
const LEVEL_NAME = (process.env.LOG_LEVEL || 'info').toLowerCase();
const ACTIVE_LEVEL = LEVELS[LEVEL_NAME] || LEVELS.info;

let logFileHandle = null;
let logFileDate = '';
let logFilePath = '';

function ensureLogFile() {
  const today = new Date().toISOString().slice(0, 10);
  if (today === logFileDate && logFileHandle) return;
  if (logFileHandle) {
    try { logFileHandle.end(); } catch {}
  }
  logFileDate = today;
  logFilePath = path.join(LOG_DIR, `scout-${today}.log`);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    logFileHandle = fs.createWriteStream(logFilePath, { flags: 'a' });
  } catch (err) {
    logFileHandle = null;
  }
}

function levelFor(category) {
  const c = String(category || '').toLowerCase();
  if (c.includes('error') || c.includes('critical') || c.includes('fatal')) return LEVELS.error;
  if (c.includes('warn')) return LEVELS.warn;
  if (c.includes('debug') || c.includes('trace')) return LEVELS.debug;
  return LEVELS.info;
}

function emit(category, message, data) {
  const lvl = levelFor(category);
  if (lvl < ACTIVE_LEVEL) return;
  const ts = new Date().toISOString();
  const tag = String(category || 'log').toUpperCase();
  const tail = data !== undefined ? ` ${typeof data === 'string' ? data : JSON.stringify(data)}` : '';
  const line = `[${ts}] [${tag}] ${message}${tail}`;
  const stream = lvl >= LEVELS.error ? process.stderr : process.stdout;
  stream.write(line + '\n');
  ensureLogFile();
  if (logFileHandle) logFileHandle.write(line + '\n');
}

export const log = (category, message, data) => emit(category, message, data);

export function logAction(action, payload) {
  ensureLogFile();
  const line = JSON.stringify({ ts: new Date().toISOString(), action, ...payload }) + '\n';
  const auditPath = path.join(LOG_DIR, 'scout-actions.jsonl');
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(auditPath, line);
  } catch {}
  if (ACTIVE_LEVEL <= LEVELS.info) process.stdout.write(line);
}

export function logSnapshot(snapshot) {
  ensureLogFile();
  const line = JSON.stringify({ ts: new Date().toISOString(), ...snapshot }) + '\n';
  const snapPath = path.join(LOG_DIR, 'scout-snapshots.jsonl');
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(snapPath, line);
  } catch {}
}

export function getLogFilePath() {
  ensureLogFile();
  return logFilePath;
}

export function shutdownLogger() {
  if (logFileHandle) {
    try { logFileHandle.end(); } catch {}
    logFileHandle = null;
  }
}