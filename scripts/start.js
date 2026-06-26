#!/usr/bin/env node
// Start all laminar-scout PM2 processes (main + webhook + dashboard).
// Idempotent: if already running, leaves them alone and just reports status.
// Usage: node scripts/start.js
//        npm run start:all

import pm2 from 'pm2';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ECOSYSTEM = path.join(ROOT, 'ecosystem.config.cjs');

function ms(n) { return `${n.toFixed(0)}ms`; }
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
    pm2.delete(name, (err) => {
      if (err && err.message && !err.message.includes('not found')) return reject(err);
      resolve();
    });
  });
}

function describeProc(p) {
  const status = p.pm2_env?.status || 'unknown';
  const name = p.name;
  const pid = p.pid || 0;
  const uptime = p.pm2_env?.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : 0;
  const mem = p.monit?.memory ? `${(p.monit.memory / 1024 / 1024).toFixed(0)}MB` : '--';
  const cpu = p.monit?.cpu != null ? `${p.monit.cpu.toFixed(0)}%` : '--';
  const restarts = p.pm2_env?.restart_time ?? 0;
  return { name, status, pid, uptime, mem, cpu, restarts };
}

function printTable(procs) {
  if (!procs.length) {
    console.log('  (no processes)');
    return;
  }
  const header = `${pad('name', 28)}${pad('status', 11)}${pad('pid', 8)}${pad('uptime', 14)}${pad('cpu', 6)}${pad('mem', 8)}${pad('restarts', 9)}`;
  console.log('  ' + header);
  console.log('  ' + '-'.repeat(header.length));
  for (const p of procs) {
    const uptimeStr = p.uptime > 0 ? `${(p.uptime / 1000 / 60).toFixed(1)}m` : '--';
    console.log(`  ${pad(p.name, 28)}${pad(p.status, 11)}${pad(String(p.pid), 8)}${pad(uptimeStr, 14)}${pad(p.cpu, 6)}${pad(p.mem, 8)}${pad(String(p.restarts), 9)}`);
  }
}

async function main() {
  const t0 = Date.now();
  await connect();

  const before = await list();
  const scoutProcs = before.filter((p) => p.name?.startsWith('laminar-scout'));
  const allOnline = scoutProcs.length > 0 && scoutProcs.every((p) => p.pm2_env?.status === 'online');

  console.log('▶ laminar-scout start\n');

  if (allOnline) {
    console.log('  ✓ already running (idempotent — left running, no action)');
    console.log('');
    const described = scoutProcs.map(describeProc);
    printTable(described);
    printUrls();
    pm2.disconnect();
    return;
  }

  const stale = before.filter((p) => p.name?.startsWith('laminar-scout'));
  if (stale.length > 0) {
    console.log(`  clearing ${stale.length} stale PM2 entries…`);
    for (const p of stale) await deleteProc(p.name);
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log('  starting processes from ecosystem.config.cjs…');
  await new Promise((resolve, reject) => {
    pm2.start(ECOSYSTEM, (err) => err ? reject(err) : resolve());
  });

  await new Promise((r) => setTimeout(r, 1500));

  const after = await list();
  const scoutAfter = after.filter((p) => p.name?.startsWith('laminar-scout')).map(describeProc);

  console.log('');
  console.log(`  ✓ started ${scoutAfter.length} processes in ${ms(Date.now() - t0)}`);
  console.log('');
  printTable(scoutAfter);
  printUrls();

  const failed = scoutAfter.filter((p) => p.status !== 'online');
  if (failed.length) {
    console.log('');
    console.log('  ⚠ some processes failed to come online:');
    for (const f of failed) console.log(`    - ${f.name} (${f.status})`);
    console.log('  check logs: pm2 logs laminar-scout');
  }

  pm2.disconnect();
}

function printUrls() {
  console.log('');
  console.log('  access points:');
  console.log('    dashboard      http://localhost:3002');
  console.log('    webhook        POST http://localhost:3001/webhook/helius');
  console.log('    logs           pm2 logs laminar-scout');
  console.log('    stop           node scripts/stop.js');
  console.log('    status         node scripts/status.js');
}

main().catch((err) => {
  console.error('✗ failed:', err.message || err);
  try { pm2.disconnect(); } catch {}
  process.exit(1);
});