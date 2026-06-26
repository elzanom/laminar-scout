import fs from 'node:fs';
import path from 'node:path';
import { log } from './logger.js';

const DEFAULT_STALL_WARN_MS = 180 * 60 * 1000;
const DEFAULT_HEARTBEAT_MS = 60 * 60 * 1000;

const state = Object.create(null);
const counters = Object.create(null);
let lastHeartbeatAt = 0;
let cfg = {
  healthHeartbeatMinutes: 60,
  healthStallWarnMinutes: 180,
  logDir: './logs',
};

function now() {
  return Date.now();
}

export function configureHealth(options = {}) {
  cfg = { ...cfg, ...options };
}

export function recordSuccess(subsystem, meta = {}) {
  state[subsystem] = {
    ...(state[subsystem] || {}),
    last_success: now(),
    last_meta: meta,
    last_error: state[subsystem]?.last_error,
    last_error_message: state[subsystem]?.last_error_message,
  };
}

export function recordError(subsystem, err, meta = {}) {
  state[subsystem] = {
    ...(state[subsystem] || {}),
    last_error: now(),
    last_error_message: err?.message || String(err),
    last_meta: meta,
  };
  log('error', `health[${subsystem}]`, { error: err?.message || String(err), ...meta });
}

export function getSubsystemState(subsystem) {
  return state[subsystem] || null;
}

export function getAllState() {
  return {
    subsystems: { ...state },
    counters: { ...counters },
    last_heartbeat_at: lastHeartbeatAt,
  };
}

export function incrCounter(name, n = 1) {
  counters[name] = (counters[name] || 0) + n;
}

export function getCounters() {
  return { ...counters };
}

export function isStalled(subsystem, maxAgeMs = cfg.healthStallWarnMinutes * 60 * 1000) {
  const s = state[subsystem];
  if (!s?.last_success) return true;
  return now() - s.last_success > maxAgeMs;
}

export function getStalledSubsystems(maxAgeMs = cfg.healthStallWarnMinutes * 60 * 1000) {
  return Object.keys(state).filter((k) => isStalled(k, maxAgeMs));
}

function writeHeartbeatFile(payload) {
  const dir = cfg.logDir || './logs';
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'scout-heartbeat.jsonl');
    fs.appendFileSync(file, payload + '\n');
  } catch (err) {
    log('warn', 'health: failed to write heartbeat', { error: err.message });
  }
}

export function emitHeartbeat(force = false) {
  const intervalMs = cfg.healthHeartbeatMinutes * 60 * 1000;
  const t = now();
  if (!force && t - lastHeartbeatAt < intervalMs) return false;
  lastHeartbeatAt = t;
  const payload = JSON.stringify({ ts: new Date(t).toISOString(), ...getAllState() });
  writeHeartbeatFile(payload);
  log('info', 'health: heartbeat', { subsystems: Object.keys(state).length, counters: Object.keys(counters).length });
  return true;
}

export function startHealthHeartbeat() {
  const intervalMs = Math.max(60_000, cfg.healthHeartbeatMinutes * 60 * 1000);
  const timer = setInterval(() => emitHeartbeat(false), intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

export const HEALTH_DEFAULTS = { DEFAULT_STALL_WARN_MS, DEFAULT_HEARTBEAT_MS };