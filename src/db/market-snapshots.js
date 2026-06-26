import { getDb } from './index.js';

function nowSec() { return Math.floor(Date.now() / 1000); }

export function insertSnapshot(snap) {
  if (!snap || !snap.pool_address) throw new Error('snapshot.pool_address required');
  return getDb().prepare(`
    INSERT INTO market_snapshots (
      pool_address, timestamp,
      fee_apr, volume_24h, tvl, fee_tvl_ratio, active_bin, price,
      token_price, token_price_change_24h, token_volatility_24h, token_volume_24h,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    snap.pool_address,
    snap.timestamp || nowSec(),
    snap.fee_apr ?? null,
    snap.volume_24h ?? null,
    snap.tvl ?? null,
    snap.fee_tvl_ratio ?? null,
    snap.active_bin ?? null,
    snap.price ?? null,
    snap.token_price ?? null,
    snap.token_price_change_24h ?? null,
    snap.token_volatility_24h ?? null,
    snap.token_volume_24h ?? null,
    nowSec(),
  );
}

export function latestSnapshot(poolAddress) {
  if (!poolAddress) return null;
  return getDb().prepare(`
    SELECT * FROM market_snapshots
    WHERE pool_address = ?
    ORDER BY timestamp DESC LIMIT 1
  `).get(poolAddress) || null;
}

export function nearestSnapshotAt(poolAddress, timestamp, maxDeltaSec = 24 * 3600) {
  if (!poolAddress || timestamp == null) return null;
  const rows = getDb().prepare(`
    SELECT * FROM market_snapshots
    WHERE pool_address = ?
      AND timestamp BETWEEN ? AND ?
    ORDER BY ABS(timestamp - ?) ASC
    LIMIT 1
  `).all(poolAddress, timestamp - maxDeltaSec, timestamp + maxDeltaSec, timestamp);
  return rows[0] || null;
}

export function listSnapshots(poolAddress, sinceTs = 0, limit = 100) {
  return getDb().prepare(`
    SELECT * FROM market_snapshots
    WHERE pool_address = ? AND timestamp >= ?
    ORDER BY timestamp DESC LIMIT ?
  `).all(poolAddress, sinceTs, limit);
}

export function pruneOldSnapshots(olderThanSec) {
  return getDb().prepare(`DELETE FROM market_snapshots WHERE timestamp < ?`).run(olderThanSec);
}