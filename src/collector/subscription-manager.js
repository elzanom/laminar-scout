import { fetchJson } from '../utils/retry.js';
import { getConfig } from '../config/config.js';
import { log, logAction } from '../utils/logger.js';
import { recordSuccess, recordError, incrCounter } from '../utils/health.js';
import { listWallets } from '../db/wallets.js';

const HELIUS_API = 'https://api.helius.xyz/v0/webhooks';

function apiKey() {
  const cfg = getConfig();
  if (!cfg.helius.apiKey) throw new Error('helius api key required');
  return cfg.helius.apiKey;
}

function withKey(url) {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}api-key=${apiKey()}`;
}

export async function listHeliusWebhooks() {
  const data = await fetchJson(withKey(HELIUS_API), {}, {}, 'helius-webhooks:list');
  return Array.isArray(data) ? data : [];
}

export async function findScoutWebhook() {
  const cfg = getConfig();
  const all = await listHeliusWebhooks();
  const expectedUrl = cfg.helius.webhookExpectedUrl || process.env.SCOUT_WEBHOOK_URL || null;
  return all.find((w) => w.webhookURL === expectedUrl) || all[0] || null;
}

export async function createWebhook(webhookUrl, accountAddresses = [], webhookType = 'enhanced') {
  if (!webhookUrl) throw new Error('webhookUrl required');
  const cfg = getConfig();
  const body = {
    webhookURL: webhookUrl,
    transactionTypes: ['ANY'],
    accountAddresses,
    webhookType,
    authHeader: cfg.helius.webhookSecret || undefined,
  };
  const created = await fetchJson(withKey(HELIUS_API), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, {}, 'helius-webhooks:create');
  recordSuccess('subscription-manager.create', { webhookID: created?.webhookID, addressCount: accountAddresses.length });
  logAction('subscription-manager.create', { webhookID: created?.webhookID, addressCount: accountAddresses.length });
  return created;
}

export async function addAddresses(webhookId, addresses) {
  if (!webhookId) throw new Error('webhookId required');
  if (!addresses || !addresses.length) return { skipped: true };
  const cleaned = [...new Set(addresses.filter(Boolean))];
  const r = await fetchJson(withKey(`${HELIUS_API}/${webhookId}/addresses`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cleaned),
  }, {}, 'helius-webhooks:add-addresses');
  incrCounter('subscription_manager.added', cleaned.length);
  recordSuccess('subscription-manager.add', { webhookId, added: cleaned.length });
  return r;
}

export async function removeAddresses(webhookId, addresses) {
  if (!webhookId) throw new Error('webhookId required');
  if (!addresses || !addresses.length) return { skipped: true };
  const cleaned = [...new Set(addresses.filter(Boolean))];
  const r = await fetchJson(withKey(`${HELIUS_API}/${webhookId}/addresses`), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cleaned),
  }, {}, 'helius-webhooks:remove-addresses');
  incrCounter('subscription_manager.removed', cleaned.length);
  recordSuccess('subscription-manager.remove', { webhookId, removed: cleaned.length });
  return r;
}

export async function getWebhookAddresses(webhookId) {
  if (!webhookId) throw new Error('webhookId required');
  const r = await fetchJson(withKey(`${HELIUS_API}/${webhookId}`), {}, {}, 'helius-webhooks:get');
  const list = r?.accountAddresses || [];
  return Array.isArray(list) ? list : [];
}

export async function reconcileSubscriptions(opts = {}) {
  const cfg = getConfig();
  const webhookId = opts.webhookId || cfg.helius.webhookId || process.env.HELIUS_WEBHOOK_ID || null;
  if (!webhookId) {
    log('warn', 'subscription-manager: no webhookId configured, skipping reconcile');
    return { skipped: true, reason: 'no-webhook-id' };
  }

  const subscribed = new Set(await getWebhookAddresses(webhookId));

  const tracked = listWallets({ is_tracked: true }, { limit: 5000 });
  const top = listWallets({ is_top_wallet: true }, { limit: 5000 });
  const desired = new Set();
  for (const w of [...tracked, ...top]) desired.add(w.address);

  const toAdd = [...desired].filter((a) => !subscribed.has(a));
  const toRemove = [...subscribed].filter((a) => !desired.has(a));

  if (toAdd.length) {
    try {
      await addAddresses(webhookId, toAdd);
      log('info', `subscription-manager: added ${toAdd.length} wallets`);
    } catch (err) {
      recordError('subscription-manager.add', err, { count: toAdd.length });
      log('error', `subscription-manager: add failed`, { error: err.message });
    }
  }
  if (toRemove.length) {
    try {
      await removeAddresses(webhookId, toRemove);
      log('info', `subscription-manager: removed ${toRemove.length} wallets`);
    } catch (err) {
      recordError('subscription-manager.remove', err, { count: toRemove.length });
      log('error', `subscription-manager: remove failed`, { error: err.message });
    }
  }

  logAction('subscription-manager.reconcile', {
    webhookId,
    subscribed: subscribed.size,
    desired: desired.size,
    added: toAdd.length,
    removed: toRemove.length,
  });

  return {
    webhookId,
    subscribed: subscribed.size,
    desired: desired.size,
    added: toAdd.length,
    removed: toRemove.length,
  };
}

export async function ensureWebhook(opts = {}) {
  const cfg = getConfig();
  if (!cfg.helius.webhookEnabled) return { skipped: true, reason: 'webhook-disabled' };
  const webhookUrl = opts.webhookUrl || process.env.SCOUT_WEBHOOK_URL || null;
  if (!webhookUrl) {
    log('warn', 'subscription-manager: SCOUT_WEBHOOK_URL not set, cannot ensure webhook');
    return { skipped: true, reason: 'no-url' };
  }
  let hook = await findScoutWebhook();
  if (!hook) {
    hook = await createWebhook(webhookUrl, [], 'enhanced');
    log('info', `subscription-manager: created webhook ${hook?.webhookID}`);
  }
  if (hook?.webhookID) {
    await reconcileSubscriptions({ webhookId: hook.webhookID });
  }
  return hook;
}