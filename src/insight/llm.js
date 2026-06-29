import { getConfig } from '../config/config.js';
import { log } from '../utils/logger.js';
import { recordSuccess, recordError, incrCounter } from '../utils/health.js';

const DEFAULT_MODEL = 'openrouter/auto';
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_TOKENS = 1024;

function _getApiKey() {
  return process.env.OPENROUTER_API_KEY || process.env.LLM_API_KEY || getConfig().llm?.apiKey || '';
}

function _getBaseUrl() {
  return process.env.OPENROUTER_BASE_URL || process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1';
}

function _getModel() {
  return process.env.LLM_MODEL || getConfig().llm?.model || DEFAULT_MODEL;
}

function _getSite() {
  return process.env.LLM_SITE_NAME || 'laminar-scout';
}

export function isLlmEnabled() {
  return !!_getApiKey();
}

async function _postChat(messages, opts = {}) {
  const apiKey = _getApiKey();
  if (!apiKey) {
    log('warn', 'llm: API key missing, set OPENROUTER_API_KEY or LLM_API_KEY');
    return null;
  }
  const url = `${_getBaseUrl().replace(/\/$/, '')}/chat/completions`;
  const body = {
    model: opts.model || _getModel(),
    messages,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: opts.temperature ?? 0.4,
    stream: false,
  };
  const controller = new AbortController();
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': `https://${_getSite()}`,
        'X-Title': _getSite(),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const txt = await res.text();
      log('warn', 'llm: API error', { status: res.status, body: txt.slice(0, 200) });
      recordError('llm.api', new Error(`http_${res.status}`), { model: body.model });
      return null;
    }
    const json = await res.json();
    recordSuccess('llm.api', { model: body.model });
    incrCounter('llm.api.ok');
    return json;
  } catch (err) {
    recordError('llm.api', err);
    log('warn', 'llm: fetch failed', { error: err.message });
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function chatCompletion({ system, user, model, maxTokens, temperature }) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });
  const json = await _postChat(messages, { model, maxTokens, temperature });
  if (!json) return null;
  const content = json?.choices?.[0]?.message?.content;
  if (!content) return null;
  return {
    content: String(content).trim(),
    model: json.model || model || _getModel(),
    usage: json.usage || null,
  };
}

export const _internal = { _postChat, _getApiKey, _getBaseUrl, _getModel };