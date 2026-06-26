import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { getConfig } from '../config/config.js';
import { log } from '../utils/logger.js';
import { recordSuccess, recordError } from '../utils/health.js';
import { POSITION_V2, PROGRAM_IDS } from '../constants.js';

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_RPC_COOLDOWN_MS = 1_500;
const MAX_PAGE_LIMIT = 10_000;

const cacheByPool = new Map();
let lastRpcAt = 0;
let connectionSingleton = null;

function getConnection() {
  if (connectionSingleton) return connectionSingleton;
  const cfg = getConfig();
  if (!cfg.helius.rpcUrl) throw new Error('helius.rpcUrl not configured');
  connectionSingleton = new Connection(cfg.helius.rpcUrl, 'confirmed');
  return connectionSingleton;
}

async function rpcCooldown() {
  const minDelta = DEFAULT_RPC_COOLDOWN_MS;
  const now = Date.now();
  const wait = Math.max(0, lastRpcAt + minDelta - now);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRpcAt = Date.now();
}

function decodeOwner(dataBytes) {
  if (!dataBytes || dataBytes.length < POSITION_V2.OFFSET_OWNER + 32) return null;
  const slice = dataBytes.slice(POSITION_V2.OFFSET_OWNER, POSITION_V2.OFFSET_OWNER + 32);
  return bs58.encode(Buffer.from(slice));
}

function decodePair(dataBytes) {
  if (!dataBytes || dataBytes.length < POSITION_V2.OFFSET_LB_PAIR + 32) return null;
  const slice = dataBytes.slice(POSITION_V2.OFFSET_LB_PAIR, POSITION_V2.OFFSET_LB_PAIR + 32);
  return bs58.encode(Buffer.from(slice));
}

function decodeBinIds(dataBytes) {
  if (!dataBytes || dataBytes.length < POSITION_V2.OFFSET_UPPER_BIN_ID + 4) return null;
  const dv = new DataView(dataBytes.buffer, dataBytes.byteOffset, dataBytes.byteLength);
  const lower = dv.getInt32(POSITION_V2.OFFSET_LOWER_BIN_ID, true);
  const upper = dv.getInt32(POSITION_V2.OFFSET_UPPER_BIN_ID, true);
  return { lower_bin_id: lower, upper_bin_id: upper };
}

export function parsePositionAccount(dataBytes) {
  if (!dataBytes || dataBytes.length < POSITION_V2.ACCOUNT_SIZE) return null;
  if (!dataBytes.slice(0, 8).every((b, i) => b === POSITION_V2.DISCRIMINATOR[i])) return null;
  return {
    lb_pair: decodePair(dataBytes),
    owner: decodeOwner(dataBytes),
    ...decodeBinIds(dataBytes),
  };
}

export async function listPositionOwnersForPool(poolAddress, opts = {}) {
  const cfg = getConfig();
  if (!poolAddress) throw new Error('poolAddress required');
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const cached = cacheByPool.get(poolAddress);
  if (cached && Date.now() - cached.fetchedAt < ttl) {
    return { owners: cached.owners, count: cached.owners.length, fromCache: true };
  }

  const conn = getConnection();
  const programId = new PublicKey(PROGRAM_IDS.DLMM);
  const poolKey = new PublicKey(poolAddress);

  await rpcCooldown();

  let result;
  try {
    result = await conn.getProgramAccounts(programId, {
      filters: [
        { dataSize: POSITION_V2.ACCOUNT_SIZE },
        { memcmp: { offset: POSITION_V2.OFFSET_LB_PAIR, bytes: poolKey.toBase58() } },
      ],
      dataSlice: { offset: POSITION_V2.OFFSET_LB_PAIR, length: 64 },
    });
  } catch (err) {
    recordError('pool-lpers.rpc', err, { pool: poolAddress });
    throw err;
  }

  const owners = new Set();
  const SLICE_OWNER_OFFSET = POSITION_V2.OFFSET_OWNER - POSITION_V2.OFFSET_LB_PAIR;
  for (const acc of result) {
    const data = acc.account.data;
    if (!data || data.length < SLICE_OWNER_OFFSET + 32) continue;
    const owner = bs58.encode(Buffer.from(data.slice(SLICE_OWNER_OFFSET, SLICE_OWNER_OFFSET + 32)));
    owners.add(owner);
  }

  const ownersList = [...owners];
  cacheByPool.set(poolAddress, { owners: ownersList, fetchedAt: Date.now() });
  recordSuccess('pool-lpers', { pool: poolAddress, owners: ownersList.length });

  log('info', `pool-lpers: enumerated ${ownersList.length} owners for pool ${poolAddress}`);
  return { owners: ownersList, count: ownersList.length, fromCache: false };
}

export async function listPositionOwnersForManyPools(poolAddresses, opts = {}) {
  const all = new Set();
  const perPool = {};
  for (const pool of poolAddresses) {
    const { owners } = await listPositionOwnersForPool(pool, opts);
    perPool[pool] = owners.length;
    for (const o of owners) all.add(o);
  }
  return { owners: [...all], total: all.size, perPool };
}

export function clearPoolLpersCache(poolAddress = null) {
  if (poolAddress) cacheByPool.delete(poolAddress);
  else cacheByPool.clear();
}

export async function fetchPositionAccount(mintAddress) {
  const conn = getConnection();
  const pk = new PublicKey(mintAddress);
  await rpcCooldown();
  const info = await conn.getAccountInfo(pk, 'confirmed');
  if (!info) return null;
  return parsePositionAccount(info.data);
}

export function getConnectionInstance() {
  return getConnection();
}