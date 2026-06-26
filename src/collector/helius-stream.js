import http from 'node:http';
import { URL } from 'node:url';
import { getConfig } from '../config/config.js';
import { log, logAction } from '../utils/logger.js';
import { recordSuccess, recordError, incrCounter, getStalledSubsystems } from '../utils/health.js';
import { parseTransaction } from './tx-parser.js';
import { emitTxEvent, TX_EVENT_TYPES } from './event-bus.js';
import { markProcessed } from '../db/processed-txs.js';
import { syncWallet } from './helius-history.js';
import { listWallets } from '../db/wallets.js';

const POLL_TAG = 'helius_stream.poll';

function constantTimeEqual(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function verifySecret(req) {
  const cfg = getConfig();
  if (!cfg.helius.webhookSecret) return false;
  const auth = req.headers['authorization'] || req.headers['x-webhook-secret'] || '';
  const provided = Array.isArray(auth) ? auth[0] : auth;
  const bearer = typeof provided === 'string' && provided.toLowerCase().startsWith('bearer ')
    ? provided.slice(7).trim()
    : provided;
  return constantTimeEqual(bearer, cfg.helius.webhookSecret);
}

function readJsonBody(req, maxBytes = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : []);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function dispatchEvents(events, source) {
  let open = 0, close = 0, fee = 0, other = 0;
  for (const ev of events) {
    if (!ev) continue;
    emitTxEvent(TX_EVENT_TYPES.ANY_DLMM, ev);
    if (ev.eventType === 'add_liquidity') {
      open += 1;
      emitTxEvent(TX_EVENT_TYPES.POSITION_OPEN, ev);
    } else if (ev.eventType === 'remove_liquidity') {
      close += 1;
      emitTxEvent(TX_EVENT_TYPES.POSITION_CLOSE, ev);
    } else if (ev.eventType === 'claim_fee' || ev.eventType === 'claim_reward') {
      fee += 1;
      emitTxEvent(TX_EVENT_TYPES.FEE_CLAIM, ev);
    } else {
      other += 1;
    }
    incrCounter(`tx.${ev.eventType}`);
    if (ev.signature) markProcessed(ev.signature, source);
  }
  return { open, close, fee, other, total: events.length };
}

async function handleWebhook(req, res) {
  const cfg = getConfig();
  if (!verifySecret(req)) {
    recordError('helius-webhook', new Error('webhook auth failed'), { ip: req.socket.remoteAddress });
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    recordError('helius-webhook', err);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: err.message }));
    return;
  }

  const txs = Array.isArray(body) ? body : (Array.isArray(body?.transactions) ? body.transactions : []);
  const allEvents = [];
  for (const tx of txs) {
    const events = parseTransaction(tx, { source: 'webhook' });
    allEvents.push(...events);
  }
  const tally = dispatchEvents(allEvents, 'webhook');
  incrCounter('helius_webhook.tx_received', txs.length);
  incrCounter('helius_webhook.events', allEvents.length);
  recordSuccess('helius-webhook', { txReceived: txs.length, events: allEvents.length });
  logAction('helius-webhook', { txReceived: txs.length, events: allEvents.length, tally });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, ...tally }));
}

function handleHealth(req, res) {
  const stalled = getStalledSubsystems();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, stalled_subsystems: stalled, ts: Math.floor(Date.now() / 1000) }));
}

function makeRequestHandler() {
  return async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/health')) {
        return handleHealth(req, res);
      }
      if (req.method === 'POST' && (url.pathname === '/webhook/helius' || url.pathname === '/helius-webhook')) {
        return handleWebhook(req, res);
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not found' }));
    } catch (err) {
      recordError('helius-webhook', err);
      log('error', 'helius-webhook: handler error', { error: err.message, stack: err.stack });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ ok: false, error: 'internal' }));
    }
  };
}

export function startWebhookServer(port) {
  const cfg = getConfig();
  const finalPort = port || cfg.webhook.port || 3001;
  const server = http.createServer(makeRequestHandler());
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(finalPort, () => {
      log('info', `helius-webhook: listening on :${finalPort}`, {
        webhookEnabled: cfg.helius.webhookEnabled,
        pollingFallback: cfg.helius.pollingFallbackEnabled,
      });
      recordSuccess('helius-webhook', { port: finalPort, listening: true });
      resolve(server);
    });
  });
}

export function stopWebhookServer(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
}

let pollTimer = null;

export async function pollOnce() {
  const cfg = getConfig();
  if (!cfg.helius.pollingFallbackEnabled) return { skipped: true };
  const wallets = listWallets({ is_tracked: true }, { limit: 500 })
    .concat(listWallets({ is_top_wallet: true }, { limit: 500 }));
  const seen = new Set();
  const deduped = [];
  for (const w of wallets) { if (!seen.has(w.address)) { seen.add(w.address); deduped.push(w.address); } }
  if (!deduped.length) return { skipped: true, reason: 'no tracked wallets' };

  let totalEvents = 0;
  let totalTx = 0;
  for (const addr of deduped) {
    try {
      const r = await syncWallet(addr, { limit: 50 });
      totalTx += r.txFetched || 0;
      totalEvents += r.events || 0;
    } catch (err) {
      recordError(POLL_TAG, err, { wallet: addr });
    }
  }
  incrCounter('helius_poll.tx', totalTx);
  incrCounter('helius_poll.events', totalEvents);
  recordSuccess(POLL_TAG, { wallets: deduped.length, tx: totalTx, events: totalEvents });
  return { wallets: deduped.length, tx: totalTx, events: totalEvents };
}

export function startPollingLoop() {
  const cfg = getConfig();
  if (!cfg.helius.pollingFallbackEnabled) return null;
  const intervalMs = Math.max(5_000, (cfg.helius.pollingIntervalSeconds || 30) * 1000);
  const tick = async () => {
    try {
      await pollOnce();
    } catch (err) {
      recordError(POLL_TAG, err);
      log('error', 'helius-poll: tick failed', { error: err.message });
    }
  };
  pollTimer = setInterval(tick, intervalMs);
  if (typeof pollTimer.unref === 'function') pollTimer.unref();
  log('info', `helius-poll: started, interval=${intervalMs}ms`);
  return pollTimer;
}

export function stopPollingLoop() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

export { dispatchEvents, verifySecret, handleWebhook, handleHealth };