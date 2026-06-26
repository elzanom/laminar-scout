import bs58 from 'bs58';
import { PROGRAM_IDS, classifyInstruction, isAddLiquidity, isRemoveLiquidity, isClaimFee, isClaimReward } from '../constants.js';
import { log } from '../utils/logger.js';

const PROGRAM_ID = PROGRAM_IDS.DLMM;

const ADD_LIQUIDITY_VARIANTS = new Set([
  'add_liquidity',
  'add_liquidity2',
  'add_liquidity_by_strategy',
  'add_liquidity_by_strategy2',
  'add_liquidity_by_strategy_one_side',
  'add_liquidity_by_weight',
  'add_liquidity_by_weight2',
  'add_liquidity_one_side',
  'add_liquidity_one_side_precise',
  'add_liquidity_one_side_precise2',
]);

const REMOVE_LIQUIDITY_VARIANTS = new Set([
  'remove_liquidity',
  'remove_liquidity2',
  'remove_liquidity_by_range',
  'remove_liquidity_by_range2',
]);

export function decodeInstructionData(base58Data) {
  if (!base58Data) return new Uint8Array();
  try {
    return bs58.decode(base58Data);
  } catch (err) {
    log('warn', 'tx-parser: failed to decode base58 instruction data', { error: err.message });
    return new Uint8Array();
  }
}

export function extractDiscriminator(instructionDataBytes) {
  if (!(instructionDataBytes instanceof Uint8Array) || instructionDataBytes.length < 8) return null;
  return Array.from(instructionDataBytes.slice(0, 8));
}

export function getInnerInstructions(tx) {
  const inner = tx?.meta?.innerInstructions || [];
  return inner;
}

export function findDlmmInstructions(tx) {
  const result = [];
  if (!tx) return result;

  const enhanced = Array.isArray(tx.instructions);
  const rpc = tx.transaction?.message?.instructions;

  let accountKeys = [];
  if (enhanced) {
    if (rpc) accountKeys = rpc.accountKeys || [];
  } else if (rpc) {
    accountKeys = rpc.accountKeys || tx.transaction.message.accountKeys || [];
  }

  const topLevelIxs = enhanced
    ? tx.instructions
    : (rpc ? rpc.instructions || rpc : []);

  for (let i = 0; i < (topLevelIxs?.length || 0); i++) {
    const ix = topLevelIxs[i];
    const programId = enhanced ? ix.programId : accountKeys[ix.programIdIndex];
    if (programId !== PROGRAM_ID) continue;
    const dataBytes = decodeInstructionData(ix.data);
    const disc = extractDiscriminator(dataBytes);
    const ixName = classifyInstruction(disc);
    const ixAccounts = enhanced
      ? (ix.accounts || [])
      : (ix.accounts || []).map((idx) => accountKeys[idx]);
    result.push({
      index: i,
      programId,
      discriminator: disc,
      ixName,
      accounts: ixAccounts,
      dataBytes,
      dataBase58: ix.data,
    });
  }

  for (const inner of getInnerInstructions(tx)) {
    if (!inner?.instructions) continue;
    for (let j = 0; j < inner.instructions.length; j++) {
      const ix = inner.instructions[j];
      const programId = enhanced ? ix.programId : accountKeys[ix.programIdIndex];
      if (programId !== PROGRAM_ID) continue;
      const dataBytes = decodeInstructionData(ix.data);
      const disc = extractDiscriminator(dataBytes);
      const ixName = classifyInstruction(disc);
      const ixAccounts = enhanced
        ? (ix.accounts || [])
        : (ix.accounts || []).map((idx) => accountKeys[idx]);
      result.push({
        index: `${inner.index || 0}-${j}`,
        programId,
        discriminator: disc,
        ixName,
        accounts: ixAccounts,
        dataBytes,
        dataBase58: ix.data,
        inner: true,
      });
    }
  }

  return result;
}

function asPubkey(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value.pubkey) return value.pubkey;
  if (Array.isArray(value)) {
    try { return bs58.encode(Buffer.from(value)); } catch { return null; }
  }
  return null;
}

export function parseDlmmEvent(parsedIx, tx, opts = {}) {
  if (!parsedIx || !parsedIx.ixName) return null;

  const accountKeys = tx?.transaction?.message?.accountKeys
    || (Array.isArray(tx?.instructions) ? null : [])
    || [];
  let wallet = null;
  if (accountKeys.length) wallet = asPubkey(accountKeys[0]);
  if (!wallet && typeof tx?.feePayer === 'string') wallet = tx.feePayer;
  if (!wallet && Array.isArray(tx?.instructions) && tx.instructions[0]?.accounts?.length) {
    wallet = asPubkey(tx.instructions[0].accounts[0]);
  }
  if (!wallet && opts.wallet) wallet = opts.wallet;
  const feePayer = wallet || (typeof tx?.feePayer === 'string' ? tx.feePayer : null);

  let eventType = null;
  if (isAddLiquidity(parsedIx.ixName)) eventType = 'add_liquidity';
  else if (isRemoveLiquidity(parsedIx.ixName)) eventType = 'remove_liquidity';
  else if (isClaimFee(parsedIx.ixName)) eventType = 'claim_fee';
  else if (isClaimReward(parsedIx.ixName)) eventType = 'claim_reward';
  else eventType = 'other';

  const positionMint = asPubkey(parsedIx.accounts?.[0]) || null;
  const pool = asPubkey(parsedIx.accounts?.[1]) || null;

  return {
    signature: tx.signature || tx.transaction?.signatures?.[0] || null,
    slot: tx.slot || null,
    timestamp: tx.blockTime || tx.timestamp || Math.floor(Date.now() / 1000),
    feePayer,
    wallet,
    pool,
    position_mint: positionMint,
    instruction: parsedIx.ixName,
    eventType,
    program_id: PROGRAM_ID,
    inner: !!parsedIx.inner,
    accounts: parsedIx.accounts.map(asPubkey),
    dataBase58: parsedIx.dataBase58,
    source: opts.source || 'unknown',
  };
}

export function parseTransaction(tx, opts = {}) {
  const dlmmIxs = findDlmmInstructions(tx);
  const events = [];
  for (const ix of dlmmIxs) {
    const event = parseDlmmEvent(ix, tx, opts);
    if (event) events.push(event);
  }
  return events;
}

export function isPositionOpenEvent(event) {
  return event && isAddLiquidity(event.instruction);
}

export function isPositionCloseEvent(event) {
  return event && isRemoveLiquidity(event.instruction);
}

export function isFeeEvent(event) {
  return event && (isClaimFee(event.instruction) || isClaimReward(event.instruction));
}

export const KNOWN_DLMM_INSTRUCTIONS = new Set([
  ...ADD_LIQUIDITY_VARIANTS,
  ...REMOVE_LIQUIDITY_VARIANTS,
  'claim_fee', 'claim_fee2',
  'claim_reward', 'claim_reward2',
]);

export function isKnownDlmmInstruction(name) {
  return KNOWN_DLMM_INSTRUCTIONS.has(name);
}