import { listPositionOwnersForPool } from '../collector/pool-lpers.js';
import { listWallets, upsertWallet, getWallet } from '../db/wallets.js';
import { listPositions } from '../db/positions.js';
import { log, logAction } from '../utils/logger.js';
import { recordSuccess, recordError, incrCounter } from '../utils/health.js';
import { getConfig } from '../config/config.js';

const SOURCE_TAG = 'follow_winner';
const KNOWN_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function isLikelySolanaAddress(s) {
  return typeof s === 'string' && KNOWN_MINT_RE.test(s);
}

function distinctPoolsForWallet(walletAddress) {
  const positions = listPositions({ wallet_address: walletAddress }, { limit: 500 });
  const pools = new Set();
  for (const p of positions) {
    if (p.pool_address) pools.add(p.pool_address);
  }
  return [...pools];
}

async function enumerateOwnersForTopWalletPools(topWallet) {
  const pools = distinctPoolsForWallet(topWallet.address);
  if (!pools.length) return { pools: 0, owners: [] };

  const ownersAll = new Set();
  const perPool = {};
  for (const pool of pools) {
    try {
      const { owners } = await listPositionOwnersForPool(pool, { ttlMs: 5 * 60 * 1000 });
      perPool[pool] = owners.length;
      for (const o of owners) {
        if (!isLikelySolanaAddress(o)) continue;
        if (o === topWallet.address) continue;
        ownersAll.add(o);
      }
    } catch (err) {
      recordError('follow-winners.enumerate', err, { pool, topWallet: topWallet.address });
      perPool[pool] = 0;
    }
  }
  return { pools: pools.length, owners: [...ownersAll], perPool };
}

function insertCoOccurrenceCandidate(coOccurringWallet, topWalletAddress, poolAddress) {
  const existing = getWallet(coOccurringWallet);
  const ts = Math.floor(Date.now() / 1000);
  if (existing) {
    upsertWallet({
      address: coOccurringWallet,
      last_active: ts,
    });
    return 'updated';
  }
  upsertWallet({
    address: coOccurringWallet,
    source: SOURCE_TAG,
    discovered_from: topWalletAddress,
    status: 'candidate',
    first_seen: ts,
    last_active: ts,
  });
  return 'inserted';
}

export async function discoverFromTopWallet(topWallet) {
  if (!topWallet?.address) return { wallet: null, newCandidates: 0, skipped: 'invalid_wallet' };
  let result;
  try {
    result = await enumerateOwnersForTopWalletPools(topWallet);
  } catch (err) {
    recordError('follow-winners.topWallet', err, { topWallet: topWallet.address });
    return { wallet: topWallet.address, error: err.message };
  }

  let newCount = 0;
  let seenCount = 0;
  for (const owner of result.owners) {
    const existing = getWallet(owner);
    if (existing) {
      seenCount += 1;
      continue;
    }
    insertCoOccurrenceCandidate(owner, topWallet.address, null);
    newCount += 1;
  }

  incrCounter('follow_winners.owners_seen', result.owners.length);
  incrCounter('follow_winners.new_candidates', newCount);
  recordSuccess('follow-winners.topWallet', {
    topWallet: topWallet.address,
    pools: result.pools,
    owners: result.owners.length,
    newCandidates: newCount,
  });

  return {
    wallet: topWallet.address,
    pools: result.pools,
    owners: result.owners.length,
    newCandidates: newCount,
    seenCount,
    perPool: result.perPool,
  };
}

export async function discoverFromAllTopWallets(opts = {}) {
  const cfg = getConfig();
  const limit = opts.limit || cfg.walletTier.topWalletLimit || 100;
  const topWallets = listWallets({ is_top_wallet: 1 }, { limit });
  if (!topWallets.length) {
    log('info', 'follow-winners: no top wallets yet, nothing to do');
    return { topWallets: 0, totalNewCandidates: 0 };
  }

  const perTop = [];
  let totalNew = 0;
  for (const tw of topWallets) {
    try {
      const r = await discoverFromTopWallet(tw);
      perTop.push(r);
      totalNew += r.newCandidates || 0;
    } catch (err) {
      recordError('follow-winners.perTop', err, { topWallet: tw.address });
      perTop.push({ wallet: tw?.address, error: err.message });
    }
  }

  incrCounter('follow_winners.cycle.top_wallets', topWallets.length);
  incrCounter('follow_winners.cycle.new_candidates', totalNew);
  recordSuccess('follow-winners.cycle', {
    topWallets: topWallets.length,
    totalNewCandidates: totalNew,
  });
  logAction('follow-winners.cycle', {
    topWallets: topWallets.length,
    totalNewCandidates: totalNew,
  });

  return {
    topWallets: topWallets.length,
    totalNewCandidates: totalNew,
    perTop,
  };
}

export const _test = { distinctPoolsForWallet, enumerateOwnersForTopWalletPools, insertCoOccurrenceCandidate };