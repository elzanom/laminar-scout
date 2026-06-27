#!/usr/bin/env node
// Show current state of all laminar-scout PM2 processes.
// Usage: node scripts/status.js
//        npm run status

import pm2 from 'pm2';

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

function pad(s, n) { return (s + ' '.repeat(n)).slice(0, n); }

function describeProc(p) {
  const status = p.pm2_env?.status || 'unknown';
  const uptime = p.pm2_env?.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : 0;
  const mem = p.monit?.memory ? `${(p.monit.memory / 1024 / 1024).toFixed(0)}MB` : '--';
  const cpu = p.monit?.cpu != null ? `${p.monit.cpu.toFixed(0)}%` : '--';
  const restarts = p.pm2_env?.restart_time ?? 0;
  return { name: p.name, status, pid: p.pid || 0, uptime, mem, cpu, restarts };
}

function colorize(status) {
  const useColors = process.stdout.isTTY;
  if (!useColors) return status.padEnd(10);
  const map = {
    online:   `\x1b[32m${status}\x1b[0m`,
    stopping: `\x1b[33m${status}\x1b[0m`,
    stopped:  `\x1b[31m${status}\x1b[0m`,
    errored:  `\x1b[31m${status}\x1b[0m`,
    launched: `\x1b[33m${status}\x1b[0m`,
  };
  return (map[status] || status).padEnd(20);
}

async function main() {
  await connect();
  const procs = (await list()).filter((p) => p.name?.startsWith('laminar-scout'));
  const described = procs.map(describeProc);

  console.log('■ laminar-scout status\n');

  if (described.length === 0) {
    console.log('  (no laminar-scout processes)');
    console.log('');
    console.log('  start:  node scripts/start.js');
    pm2.disconnect();
    return;
  }

  console.log(`  ${pad('name', 28)}${pad('status', 20)}${pad('pid', 8)}${pad('uptime', 14)}${pad('cpu', 6)}${pad('mem', 8)}${pad('restarts', 9)}`);
  console.log('  ' + '-'.repeat(93));
  for (const p of described) {
    const uptimeStr = p.uptime > 0 ? `${(p.uptime / 1000 / 60).toFixed(1)}m` : '--';
    console.log(`  ${pad(p.name, 28)}${colorize(p.status)}${pad(String(p.pid), 8)}${pad(uptimeStr, 14)}${pad(p.cpu, 6)}${pad(p.mem, 8)}${pad(String(p.restarts), 9)}`);
  }
  console.log('');

  const allOnline = described.every((p) => p.status === 'online');
  if (allOnline) {
    console.log('  ✓ all online');
    console.log('');
    console.log('  access:');
    console.log('    dashboard      http://localhost:1603');
    console.log('    webhook        POST http://localhost:3001/webhook/helius');
  } else {
    const bad = described.filter((p) => p.status !== 'online');
    console.log(`  ⚠ ${bad.length} not online`);
    for (const p of bad) console.log(`    - ${p.name}: ${p.status}`);
  }

  pm2.disconnect();
}

main().catch((err) => {
  console.error('✗ failed:', err.message || err);
  try { pm2.disconnect(); } catch {}
  process.exit(1);
});