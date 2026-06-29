import { getDb } from '../db/index.js';
import { chatCompletion, isLlmEnabled } from './llm.js';
import { walletSummaryForPrompt } from './wallet-summary.js';
import { log, logAction } from '../utils/logger.js';
import { recordSuccess, recordError, incrCounter } from '../utils/health.js';

export { isLlmEnabled } from './llm.js';

const CACHE_TTL_SEC = 6 * 3600;

function _nowSec() { return Math.floor(Date.now() / 1000); }

function _getCache(address) {
  try {
    const row = getDb().prepare(
      `SELECT content, model, generated_at FROM insight_cache WHERE address = ?`
    ).get(address);
    if (!row) return null;
    if (_nowSec() - Number(row.generated_at || 0) > CACHE_TTL_SEC) return null;
    return { content: row.content, model: row.model, generated_at: row.generated_at };
  } catch (err) {
    return null;
  }
}

function _setCache(address, content, model) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO insight_cache (address, content, model, generated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(address) DO UPDATE SET
        content = excluded.content,
        model = excluded.model,
        generated_at = excluded.generated_at
    `).run(address, content, model, _nowSec());
  } catch (err) {
    log('warn', 'insight: cache write failed', { address, error: err.message });
  }
}

const SYSTEM_PROMPT = `You are an analyst for laminar-scout, a Solana DLMM (Meteora) liquidity-provider tracker.
You read raw wallet statistics from a SQLite database and produce short, evidence-based insights.
Rules:
- Cite specific numbers from the data (PnL, fees, IL, win rate).
- Distinguish real PnL from PnL after impermanent loss (IL).
- Identify the wallet's apparent strategy (active LP, sniper, passive LPer, etc.) based on position count, average hold time, and pool concentration.
- Flag any risk: concentrated positions, negative realized PnL after IL, low fee yield, single-pool dependency.
- Be concise: 4-8 short paragraphs or bullet points.
- Do not make up facts not present in the data.
- Write in clear, plain English.`;

function _userPrompt(summaryText, question) {
  if (question) {
    return `Wallet data:\n${summaryText}\n\nQuestion: ${question}\n\nProvide a focused answer.`;
  }
  return `Wallet data:\n${summaryText}\n\nGive a concise insight summary covering: strategy, performance, IL impact, and risks.`;
}

export async function getWalletInsight(address, { question, forceRefresh = false } = {}) {
  if (!address || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    return { ok: false, error: 'invalid_address' };
  }

  const summaryText = walletSummaryForPrompt(address);
  if (!summaryText) {
    return { ok: false, error: 'wallet_not_found' };
  }

  if (!forceRefresh) {
    const cached = _getCache(address);
    if (cached) {
      log('info', 'insight: cache hit', { address });
      return { ok: true, address, content: cached.content, model: cached.model, cached: true, generated_at: cached.generated_at };
    }
  }

  if (!isLlmEnabled()) {
    return {
      ok: true,
      address,
      content: _fallbackInsight(address, summaryText),
      model: 'fallback',
      cached: false,
      fallback: true,
      notice: 'LLM not configured (set OPENROUTER_API_KEY). Returning template summary.',
    };
  }

  try {
    const result = await chatCompletion({
      system: SYSTEM_PROMPT,
      user: _userPrompt(summaryText, question),
      maxTokens: 800,
      temperature: 0.4,
    });
    if (!result) {
      return {
        ok: true,
        address,
        content: _fallbackInsight(address, summaryText),
        model: 'fallback',
        fallback: true,
        notice: 'LLM call failed. Returning template summary.',
      };
    }
    _setCache(address, result.content, result.model);
    logAction('insight.generated', { address, model: result.model });
    recordSuccess('insight', { address, model: result.model });
    incrCounter('insight.generated');
    return {
      ok: true,
      address,
      content: result.content,
      model: result.model,
      cached: false,
      generated_at: _nowSec(),
    };
  } catch (err) {
    recordError('insight', err, { address });
    return { ok: false, address, error: err.message };
  }
}

function _fallbackInsight(address, summaryText) {
  return [
    `Template insight for wallet ${address.slice(0, 6)}...${address.slice(-4)}:`,
    '',
    summaryText,
    '',
    '(LLM not configured — set OPENROUTER_API_KEY in .env for natural-language analysis.)',
  ].join('\n');
}

export function clearInsightCache(address) {
  try {
    if (address) {
      getDb().prepare('DELETE FROM insight_cache WHERE address = ?').run(address);
    } else {
      getDb().prepare('DELETE FROM insight_cache').run();
    }
  } catch (err) {
    log('warn', 'insight: cache clear failed', { error: err.message });
  }
}