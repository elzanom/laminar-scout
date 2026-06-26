import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as signalsDb from '../db/signals.js';
import { getConfig } from '../config/config.js';
import { log } from '../utils/logger.js';
import { recordSuccess, recordError, incrCounter } from '../utils/health.js';

function _nowSec() { return Math.floor(Date.now() / 1000); }

async function _postJson(url, payload, opts = {}) {
  const timeoutMs = opts.timeoutMs || 5000;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`http_${res.status}`);
    return true;
  } finally {
    clearTimeout(t);
  }
}

function _appendJsonl(path, payload) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(payload) + '\n', 'utf8');
  } catch (err) {
    log('warn', 'emitter: appendJsonl failed', { path, error: err.message });
  }
}

function _formatSignalOutput(signalRow, validated) {
  const v = validated || {};
  return {
    id: signalRow.id,
    pool: signalRow.pool_address,
    token_pair: signalRow.token_pair,
    confidence: Number(signalRow.combined_confidence || 0),
    trigger: {
      type: signalRow.trigger_type,
      wallet: signalRow.triggered_by,
      wallet_score: signalRow.wallet_score,
      wallet_wr: v.wallet?.win_rate ?? null,
    },
    pool_metrics: {
      fee_window: signalRow.fee_apr,
      volume_window: signalRow.volume_24h,
      tvl: signalRow.tvl,
      organic_score: v.pool?.organic_score ?? null,
    },
    suggested: {
      bin_step: signalRow.suggested_bin_step,
      range_lower: signalRow.suggested_range_lower,
      range_upper: signalRow.suggested_range_upper,
    },
    validation_reasons: typeof signalRow.validation_reasons === 'string'
      ? JSON.parse(signalRow.validation_reasons)
      : (signalRow.validation_reasons || []),
    created_at: signalRow.created_at,
  };
}

function _writeSignalFile(filePath, signals) {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(signals, null, 2));
  } catch (err) {
    log('warn', 'emitter: writeSignalFile failed', { filePath, error: err.message });
  }
}

export async function emitSignal(validatedSignal, opts = {}) {
  if (!validatedSignal?.pass || !validatedSignal.signal) {
    return { ok: false, reason: 'invalid_validated' };
  }

  const cfg = getConfig();
  const dedupWindowSec = (cfg.signal?.dedupWindowMinutes ?? 15) * 60;
  const outputMode = cfg.signal?.outputMode || 'file';
  const outputPath = resolve(cfg.signal?.outputPath || './signals-output.json');
  const apiEndpoint = cfg.signal?.apiEndpoint || '';
  const emitExpired = cfg.signal?.expiryMinutes ?? 60;

  const sig = validatedSignal.signal;
  const nowSec = _nowSec();

  const recent = signalsDb.recentSignalForPool(sig.pool_address, nowSec - dedupWindowSec);
  if (recent) {
    incrCounter('emitter.dedup_skip');
    return { ok: false, reason: 'deduped', recent_id: recent.id, dedup_window_sec: dedupWindowSec };
  }

  let signalId;
  try {
    signalId = signalsDb.insertSignal({
      ...sig,
      status: 'pending',
    });
  } catch (err) {
    recordError('emitter.insert', err, { pool: sig.pool_address });
    return { ok: false, reason: 'insert_error', error: err.message };
  }

  const inserted = signalsDb.getSignal(signalId);
  const payload = _formatSignalOutput(inserted, validatedSignal);

  if (outputMode === 'file') {
    let existing = [];
    if (existsSync(outputPath)) {
      try {
        existing = JSON.parse(readFileSync(outputPath, 'utf8') || '[]');
        if (!Array.isArray(existing)) existing = [];
      } catch {
        existing = [];
      }
    }
    existing.unshift(payload);
    if (existing.length > 100) existing = existing.slice(0, 100);
    _writeSignalFile(outputPath, existing);
  } else if (outputMode === 'stdout') {
    process.stdout.write(JSON.stringify(payload) + '\n');
  } else if (outputMode === 'jsonl') {
    _appendJsonl(outputPath, payload);
  }

  let apiOk = false;
  if (apiEndpoint) {
    try {
      await _postJson(apiEndpoint, payload);
      apiOk = true;
    } catch (err) {
      log('warn', 'emitter: apiEndpoint POST failed', { endpoint: apiEndpoint, error: err.message });
    }
  }

  try {
    signalsDb.markSignalStatus(signalId, 'sent', nowSec);
  } catch (err) {
    log('warn', 'emitter: markSignalStatus failed', { signalId, error: err.message });
  }

  recordSuccess('emitter', { signalId, pool: sig.pool_address, outputMode, apiOk });
  incrCounter('emitter.emitted');
  return { ok: true, signal_id: signalId, payload, output_mode: outputMode, api_ok: apiOk };
}

export function expireStaleSignals() {
  const cfg = getConfig();
  const emitExpired = cfg.signal?.expiryMinutes ?? 60;
  const updated = signalsDb.expireStaleSignals(emitExpired * 60);
  if (updated?.changes) incrCounter('emitter.expired', updated.changes);
  return updated?.changes || 0;
}

export const _test = { _formatSignalOutput, _appendJsonl, _postJson };