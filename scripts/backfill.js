#!/usr/bin/env node
import { backfillWallet } from '../src/collector/helius-history.js';
import { syncWalletPositionsFromPnl } from '../src/trackers/position-builder.js';
import { evaluateWallet } from '../src/discovery/wallet-evaluator.js';
import { getWallet } from '../src/db/wallets.js';
import { log } from '../src/utils/logger.js';

function parseArgs(argv) {
  const args = { wallet: null, days: 90, force: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--wallet' || a === '-w') args.wallet = argv[++i];
    else if (a === '--days' || a === '-d') args.days = Number(argv[++i]);
    else if (a === '--force') args.force = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (!args.wallet) args.wallet = a;
  }
  return args;
}

function usage() {
  process.stdout.write(
    [
      'Usage: node scripts/backfill.js --wallet <address> [--days N] [--force]',
      '',
      'Pipeline:',
      '  1. Backfill Helius TX history (default: 90 days)',
      '  2. Sync positions from Meteora PnL API',
      '  3. (Optional) Re-run evaluator to update wallet tier',
    ].join('\n') + '\n',
  );
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.wallet) {
    usage();
    process.exit(args.help ? 0 : 1);
  }
  const existing = getWallet(args.wallet);
  log('info', 'backfill.js: starting', { wallet: args.wallet, days: args.days, exists: !!existing });

  const bf = await backfillWallet(args.wallet, { days: args.days });
  log('info', 'backfill.js: helius backfill done', bf);

  const pools = existing ? Array.from(new Set([])).filter(Boolean) : [];
  const pos = await syncWalletPositionsFromPnl(args.wallet, pools);
  log('info', 'backfill.js: positions synced', pos);

  if (args.force) {
    const evalRes = await evaluateWallet(args.wallet, { force: true });
    log('info', 'backfill.js: evaluation', { tier: evalRes.tier, score: evalRes.score });
  }

  process.exit(0);
}

main().catch((err) => {
  log('error', 'backfill.js: fatal', { error: err.message });
  process.exit(1);
});