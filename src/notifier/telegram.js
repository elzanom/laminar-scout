import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../config/config.js';
import { getDb } from '../db/index.js';
import { log, logAction } from '../utils/logger.js';

let _polling = false;
let _offset = 0;
let _chatId = null;
let _onCommandHandler = null;

function _nowSec() {
  return Math.floor(Date.now() / 1000);
}

function _escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function _shortAddr(a) {
  if (!a) return '—';
  return `${String(a).slice(0, 4)}…${String(a).slice(-4)}`;
}

function _getToken() {
  const cfg = getConfig();
  return cfg.telegram?.botToken || process.env.TELEGRAM_BOT_TOKEN || '';
}

function _getChatId() {
  if (_chatId) return _chatId;
  const cfg = getConfig();
  return cfg.telegram?.chatId || process.env.TELEGRAM_CHAT_ID || '';
}

function _getAllowedUsers() {
  const cfg = getConfig();
  const raw = cfg.telegram?.allowedUserIds || process.env.TELEGRAM_ALLOWED_USER_IDS || '';
  return new Set(String(raw).split(',').map((s) => s.trim()).filter(Boolean));
}

function _isEnabled() {
  return !!_getToken();
}

async function _postTelegram(method, body) {
  const token = _getToken();
  if (!token) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 401) {
        log('warn', 'telegram: 401 unauthorized — check TELEGRAM_BOT_TOKEN', { method });
      } else {
        log('warn', 'telegram: API error', { method, status: res.status, body: text.slice(0, 200) });
      }
      return null;
    }
    return await res.json();
  } catch (err) {
    log('warn', 'telegram: fetch failed', { method, error: err.message });
    return null;
  }
}

export function isEnabled() {
  return _isEnabled();
}

export function getChatId() {
  return _getChatId() || null;
}

export function setChatId(id) {
  _chatId = String(id).trim();
  const cfg = getConfig();
  if (cfg.telegram?.persistChatId !== false) {
    try {
      const cfgPath = path.resolve(process.cwd(), 'config/scout-config.json');
      if (fs.existsSync(cfgPath)) {
        const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        raw.telegramChatId = _chatId;
        fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2));
      }
    } catch (e) {
      log('warn', 'telegram: persistChatId failed', { error: e.message });
    }
  }
}

export async function sendMessage(text, { parseMode = 'HTML', silent = false } = {}) {
  const chatId = _getChatId();
  const token = _getToken();
  if (!token || !chatId) return null;
  return _postTelegram('sendMessage', {
    chat_id: chatId,
    text: String(text).slice(0, 4096),
    parse_mode: parseMode,
    disable_notification: silent,
  });
}

export async function notifySignal(signalRow) {
  if (!_isEnabled()) return;
  const chatId = _getChatId();
  if (!chatId) {
    log('warn', 'telegram: notifySignal skipped — chatId not configured');
    return;
  }
  const conf = Number(signalRow.combined_confidence || signalRow.confidence || 0);
  const confPct = (conf * 100).toFixed(0);
  const trig = signalRow.triggered_by || signalRow.trigger?.wallet || '—';
  const pair = signalRow.token_pair || '—';
  const pool = signalRow.pool_address || signalRow.pool || '—';
  const walletScore = signalRow.wallet_score ?? signalRow.trigger?.wallet_score ?? '—';

  const msg =
    `🚨 <b>Signal</b> · ${confPct}% confidence\n` +
    `\n` +
    `Pair: <code>${_escHtml(pair)}</code>\n` +
    `Pool: <code>${_escHtml(pool.slice(0, 12))}…</code>\n` +
    `Trigger wallet: <code>${_escHtml(_shortAddr(trig))}</code> (score ${_escHtml(String(walletScore))})\n` +
    `\n` +
    `<i>Laminar-scout · ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC</i>`;

  return sendMessage(msg);
}

export async function notifyWalletPromoted(walletAddress, tier, score) {
  if (!_isEnabled()) return;
  const chatId = _getChatId();
  if (!chatId) return;
  const tierUpper = String(tier).toUpperCase();
  const emoji = tierUpper === 'TOP' ? '⭐' : tierUpper === 'TRACKED' ? '👀' : '❌';
  const msg =
    `${emoji} Wallet ${tierUpper}\n` +
    `<code>${_escHtml(_shortAddr(walletAddress))}</code>\n` +
    `Score: <b>${Number(score).toFixed(1)}</b>`;
  return sendMessage(msg);
}

export async function notifyError(subystem, message) {
  if (!_isEnabled()) return;
  const chatId = _getChatId();
  if (!chatId) return;
  return sendMessage(
    `⚠️ <b>${_escHtml(subystem)}</b>\n<code>${_escHtml(String(message).slice(0, 200))}</code>`
  );
}

function _isAuthorized(msg) {
  const expectedChatId = String(_getChatId() || '');
  const incomingChatId = String(msg.chat?.id || '');
  if (!expectedChatId) return false;
  if (incomingChatId !== expectedChatId) return false;

  const allowedUsers = _getAllowedUsers();
  const chatType = msg.chat?.type || 'private';
  if (allowedUsers.size > 0) {
    const senderId = msg.from?.id != null ? String(msg.from.id) : null;
    if (!senderId || !allowedUsers.has(senderId)) return false;
  } else if (chatType !== 'private') {
    return false;
  }
  return true;
}

function _handleStatus() {
  try {
    const db = getDb();
    const wallets = db.prepare('SELECT status, COUNT(*) AS n FROM wallets GROUP BY status').all();
    const positions = db.prepare('SELECT status, COUNT(*) AS n FROM positions GROUP BY status').all();
    const signals = db.prepare('SELECT COUNT(*) AS n FROM signals').get();
    const training = db.prepare('SELECT COUNT(*) AS n, SUM(CASE WHEN exported_at IS NOT NULL THEN 1 ELSE 0 END) AS exported FROM training_records').get();

    const walletLine = wallets.map((w) => `  ${w.status}: <b>${w.n}</b>`).join('\n') || '  —';
    const positionLine = positions.map((p) => `  ${p.status}: <b>${p.n}</b>`).join('\n') || '  —';

    const msg =
      `📊 <b>Scout Status</b>\n` +
      `\n` +
      `<b>Wallets:</b>\n${walletLine}\n` +
      `\n` +
      `<b>Positions:</b>\n${positionLine}\n` +
      `\n` +
      `<b>Signals:</b> ${signals.n}\n` +
      `<b>Training records:</b> ${training.n} (exported: ${training.exported || 0})\n` +
      `\n` +
      `<i>${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC</i>`;
    return sendMessage(msg);
  } catch (err) {
    return sendMessage(`⚠️ status query failed: ${_escHtml(err.message)}`);
  }
}

function _handleTop(limit = 5) {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT address, score, win_rate, total_pnl_usd, total_positions, status
      FROM wallets
      WHERE status IN ('top', 'tracked') AND score IS NOT NULL AND score > 0
      ORDER BY score DESC
      LIMIT ?
    `).all(Math.min(Number(limit) || 5, 20));

    if (!rows.length) {
      return sendMessage('No top wallets yet — scout masih gathering data.');
    }

    const lines = rows.map((w, i) => {
      const pnl = Number(w.total_pnl_usd || 0).toFixed(2);
      const wr = ((Number(w.win_rate || 0) * 100)).toFixed(1);
      const score = Number(w.score || 0).toFixed(1);
      return `${i + 1}. <code>${_shortAddr(w.address)}</code> · score ${score} · WR ${wr}% · PnL $${pnl} · ${w.total_positions} pos`;
    }).join('\n');

    return sendMessage(`⭐ <b>Top ${rows.length} Wallets</b>\n\n${lines}`);
  } catch (err) {
    return sendMessage(`⚠️ top query failed: ${_escHtml(err.message)}`);
  }
}

function _handleSignals(limit = 5) {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT id, pool_address, token_pair, combined_confidence, triggered_by, status, created_at
      FROM signals
      ORDER BY created_at DESC
      LIMIT ?
    `).all(Math.min(Number(limit) || 5, 20));

    if (!rows.length) {
      return sendMessage('Belum ada signal.');
    }

    const lines = rows.map((s) => {
      const conf = (Number(s.combined_confidence || 0) * 100).toFixed(0);
      const ago = Math.floor((_nowSec() - Number(s.created_at)) / 60);
      const agoStr = ago < 1 ? 'now' : `${ago}m ago`;
      return `· <code>${_shortAddr(s.pool_address)}</code> · ${confPct(conf)}% · ${agoStr} · ${s.status}`;
    }).join('\n');

    function confPct(p) { return p; }

    return sendMessage(`📡 <b>Recent Signals</b>\n\n${lines}`);
  } catch (err) {
    return sendMessage(`⚠️ signals query failed: ${_escHtml(err.message)}`);
  }
}

function _handleHelp() {
  const msg =
    `🤖 <b>laminar-scout commands</b>\n` +
    `\n` +
    `/status — wallet/positions/signals/training count\n` +
    `/top [N] — top N wallets (default 5)\n` +
    `/signals [N] — recent N signals (default 5)\n` +
    `/ask <wallet> — LLM-powered insight for a wallet\n` +
    `/help — show this message\n` +
    `\n` +
    `<i>Bot aktif saat TELEGRAM_BOT_TOKEN + chat ID di-set.\n` +
    `LLM insight butuh OPENROUTER_API_KEY di .env.</i>`;
  return sendMessage(msg);
}

async function _handleAsk(args) {
  const trimmed = String(args || '').trim();
  if (!trimmed) {
    return sendMessage('Usage: /ask <wallet_address>');
  }
  const addr = trimmed.split(/\s+/)[0];
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) {
    return sendMessage('Invalid Solana address.');
  }
  const { getWalletInsight, isLlmEnabled } = await import('../insight/index.js');
  const waiting = await sendMessage(`🧠 Generating insight for ${addr.slice(0, 6)}…${addr.slice(-4)}…`);
  const result = await getWalletInsight(addr);
  if (!result.ok) {
    return sendMessage(`⚠️ insight failed: ${result.error}`);
  }
  const text = result.content.length > 3800
    ? result.content.slice(0, 3800) + '\n\n[…truncated, full insight via dashboard /api/insight/wallet]'
    : result.content;
  const tag = result.fallback ? '\n\n<i>(template insight — set OPENROUTER_API_KEY for LLM)</i>'
    : (result.cached ? '\n\n<i>(cached)</i>' : '');
  return sendMessage(`🧠 <b>Insight · ${addr.slice(0, 6)}…${addr.slice(-4)}</b>${tag}\n\n${text}`);
}

async function _handleMessage(msg) {
  if (!_isAuthorized(msg)) return;
  const text = String(msg.text || '').trim();
  if (!text.startsWith('/')) return;

  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase().split('@')[0];
  const arg = parts[1];

  log('info', 'telegram: command received', { cmd, from: msg.from?.id });

  switch (cmd) {
    case '/start':
    case '/help':
      await _handleHelp();
      break;
    case '/status':
      await _handleStatus();
      break;
    case '/top':
      await _handleTop(arg || 5);
      break;
    case '/signals':
      await _handleSignals(arg || 5);
      break;
    case '/ask':
      await _handleAsk(parts.slice(1).join(' '));
      break;
    default:
      await sendMessage(`Unknown command: ${cmd}\nKetik /help untuk daftar command.`);
  }

  if (_onCommandHandler) {
    try {
      await _onCommandHandler({ cmd, arg, msg });
    } catch (e) {
      log('warn', 'telegram: onCommandHandler failed', { error: e.message });
    }
  }
}

async function _pollLoop() {
  const token = _getToken();
  while (_polling) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${token}/getUpdates?offset=${_offset}&timeout=30&allowed_updates=%5B%22message%22%2C%22callback_query%22%5D`,
        { signal: AbortSignal.timeout(35_000) }
      );
      if (!res.ok) {
        await _sleep(5000);
        continue;
      }
      const data = await res.json();
      for (const update of data.result || []) {
        _offset = update.update_id + 1;
        const msg = update.message;
        if (msg && msg.text) {
          await _handleMessage(msg);
        }
      }
    } catch (e) {
      if (!String(e.message || '').includes('aborted')) {
        log('warn', 'telegram: poll error', { error: e.message });
      }
      await _sleep(5000);
    }
  }
}

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function registerBotCommands() {
  const token = _getToken();
  if (!token) return;
  try {
    await _postTelegram('setMyCommands', {
      commands: [
        { command: 'help', description: 'Show available commands' },
        { command: 'status', description: 'Wallet/positions/signals/training count' },
        { command: 'top', description: 'Top 5 wallets by score' },
        { command: 'signals', description: 'Recent 5 signals' },
      ],
    });
    log('info', 'telegram: bot commands registered');
  } catch (e) {
    log('warn', 'telegram: registerBotCommands failed', { error: e.message });
  }
}

export function startPolling({ onCommand } = {}) {
  if (!_isEnabled()) {
    log('info', 'telegram: disabled (TELEGRAM_BOT_TOKEN not set)');
    return false;
  }
  if (!_getChatId()) {
    log('info', 'telegram: bot started, waiting for /start from authorized user to register chatId');
  }
  _onCommandHandler = onCommand || null;
  _polling = true;
  _pollLoop();
  registerBotCommands();
  log('info', 'telegram: polling started', { chatId: _getChatId() || '(unset)' });
  logAction('telegram.start', { chatId: _getChatId() || null });
  return true;
}

export function stopPolling() {
  _polling = false;
  log('info', 'telegram: polling stopped');
}

export const _test = {
  _escHtml,
  _shortAddr,
  _isAuthorized,
  _handleMessage,
};
