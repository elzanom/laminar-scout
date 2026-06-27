(function () {
  'use strict';

  const POLL_INTERVAL_MS = 5000;
  const NUM_FMT = new Intl.NumberFormat('en-US');
  const USD_FMT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2, minimumFractionDigits: 2 });
  const TIME_FMT = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

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
    if (delta < 0) return 'now';
    if (delta < 60) return `${delta}s ago`;
    if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
    if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
    return `${Math.floor(delta / 86400)}d ago`;
  }

  function fmtUptime(sec) {
    sec = Math.floor(Number(sec) || 0);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
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

  async function refresh() {
    const status = $('filter-status').value;
    const order = $('order-by').value;

    const [overview, wallets, signals, positions, sources, health, summary, dist] = await Promise.all([
      fetchJson('/api/overview').catch(() => ({ data: null })),
      fetchJson(`/api/wallets/top?limit=20&status=${encodeURIComponent(status)}&order=${order}`).catch(() => ({ data: [] })),
      fetchJson('/api/signals/recent?limit=8').catch(() => ({ data: [] })),
      fetchJson('/api/positions/recent?status=closed&limit=8').catch(() => ({ data: [] })),
      fetchJson('/api/discovery-sources').catch(() => ({ data: { rows: [], total: 0 } })),
      fetchJson('/api/health').catch(() => ({ data: { subsystems: {}, stalled: [], counters: {} } })),
      fetchJson('/api/dataset-summary').catch(() => ({ data: null })),
      fetchJson('/api/score-distribution').catch(() => ({ data: [] })),
    ]);

    renderOverview(overview.data);
    renderWallets(wallets.data || []);
    renderSignals(signals.data || []);
    renderPositions(positions.data || []);
    renderSources(sources.data || { rows: [], total: 0 });
    renderHealth(health.data || { subsystems: {}, stalled: [] });
    renderCoverage(summary.data);
    renderScoreDist(dist.data || []);

    setText('last-poll', TIME_FMT.format(new Date()));
    if (overview.data?.uptime_s != null) setText('meta-uptime', fmtUptime(overview.data.uptime_s));
  }

  function renderOverview(d) {
    if (!d) return;
    setText('c-wallets-total',      NUM_FMT.format(d.wallets?.total ?? 0));
    setText('c-wallets-top',        NUM_FMT.format(d.wallets?.top ?? 0));
    setText('c-wallets-tracked',    NUM_FMT.format(d.wallets?.tracked ?? 0));
    setText('c-wallets-candidate',  NUM_FMT.format(d.wallets?.candidate ?? 0));
    setText('c-wallets-rejected',   NUM_FMT.format(d.wallets?.rejected ?? 0));

    setText('c-positions-total',    NUM_FMT.format(d.positions?.total ?? 0));
    setText('c-positions-open',     NUM_FMT.format(d.positions?.open ?? 0));
    setText('c-positions-closed',   NUM_FMT.format(d.positions?.closed ?? 0));

    setText('c-signals-total',      NUM_FMT.format(d.signals?.total ?? 0));
    setText('c-signals-sent',       NUM_FMT.format(d.signals?.sent ?? 0));
    setText('c-signals-pending',    NUM_FMT.format(d.signals?.pending ?? 0));

    setText('c-training-total',     NUM_FMT.format(d.training_records?.total ?? 0));
    setText('c-training-exported',  NUM_FMT.format(d.training_records?.exported ?? 0));
  }

  function renderWallets(rows) {
    const tbody = document.querySelector('#table-wallets tbody');
    setText('toolbar-meta', `${rows.length} wallet${rows.length === 1 ? '' : 's'} matched`);
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="12" class="empty-row">no wallets match current filter</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((w, i) => `
      <tr>
        <td class="num-col">${(i + 1).toString().padStart(2, '0')}</td>
        <td class="wallet-col">
          <span class="wallet-cell" data-address="${escHtml(w.address)}" title="click to copy · ${escHtml(w.address)}">
            <span class="mono">${escHtml(w.short)}</span>
            <button class="copy-btn" title="copy address">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </button>
          </span>
        </td>
        <td class="num ${scoreClass(w.score)} score-cell">${w.score.toFixed(1)}</td>
        <td class="num ${wrClass(w.win_rate)}">${w.win_rate.toFixed(1)}%</td>
        <td class="num ${pnlClass(w.total_pnl_usd)}">${USD_FMT.format(w.total_pnl_usd)}</td>
        <td class="num fee-pos">${USD_FMT.format(w.total_fees_usd)}</td>
        <td class="num">${w.avg_fee_yield.toFixed(2)}%</td>
        <td class="num">${NUM_FMT.format(w.unique_pools_traded)}</td>
        <td class="num">
          <span class="win-count">${w.win_count}</span><span class="muted"> / </span><span class="loss-count">${w.loss_count}</span>
        </td>
        <td class="num">${w.open_positions > 0 ? `<span class="wr-good">${w.open_positions}</span>` : w.open_positions}</td>
        <td class="num ${binClass(w.avg_bin_range)}">${w.avg_bin_range || '—'}</td>
        <td class="strategy-col">${strategyPillsHtml(w.strategy_tags)}</td>
      </tr>
    `).join('');

    tbody.querySelectorAll('.wallet-cell').forEach((cell) => {
      cell.addEventListener('click', () => {
        const addr = cell.dataset.address;
        if (!addr || !navigator.clipboard) return;
        navigator.clipboard.writeText(addr).then(() => {
          const btn = cell.querySelector('.copy-btn');
          if (!btn) return;
          btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
          setTimeout(() => {
            btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
          }, 1200);
        });
      });
    });
  }

  function renderSignals(rows) {
    const tbody = document.querySelector('#table-signals tbody');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-row">no signals yet — waiting for top wallet to enter a screened pool</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((s) => {
      const conf = Number(s.combined_confidence || 0);
      const trig = s.triggered_by || '';
      const trigShort = trig.length > 12 ? trig.slice(0, 6) + '…' + trig.slice(-4) : trig;
      const pillCls = s.status === 'sent' ? 'pill-sent' : s.status === 'expired' ? 'pill-expired' : 'pill-pending';
      return `
        <tr>
          <td title="${escHtml(fmtTime(s.created_at))}">${escHtml(fmtAgo(s.created_at))}</td>
          <td>${escHtml(s.token_pair || '—')}</td>
          <td class="mono" title="${escHtml(trig)}">${escHtml(trigShort)}</td>
          <td class="num"><strong>${(conf * 100).toFixed(0)}%</strong></td>
          <td><span class="pill ${pillCls}">${escHtml(s.status)}</span></td>
        </tr>
      `;
    }).join('');
  }

  function fmtTime(unixSec) {
    if (!unixSec) return '--';
    return new Date(Number(unixSec) * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  }

  function renderPositions(rows) {
    const tbody = document.querySelector('#table-positions tbody');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-row">no closed positions yet</td></tr>';
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

  function renderCoverage(d) {
    const target = $('coverage-bars');
    const meta = $('coverage-meta');
    if (!d || !d.coverage) {
      target.innerHTML = '<div class="empty-row">no data</div>';
      meta.textContent = 'fields populated in training_records';
      return;
    }
    const entries = Object.entries(d.coverage).sort((a, b) => b[1].pct - a[1].pct);
    target.innerHTML = entries.map(([name, info]) => {
      let flagCls, fillColor;
      if (info.pct >= 95)      { flagCls = 'flag-ok';   fillColor = 'linear-gradient(90deg, #1f6a4a, #5aff9c)'; }
      else if (info.pct >= 50) { flagCls = 'flag-mid';  fillColor = 'linear-gradient(90deg, #2a4a7a, #6aa9ff)'; }
      else if (info.pct > 0)   { flagCls = 'flag-warn'; fillColor = 'linear-gradient(90deg, #7a5e1f, #ffd95e)'; }
      else                     { flagCls = 'flag-low';  fillColor = 'linear-gradient(90deg, #3d4a66, #5b6b8a)'; }
      const flagTxt = info.pct >= 95 ? '✓' : info.pct >= 50 ? '~' : info.pct > 0 ? '!' : '×';
      return `
        <div class="bar-row">
          <div class="bar-label"><span class="flag ${flagCls}">${flagTxt}</span>${escHtml(name)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${info.pct.toFixed(1)}%; background:${fillColor}"></div></div>
          <div class="bar-value">${info.pct.toFixed(0)}%</div>
        </div>
      `;
    }).join('');
    const profitRate = d.total ? (d.profitable / d.total * 100) : 0;
    meta.textContent = `${NUM_FMT.format(d.total)} records · ${NUM_FMT.format(d.pools)} pools · ${NUM_FMT.format(d.wallets)} wallets · ${profitRate.toFixed(1)}% profitable`;
    setText('c-training-rate', profitRate.toFixed(1) + '%');
  }

  function renderSources(d) {
    const target = $('chart-sources');
    if (!d.rows || !d.rows.length) {
      target.innerHTML = '<div class="empty-row">no discovery sources yet</div>';
      return;
    }
    const total = d.total || 1;
    target.innerHTML = d.rows.map((row) => `
      <div class="source-row">
        <div class="source-label">${escHtml(row.source || 'unknown')}</div>
        <div class="source-track"><div class="source-fill" style="width:${(row.n / total * 100).toFixed(1)}%"></div></div>
        <div class="source-value">${NUM_FMT.format(row.n)}</div>
      </div>
    `).join('');
  }

  function renderScoreDist(rows) {
    const target = $('score-distribution');
    if (!rows.length) {
      target.innerHTML = '<div class="empty-row">no scored wallets yet</div>';
      return;
    }
    const total = rows.reduce((a, r) => a + r.n, 0) || 1;
    const order = ['80-100', '60-80', '40-60', '20-40', '1-20', '0'];
    const sorted = [...rows].sort((a, b) => order.indexOf(a.bucket) - order.indexOf(b.bucket));
    target.innerHTML = sorted.map((r) => {
      const pct = (r.n / total * 100);
      return `
        <div class="dist-row">
          <div class="dist-label">${escHtml(r.bucket)}</div>
          <div class="dist-track"><div class="dist-fill" style="width:${Math.max(pct, 4)}%">${pct >= 8 ? r.n : ''}</div></div>
          <div class="dist-value">${NUM_FMT.format(r.n)}</div>
        </div>
      `;
    }).join('');
  }

  function renderHealth(d) {
    const tbody = document.querySelector('#table-health tbody');
    const subs = d.subsystems || {};
    const entries = Object.entries(subs);
    if (!entries.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-row">no subsystem data (scout writes these on first cycle)</td></tr>';
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
          <td>${isStalled ? '<span class="pill pill-stalled">stalled</span>' : '<span class="pill pill-ok">ok</span>'}</td>
        </tr>
      `;
    }).join('');
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('filter-status').addEventListener('change', () => refresh());
    $('order-by').addEventListener('change', () => refresh());
    refresh();
    setInterval(refresh, POLL_INTERVAL_MS);
  });
})();
