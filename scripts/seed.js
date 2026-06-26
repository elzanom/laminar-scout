#!/usr/bin/env node
import { importSeedWallets } from '../src/wallets/seed-wallets.js';
import { log } from '../src/utils/logger.js';

function parseArgs(argv) {
  const args = { file: null, referrer: null };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--file' || a === '-f') args.file = argv[++i];
    else if (a === '--referrer' || a === '-r') args.referrer = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else if (!args.file) args.file = a;
  }
  return args;
}

function usage() {
  process.stdout.write(
    [
      'Usage: node scripts/seed.js --file <path> [--referrer <addr>]',
      '',
      'Each non-empty, non-comment line in the file is one wallet:',
      '  <solana_address>          (bare address)',
      '  <solana_address> <alias>  (with friendly alias)',
      '',
      'Lines starting with # are skipped.',
    ].join('\n') + '\n',
  );
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.file) {
    usage();
    process.exit(args.help ? 0 : 1);
  }
  log('info', 'seed.js: starting', { file: args.file });
  const result = importSeedWallets(args.file, { referrer: args.referrer });
  log('info', 'seed.js: result', result);
  process.exit(result.ok ? 0 : 2);
}

main().catch((err) => {
  log('error', 'seed.js: fatal', { error: err.message });
  process.exit(1);
});