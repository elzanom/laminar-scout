#!/usr/bin/env node
// Stop all laminar-scout PM2 processes gracefully (SIGTERM, not kill).
// Idempotent: if not running, reports clean.
// Usage: node scripts/stop.js
//        npm run stop:all

import pm2 from 'pm2';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function pad(s, n) { return (s + ' '.repeat(n)).slice(0, n); }

async function connect() {
  return new Promise((resolve, reject) => {
    pm2.connect((err) => err ? reject(err) : resolve());
  });
}

async function list() {
  return new Promise((resolve, reject) => {
    pm2.list((err, procs) => err ? reject(err) : resolve(procs || []));
  });
}

async function deleteProc(name) {
  return new Promise((resolve, reject) => {
    pm2.delete(name, (err) => err && err.message !== 'process name not found' ? reject(err) : resolve());
  });
}

function statusBadge(status) {
  const map = {
    online:    '\x1b[32monline\x1b[0m',
    stopping:  '\x1b[33mstopping\x1b[0m',
    stopped:   '\x1b[31mstopped\x1b[0m',
    errored:   '\x1b[31merrored\x1b[0m',
    launched:  '\x1b[33mlaunched\x1b[0m',
  };
  return map[status] || status;
}

async function main() {
  const t0 = Date.now();
  await connect();

  const procs = (await list()).filter((p) => p.name?.startsWith('laminar-scout'));
  console.log('■ laminar-scout stop\n');

  if (procs.length === 0) {
    console.log('  ✓ nothing to stop (no laminar-scout processes found)');
    pm2.disconnect();
    return;
  }

  console.log(`  found ${procs.length} processes:`);
  for (const p of procs) {
    console.log(`    ${pad(p.name, 28)}${statusBadge(p.pm2_env?.status || 'unknown')}`);
  }
  console.log('');
  console.log('  sending graceful stop (SIGTERM)…');

  for (const p of procs) {
    await deleteProc(p.name);
  }

  const waitMs = 3000;
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const remaining = (await list()).filter((q) => q.name?.startsWith('laminar-scout'));
    if (remaining.length === 0) break;
  }

  const after = (await list()).filter((p) => p.name?.startsWith('laminar-scout'));
  const elapsed = Date.now() - t0;

  console.log('');
  if (after.length === 0) {
    console.log(`  ✓ all stopped cleanly in ${elapsed}ms`);
  } else {
    console.log(`  ⚠ ${after.length} processes still alive after ${elapsed}ms:`);
    for (const p of after) console.log(`    - ${p.name} (${p.pm2_env?.status || 'unknown'})`);
    console.log('  try: pm2 kill --force  (last resort)');
  }
  console.log('');
  console.log('  next:  node scripts/start.js  to bring them back up');

  pm2.disconnect();
}

main().catch((err) => {
  console.error('✗ failed:', err.message || err);
  try { pm2.disconnect(); } catch {}
  process.exit(1);
});