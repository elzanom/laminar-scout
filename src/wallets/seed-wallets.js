import { readFileSync } from 'node:fs';
import * as walletsDb from '../db/wallets.js';
import { log, logAction } from '../utils/logger.js';
import { incrCounter, recordSuccess, recordError } from '../utils/health.js';

const SOLANA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function _parseLines(content) {
  return content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function _normalizeLine(line) {
  if (!line) return null;
  if (line.startsWith('solana:')) line = line.slice('solana:'.length);
  const [addressPart, aliasPart] = line.split(/[,\s]+/);
  const address = addressPart?.trim();
  if (!SOLANA_RE.test(address)) return null;
  return { address, alias: aliasPart?.trim() || null };
}

export function parseSeedContent(content) {
  const out = [];
  for (const l of _parseLines(content)) {
    const parsed = _normalizeLine(l);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function importSeedWallets(contentOrPath, opts = {}) {
  let content = contentOrPath;
  if (typeof contentOrPath === 'string' && contentOrPath.includes('\n') === false) {
    try {
      content = readFileSync(contentOrPath, 'utf8');
    } catch (err) {
      recordError('seed_wallets.read', err, { path: contentOrPath });
      return { ok: false, reason: 'read_error', error: err.message };
    }
  }

  const parsed = parseSeedContent(content);
  const now = Math.floor(Date.now() / 1000);
  let inserted = 0;
  let updated = 0;
  const errors = [];

  for (const { address, alias } of parsed) {
    try {
      const existing = walletsDb.getWallet(address);
      const row = walletsDb.upsertWallet({
        address,
        alias: alias || existing?.alias || null,
        source: 'manual',
        discovered_from: opts.referrer || null,
        first_seen: existing?.first_seen || now,
        last_active: now,
        status: existing?.status || 'candidate',
      });
      if (existing) updated += 1;
      else inserted += 1;
      void row;
    } catch (err) {
      errors.push({ address, error: err.message });
    }
  }

  incrCounter('seed_wallets.imported', inserted + updated);
  recordSuccess('seed_wallets', { inserted, updated });
  logAction('seed_wallets.import', { inserted, updated, parsed: parsed.length });
  return { ok: true, inserted, updated, parsed: parsed.length, errors };
}

export const _test = { _parseLines, _normalizeLine, parseSeedContent };