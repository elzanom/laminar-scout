(function () {
  'use strict';

  const POLL_INTERVAL_MS = 5000;
  const NUM_FMT = new Intl.NumberFormat('en-US');
  const USD_FMT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
  const TIME_FMT = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const $ = (id) => document.getElementById(id);

  function setText(id, val) {
    const el = $(id);
    if (el) el.textContent = val;
  }

  function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  function fmtAgo(unixSec) {
    if (!unixSec) return '--';
    const delta = Math.floor(Date.now() / 1000) - Number(unixSec);
    if (delta < 60) return `${delta}s ago`;
    if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
    if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
    return `${Math.floor(delta / 86400)}d ago`;
  }

  function fmtTime(unixSec) {
    if (!unixSec) return '--';
    return `${TIME_FMT.format(new Date(Number(unixSec) * 1000))}`;
  }

  function wrClass(wr) {
    if (wr >= 70) return 'wr-good';
    if (wr >= 55) return 'wr-mid';
    return 'wr-bad';
  }

  function pnlClass(v) { return v >= 0 ? 'pnl-pos' : 'pnl-neg'; }

  function scoreClass(score) {
    if (score >= 70) return 'score-high';
    if (score >= 40) return 'score-mid';
    return 'score-low';
  }

  function binClass(w) {
    if (w >= 100) return 'bin-high';
    if (w >= 30) return 'bin-mid';
    return 'bin-low';
  }

  async function fetchJson(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  }

  function strategyPillsHtml(tags) {
    if (!tags || !tags.length) return '<span class="muted">—</span>';
    return '<div class="tag-row">' + tags.map((t) => `<span class="tag ${escHtml(t.cls)}">${escHtml(t.text)}</span>`).join('') + '</div>';
  }

  let pollCount = 0;
  let scanNum = 1;

  async function refresh() {
    pollCount += 1;
    const status = $('filter-status').value;
    const order = $('order-by').value;

    const [overview, wallets, signals, positions, sources, health] = await Promise.all([
      fetchJson('/api/overview').catch(() => ({ data: null })),
      fetchJson(`/api/wallets/top?limit=20&status=${encodeURIComponent(status)}&order=${order}`).catch(() => ({ data: [] })),
      fetchJson('/api/signals/recent?limit=8').catch(() => ({ data: [] })),
      fetchJson('/api/positions/recent?status=closed&limit=8').catch(() => ({ data: [] })),
      fetchJson('/api/discovery-sources').catch(() => ({ data: { rows: [], total: 0 } })),
      fetchJson('/api/health').catch(() => ({ data: { subsystems: {}, stalled: [], counters: {} } })),
    ]);

    renderOverview(overview.data);
    renderWallets(wallets.data || []);
    renderSignals(signals.data || []);
    renderPositions(positions.data || []);
    renderSources(sources.data || { rows: [], total: 0 });
    renderHealth(health.data || { subsystems: {}, stalled: [] });

    setText('last-poll', TIME_FMT.format(new Date()));
    scanNum += 1;
    setText('meta-latest-scan', `#${scanNum}`);
    setText('meta-status', 'LIVE');
  }

  function renderOverview(d) {
    if (!d) return;
    setText('c-wallets-total', NUM_FMT.format(d.wallets.total));
    setText('c-wallets-top', NUM_FMT.format(d.wallets.top));
    setText('c-wallets-tracked', NUM_FMT.format(d.wallets.tracked));
    setText('c-wallets-candidate', NUM_FMT.format(d.wallets.candidate));
    setText('c-wallets-rejected', NUM_FMT.format(d.wallets.rejected));
    setText('c-signals-total', NUM_FMT.format(d.signals.total));
    setText('c-positions-total', NUM_FMT.format(d.positions.total));
    setText('c-training-total', NUM_FMT.format(d.training_records.total));

    setText('meta-pools', NUM_FMT.format(d.snapshots || 0));
    setText('meta-wallets', NUM_FMT.format(d.wallets.total));
  }

  function renderWallets(rows) {
    const tbody = document.querySelector('#table-wallets tbody');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="12" class="muted center">no wallets match current filter</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((w, i) => `
      <tr>
        <td class="num-col">${(i + 1).toString().padStart(2, '0')}</td>
        <td class="wallet-col">
          <span class="wallet-cell" data-address="${escHtml(w.address)}" title="${escHtml(w.address)}">
            <span class="mono">${escHtml(w.short)}</span>
            <button class="copy-btn" title="copy address">⧉</button>
          </span>
        </td>
        <td class="num ${scoreClass(w.score)}" style="font-weight:700">${w.score.toFixed(1)}</td>
        <td class="num ${wrClass(w.win_rate)}">${w.win_rate.toFixed(1)}%</td>
        <td class="num ${pnlClass(w.total_pnl_usd)}">${USD_FMT.format(w.total_pnl_usd)}</td>
        <td class="num fee-pos">${USD_FMT.format(w.total_fees_usd)}</td>
        <td class="num">${w.avg_fee_yield.toFixed(2)}%</td>
        <td class="num">${NUM_FMT.format(w.unique_pools_traded)}</td>
        <td class="num">
          <span class="win-count">${w.win_count}</span>/<span class="loss-count">${w.loss_count}</span>
        </td>
        <td class="num">${w.open_positions > 0 ? `<span class="wr-good">${w.open_positions}</span>` : w.open_positions}</td>
        <td class="num ${binClass(w.avg_bin_range)}">${w.avg_bin_range || '—'}</td>
        <td class="strategy-col">${strategyPillsHtml(w.strategy_tags)}</td>
      </tr>
    `).join('');

    tbody.querySelectorAll('.copy-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const span = e.target.parentElement;
        const addr = span.dataset.address;
        if (navigator.clipboard) {
          navigator.clipboard.writeText(addr).then(() => {
            btn.textContent = '✓';
            setTimeout(() => { btn.textContent = '⧉'; }, 1000);
          });
        }
      });
    });
  }

  function renderSignals(rows) {
    const tbody = document.querySelector('#table-signals tbody');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="muted center">no signals yet — waiting for top wallet to enter a screened pool</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((s) => {
      const conf = Number(s.combined_confidence || 0);
      const trig = s.triggered_by || '';
      const trigShort = trig.length > 12 ? trig.slice(0, 6) + '…' + trig.slice(-4) : trig;
      const pillCls = s.status === 'sent' ? 'pill-sent' : s.status === 'expired' ? 'pill-expired' : 'pill-pending';
      return `
        <tr>
          <td>${escHtml(fmtAgo(s.created_at))}</td>
          <td>${escHtml(s.token_pair || '—')}</td>
          <td class="mono" title="${escHtml(trig)}">${escHtml(trigShort)}</td>
          <td class="num"><strong>${(conf * 100).toFixed(0)}%</strong></td>
          <td><span class="pill ${pillCls}">${escHtml(s.status)}</span></td>
        </tr>
      `;
    }).join('');
  }

  function renderPositions(rows) {
    const tbody = document.querySelector('#table-positions tbody');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="muted center">no closed positions yet</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((p) => {
      const wShort = p.wallet_address.slice(0, 4) + '…' + p.wallet_address.slice(-4);
      const resultCls = p.is_profitable ? 'pill-profit' : 'pill-loss';
      const resultTxt = p.is_profitable ? 'profit' : 'loss';
      return `
        <tr>
          <td class="mono" title="${escHtml(p.wallet_address)}">${escHtml(wShort)}</td>
          <td>${escHtml(p.token_pair || '—')}</td>
          <td class="num ${pnlClass(p.pnl_usd)}">${USD_FMT.format(p.pnl_usd)}</td>
          <td class="num fee-pos">${USD_FMT.format(p.fees_earned_usd)}</td>
          <td class="num">${p.duration_hours.toFixed(1)}h</td>
          <td><span class="pill ${resultCls}">${resultTxt}</span></td>
        </tr>
      `;
    }).join('');
  }

  function renderSources(d) {
    const target = $('chart-sources');
    if (!d.rows || !d.rows.length) {
      target.innerHTML = '<div class="muted center" style="padding:12px">no data</div>';
      return;
    }
    const total = d.total || 1;
    target.innerHTML = d.rows.map((row) => `
      <div class="bar-row">
        <div class="bar-label">${escHtml(row.source)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${(row.n / total * 100).toFixed(1)}%"></div></div>
        <div class="bar-value">${NUM_FMT.format(row.n)}</div>
      </div>
    `).join('');
  }

  function renderHealth(d) {
    const tbody = document.querySelector('#table-health tbody');
    const subs = d.subsystems || {};
    const entries = Object.entries(subs);
    if (!entries.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="muted center">no subsystem data (scout writes these on first cycle)</td></tr>';
      return;
    }
    const stalled = new Set(d.stalled || []);
    tbody.innerHTML = entries.map(([name, info]) => {
      const ls = info.lastSuccess ? fmtAgo(info.lastSuccess) : '—';
      const le = info.lastError ? fmtAgo(info.lastError) : '—';
      const errCount = info.errorCount ?? 0;
      const isStalled = stalled.has(name);
      return `
        <tr>
          <td class="mono">${escHtml(name)}</td>
          <td>${escHtml(ls)}</td>
          <td>${escHtml(le)}</td>
          <td class="num ${errCount > 0 ? 'pnl-neg' : 'muted'}">${errCount}</td>
          <td>${isStalled ? '<span class="pill-stalled">STALLED</span>' : '<span class="pill-ok">OK</span>'}</td>
        </tr>
      `;
    }).join('');
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('filter-status').addEventListener('change', () => refresh());
    document.getElementById('order-by').addEventListener('change', () => refresh());
    refresh();
    setInterval(refresh, POLL_INTERVAL_MS);
  });
})();