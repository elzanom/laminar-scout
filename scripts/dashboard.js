#!/usr/bin/env node
// Standalone dashboard process — reads scout DB and serves HTML/JS/CSS + JSON APIs.
// Usage: node scripts/dashboard.js [--port 3002]
// Env:   DASHBOARD_PORT (default 3002)

import { startDashboard } from '../src/dashboard/server.js';

function parseArgs(argv) {
  const args = { port: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--port') args.port = Number(argv[++i]);
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node scripts/dashboard.js [--port 3002]');
      process.exit(0);
    }
  }
  return args;
}

const args = parseArgs(process.argv);
const handle = startDashboard({ port: args.port || undefined });

function shutdown(signal) {
  console.log(`\n[dashboard] received ${signal}, shutting down…`);
  handle.stop().then(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('[dashboard] uncaught:', err);
  shutdown('uncaughtException');
});