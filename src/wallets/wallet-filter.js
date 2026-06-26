import * as walletsDb from '../db/wallets.js';
import { rankWallet } from './wallet-ranker.js';
import { getConfig } from '../config/config.js';
import { log, logAction } from '../utils/logger.js';
import { incrCounter, recordSuccess } from '../utils/health.js';

function _nowSec() { return Math.floor(Date.now() / 1000); }

export function applyTierFilters() {
  const cfg = getConfig();
  const topLimit = cfg.topWalletLimit ?? 100;
  let promoted = 0;
  let demoted = 0;
  let topCapDemoted = 0;

  const tracked = walletsDb.listWallets({ status: 'tracked' }, { limit: 1000 });
  for (const w of tracked) {
    if (w.is_top_wallet === 1) {
      const res = walletsDb.setWalletStatus(w.address, 'top', {
        is_top_wallet: 1,
        is_tracked: 1,
      });
      if (res?.changes) promoted += 1;
    }
  }

  if (cfg.autoDemoteTopWallet !== false) {
    const allTop = walletsDb.listWallets({ status: 'top' }, { limit: 1000 });
    const sorted = [...allTop].sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
    const keep = new Set(sorted.slice(0, topLimit).map((w) => w.address));
    for (const w of allTop) {
      if (!keep.has(w.address)) {
        walletsDb.setWalletStatus(w.address, 'tracked', {
          is_top_wallet: 0,
        });
        topCapDemoted += 1;
        demoted += 1;
      }
    }
  }

  const rejected = walletsDb.listWallets({ status: 'rejected' }, { limit: 1000 });
  for (const w of rejected) {
    const reevalHours = cfg.reEvaluateIntervalHours ?? 168;
    const due = !w.last_evaluated || (_nowSec() - w.last_evaluated) >= reevalHours * 3600;
    if (!due) continue;
    walletsDb.setWalletStatus(w.address, 'candidate', {
      reject_reason: null,
    });
    promoted += 1;
  }

  if (promoted || demoted || topCapDemoted) {
    logAction('wallet_filter.apply', { promoted, demoted, topCapDemoted });
    incrCounter('wallet_filter.runs');
    incrCounter('wallet_filter.promoted', promoted);
    incrCounter('wallet_filter.demoted', demoted);
  }
  recordSuccess('wallet_filter', { promoted, demoted, topCapDemoted });
  return { promoted, demoted, topCapDemoted };
}

export async function promoteTrackedToTop(address, opts = {}) {
  const force = opts.force === true;
  const wallet = walletsDb.getWallet(address);
  if (!wallet) return { ok: false, reason: 'not_found' };
  if (wallet.status !== 'tracked' && !force) {
    return { ok: false, reason: 'not_tracked', current: wallet.status };
  }
  if (!force) {
    const ranked = await rankWallet(address, { force: false });
    if (!ranked.ok) return { ok: false, reason: ranked.reason };
    if (ranked.score < (getConfig().minWalletScore || 45)) {
      return { ok: false, reason: 'score_below_threshold', score: ranked.score };
    }
  }
  walletsDb.markTopWallet(address, 1);
  walletsDb.markTracked(address, 1);
  walletsDb.setWalletStatus(address, 'top', {});
  incrCounter('wallet_filter.promote_to_top');
  logAction('wallet_filter.promote', { wallet: address });
  return { ok: true, wallet: address };
}

export async function demoteTopToTracked(address) {
  const wallet = walletsDb.getWallet(address);
  if (!wallet) return { ok: false, reason: 'not_found' };
  walletsDb.markTopWallet(address, 0);
  walletsDb.setWalletStatus(address, 'tracked', {});
  incrCounter('wallet_filter.demote_top');
  return { ok: true, wallet: address };
}

export const _test = { applyTierFilters };