import bs58 from 'bs58';
import crypto from 'node:crypto';
import { parseTransaction, parseDlmmEvent, findDlmmInstructions } from '../src/collector/tx-parser.js';
import { INSTRUCTION_DISCRIMINATORS, PROGRAM_IDS } from '../src/constants.js';

function mkPub(seed) {
  const h = crypto.createHash('sha256').update(seed).digest();
  return bs58.encode(h);
}

function mkTx({ ixName, accounts, signer, blockTime = 1700000000, slot = 12345, signature = 'sigabc' }) {
  const dataBytes = new Uint8Array(8);
  const disc = INSTRUCTION_DISCRIMINATORS[ixName];
  for (let i = 0; i < 8; i++) dataBytes[i] = disc[i];
  const dataBase58 = bs58.encode(Buffer.from(dataBytes));

  const ixAccounts = accounts.map((_, i) => i + 1);
  const accountKeys = [signer, ...accounts, PROGRAM_IDS.DLMM];
  const ix = {
    programIdIndex: accountKeys.length - 1,
    accounts: ixAccounts,
    data: dataBase58,
  };
  return {
    signature,
    slot,
    blockTime,
    timestamp: blockTime,
    transaction: {
      message: {
        accountKeys,
        instructions: [ix],
        recentBlockhash: '11111111111111111111111111111111',
      },
    },
    meta: { innerInstructions: [] },
  };
}

function assert(cond, msg) {
  if (!cond) { throw new Error('FAIL: ' + msg); }
  console.log('  ✓', msg);
}

function run() {
  console.log('=== tx-parser smoke test ===');

  const wallet = mkPub('wallet');
  const posMint = mkPub('position-mint-1');
  const pool = mkPub('pool-1');

  const tx = mkTx({
    ixName: 'add_liquidity',
    accounts: [posMint, pool],
    signer: wallet,
  });

  const ixs = findDlmmInstructions(tx);
  assert(ixs.length === 1, 'one DLMM instruction found');
  assert(ixs[0].ixName === 'add_liquidity', `classified as add_liquidity (got ${ixs[0].ixName})`);
  assert(ixs[0].accounts.length === 2, 'accounts includes position + pool');
  assert(ixs[0].accounts[0] === posMint, 'position account is accounts[0]');
  assert(ixs[0].accounts[1] === pool, 'pool account is accounts[1]');

  const events = parseTransaction(tx, { source: 'test' });
  assert(events.length === 1, 'one event parsed');
  const e = events[0];
  assert(e.eventType === 'add_liquidity', `eventType is add_liquidity (got ${e.eventType})`);
  assert(e.wallet === wallet, 'wallet = fee payer');
  assert(e.pool === pool, 'pool mapped correctly');
  assert(e.position_mint === posMint, 'position_mint mapped correctly');
  assert(e.instruction === 'add_liquidity', 'instruction name correct');
  assert(e.timestamp === 1700000000, 'timestamp from blockTime');
  assert(e.signature === 'sigabc', 'signature passed through');

  const posMint2 = mkPub('position-mint-2');
  const pool2 = mkPub('pool-2');
  const tx2 = mkTx({
    ixName: 'remove_liquidity2',
    accounts: [posMint2, pool2],
    signer: wallet,
    signature: 'sigxyz',
  });
  const e2 = parseTransaction(tx2, { source: 'test' })[0];
  assert(e2.eventType === 'remove_liquidity', `eventType is remove_liquidity (got ${e2.eventType})`);
  assert(e2.instruction === 'remove_liquidity2', 'instruction name reflects variant');

  const posMint3 = mkPub('position-mint-3');
  const pool3 = mkPub('pool-3');
  const tx3 = mkTx({
    ixName: 'claim_fee',
    accounts: [posMint3, pool3],
    signer: wallet,
  });
  const e3 = parseTransaction(tx3, { source: 'test' })[0];
  assert(e3.eventType === 'claim_fee', 'eventType is claim_fee');

  const posMint4 = mkPub('position-mint-4');
  const pool4 = mkPub('pool-4');
  const tx4 = mkTx({
    ixName: 'claim_reward2',
    accounts: [posMint4, pool4],
    signer: wallet,
  });
  const e4 = parseTransaction(tx4, { source: 'test' })[0];
  assert(e4.eventType === 'claim_reward', 'eventType is claim_reward');

  const nonMeteoraTx = mkTx({
    ixName: 'add_liquidity',
    accounts: [mkPub('xx'), mkPub('yy')],
    signer: wallet,
  });
  nonMeteoraTx.transaction.message.accountKeys[nonMeteoraTx.transaction.message.accountKeys.length - 1] = mkPub('otherprog');
  const evs = parseTransaction(nonMeteoraTx);
  assert(evs.length === 0, 'non-DLMM program produces no events');

  console.log('\n=== all tx-parser assertions passed ===');
}

try {
  run();
  console.log('\n✓ tx-parser smoke test passed');
  process.exit(0);
} catch (err) {
  console.error('\n✗ tx-parser smoke test FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
}