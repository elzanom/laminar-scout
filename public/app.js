(function () {
  'use strict';

  const POLL_INTERVAL_MS = 5000;
  const SEARCH_DEBOUNCE_MS = 200;

  const NUM_FMT = new Intl.NumberFormat('en-US');
  const USD_FMT = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
    maximumFractionDigits: 2, minimumFractionDigits: 2,
  });
  const PCT_FMT = new Intl.NumberFormat('en-US', {
    style: 'percent', maximumFractionDigits: 1,
  });
  const TIME_FMT = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });

  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => document.querySelectorAll(sel);

  let pollCount = 0;
  let lastData = null;
  let searchTerm = '';
  let coverageSortMode = 'pct';
  let activeView = 'leaderboard';
  let selectedWallet = null;

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
    if (!unixSec) return '—';
    const delta = Math.floor(Date.now() / 1000) - Number(unixSec);
    if (delta < 0) return 'now';
    if (delta < 60) return `${delta}s ago`;
    if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
    if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
    return `${Math.floor(delta / 86400)}d ago`;
  }

  function fmtTime(unixSec) {
    if (!unixSec) return '—';
    return new Date(Number(unixSec) * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
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
  function scoreClass(s) {
    if (s >= 70) return 'score-high';
    if (s >= 40) return 'score-mid';
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
    return '<div class="tag-row">' + tags.map((t) =>
      `<span class="tag ${escHtml(t.cls)}">${escHtml(t.text)}</span>`
    ).join('') + '</div>';
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function switchView(name) {
    activeView = name;
    $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === name));
    $$('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
    if (name === 'leaderboard') renderLeaderboard();
  }

  async function refresh() {
    pollCount += 1;
    const status = $('filter-status').value;
    const order = $('order-by').value;

    const [overview, wallets, signals, positions, sources, health, summary, dist, cron] = await Promise.all([
      fetchJson('/api/overview').catch(() => ({ data: null })),
      fetchJson(`/api/wallets/top?limit=100&status=${encodeURIComponent(status)}&order=${order}`).catch(() => ({ data: [] })),
      fetchJson('/api/signals/recent?limit=10').catch(() => ({ data: [] })),
      fetchJson('/api/positions/recent?status=closed&limit=10').catch(() => ({ data: [] })),
      fetchJson('/api/discovery-sources').catch(() => ({ data: { rows: [], total: 0 } })),
      fetchJson('/api/health').catch(() => ({ data: { subsystems: {}, stalled: [], counters: {} } })),
      fetchJson('/api/dataset-summary').catch(() => ({ data: null })),
      fetchJson('/api/score-distribution').catch(() => ({ data: [] })),
      fetchJson('/api/cron-status').catch(() => ({ data: {} })),
    ]);

    lastData = { overview, wallets, signals, positions, sources, health, summary, dist, cron };
    renderOverview(overview.data);
    renderLeaderboard(wallets.data || []);
    renderSignals(signals.data || []);
    renderPositions(positions.data || []);
    renderSources(sources.data || { rows: [], total: 0 });
    renderHealth(health.data || { subsystems: {}, stalled: [] });
    renderCron(cron.data || {});
    renderCoverage(summary.data);
    renderScoreDist(dist.data || []);

    const now = new Date();
    setText('last-poll', TIME_FMT.format(now));
    if (overview.data?.uptime_s != null) {
      setText('status-uptime', fmtUptime(overview.data.uptime_s));
    }
  }

  function renderOverview(d) {
    if (!d) return;
    setText('c-wallets-total',     NUM_FMT.format(d.wallets?.total ?? 0));
    setText('c-wallets-top',       NUM_FMT.format(d.wallets?.top ?? 0));
    setText('c-wallets-tracked',   NUM_FMT.format(d.wallets?.tracked ?? 0));
    setText('c-wallets-candidate', NUM_FMT.format(d.wallets?.candidate ?? 0));
    setText('c-wallets-rejected',  NUM_FMT.format(d.wallets?.rejected ?? 0));
    setText('c-positions-total',   NUM_FMT.format(d.positions?.total ?? 0));
    setText('c-positions-open',    NUM_FMT.format(d.positions?.open ?? 0));
    setText('c-positions-closed',  NUM_FMT.format(d.positions?.closed ?? 0));
    setText('c-signals-total',     NUM_FMT.format(d.signals?.total ?? 0));
    setText('c-signals-sent',      NUM_FMT.format(d.signals?.sent ?? 0));
    setText('c-signals-pending',   NUM_FMT.format(d.signals?.pending ?? 0));
    setText('c-training-total',    NUM_FMT.format(d.training_records?.total ?? 0));
    setText('c-training-exported', NUM_FMT.format(d.training_records?.exported ?? 0));
  }

  function renderLeaderboard(rows) {
    if (!rows) rows = lastData?.wallets?.data || [];
    const tbody = document.querySelector('#table-wallets tbody');
    let filtered = rows;
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      filtered = rows.filter(r => r.address.toLowerCase().includes(q));
    }
    setText('lb-meta', `${filtered.length}${searchTerm ? ` of ${rows.length}` : ''} wallet${filtered.length === 1 ? '' : 's'} · sorted by score`);

    if (!filtered.length) {
      tbody.innerHTML = `<tr><td colspan="12" class="empty-row">${searchTerm ? 'no wallets match your search' : 'no wallets match current filter'}</td></tr>`;
      return;
    }
    tbody.innerHTML = filtered.map((w, i) => `
      <tr class="clickable" data-addr="${escHtml(w.address)}">
        <td class="col-rank">${(i + 1).toString().padStart(2, '0')}</td>
        <td>
          <span class="wallet-cell" data-address="${escHtml(w.address)}" title="click row for details · ${escHtml(w.address)}">
            <span class="mono">${escHtml(w.short)}</span>
            <button class="copy-btn" title="copy address">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </button>
          </span>
        </td>
        <td class="col-num ${scoreClass(w.score)} score-cell">${w.score.toFixed(1)}</td>
        <td class="col-num ${wrClass(w.win_rate)}">${w.win_rate.toFixed(1)}%</td>
        <td class="col-num ${pnlClass(w.total_pnl_usd)}">${USD_FMT.format(w.total_pnl_usd)}</td>
        <td class="col-num fee-pos">${USD_FMT.format(w.total_fees_usd)}</td>
        <td class="col-num">${w.avg_fee_yield.toFixed(2)}%</td>
        <td class="col-num">${NUM_FMT.format(w.unique_pools_traded)}</td>
        <td class="col-num">
          <span class="win-count">${w.win_count}</span><span class="muted">/</span><span class="loss-count">${w.loss_count}</span>
        </td>
        <td class="col-num">${w.open_positions > 0 ? `<span class="wr-good">${w.open_positions}</span>` : w.open_positions}</td>
        <td class="col-num ${binClass(w.avg_bin_range)}">${w.avg_bin_range || '—'}</td>
        <td>${strategyPillsHtml(w.strategy_tags)}</td>
      </tr>
    `).join('');

    tbody.querySelectorAll('.wallet-cell').forEach((cell) => {
      cell.addEventListener('click', (e) => {
        e.stopPropagation();
        const addr = cell.dataset.address;
        if (!addr || !navigator.clipboard) return;
        navigator.clipboard.writeText(addr).then(() => {
          const btn = cell.querySelector('.copy-btn');
          btn.classList.add('copied');
          btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
          setTimeout(() => {
            btn.classList.remove('copied');
            btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
          }, 1200);
        });
      });
    });

    tbody.querySelectorAll('tr.clickable').forEach((row) => {
      row.addEventListener('click', () => {
        const addr = row.dataset.addr;
        showWalletDetail(addr);
      });
    });
  }

  async function showWalletDetail(addr) {
    selectedWallet = addr;
    const detailEl = $('lb-detail');
    const grid = $('detail-grid');
    setText('detail-addr', addr);
    grid.innerHTML = '<div class="muted">loading wallet positions…</div>';
    detailEl.hidden = false;
    detailEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    try {
      const r = await fetchJson(`/api/positions/recent?status=all&limit=20`);
      const all = (r.data || []).filter(p => p.wallet_address === addr);
      if (!all.length) {
        grid.innerHTML = '<div class="muted">no positions found for this wallet yet</div>';
        return;
      }
      const total = all.length;
      const wins = all.filter(p => p.is_profitable).length;
      const totalPnl = all.reduce((a, p) => a + (p.pnl_usd || 0), 0);
      const totalFees = all.reduce((a, p) => a + (p.fees_earned_usd || 0), 0);
      const avgHours = all.reduce((a, p) => a + (p.duration_hours || 0), 0) / total;

      grid.innerHTML = `
        <div class="detail-item"><span class="di-label">positions</span><span class="di-val">${total}</span></div>
        <div class="detail-item"><span class="di-label">wins</span><span class="di-val" style="color:var(--green)">${wins}</span></div>
        <div class="detail-item"><span class="di-label">win rate</span><span class="di-val">${PCT_FMT.format(wins / total)}</span></div>
        <div class="detail-item"><span class="di-label">total pnl</span><span class="di-val ${pnlClass(totalPnl)}">${USD_FMT.format(totalPnl)}</span></div>
        <div class="detail-item"><span class="di-label">total fees</span><span class="di-val" style="color:var(--green)">${USD_FMT.format(totalFees)}</span></div>
        <div class="detail-item"><span class="di-label">avg duration</span><span class="di-val">${avgHours.toFixed(1)}h</span></div>
      `;
    } catch (err) {
      grid.innerHTML = `<div class="muted">error loading: ${escHtml(err.message)}</div>`;
    }
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
          <td class="col-num"><strong>${(conf * 100).toFixed(0)}%</strong></td>
          <td><span class="pill ${pillCls}">${escHtml(s.status)}</span></td>
        </tr>
      `;
    }).join('');
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
          <td class="col-num ${pnlClass(p.pnl_usd)}">${USD_FMT.format(p.pnl_usd)}</td>
          <td class="col-num fee-pos">${USD_FMT.format(p.fees_earned_usd)}</td>
          <td class="col-num">${p.duration_hours.toFixed(1)}h</td>
          <td><span class="pill ${resultCls}">${resultTxt}</span></td>
        </tr>
      `;
    }).join('');
  }

  function renderCoverage(d) {
    const target = $('coverage-bars');
    if (!d || !d.coverage) {
      target.innerHTML = '<div class="empty-row">no data</div>';
      return;
    }
    let entries = Object.entries(d.coverage);
    if (coverageSortMode === 'alpha') {
      entries.sort((a, b) => a[0].localeCompare(b[0]));
    } else {
      entries.sort((a, b) => b[1].pct - a[1].pct);
    }
    target.innerHTML = entries.map(([name, info]) => {
      let flagCls, fillColor;
      if (info.pct >= 95)      { flagCls = 'flag-ok';   fillColor = 'linear-gradient(90deg, #064e3b, #34d399)'; }
      else if (info.pct >= 50) { flagCls = 'flag-mid';  fillColor = 'linear-gradient(90deg, #1e3a8a, #60a5fa)'; }
      else if (info.pct > 0)   { flagCls = 'flag-warn'; fillColor = 'linear-gradient(90deg, #78350f, #fbbf24)'; }
      else                     { flagCls = 'flag-low';  fillColor = 'linear-gradient(90deg, #1f2937, #4b5563)'; }
      const flagTxt = info.pct >= 95 ? '✓' : info.pct >= 50 ? '~' : info.pct > 0 ? '!' : '×';
      return `
        <div class="bar-row">
          <div class="bar-label"><span class="flag ${flagCls}">${flagTxt}</span>${escHtml(name)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${info.pct.toFixed(1)}%; background:${fillColor}"></div></div>
          <div class="bar-value">${info.pct.toFixed(0)}%</div>
        </div>
      `;
    }).join('');

    setText('ds-records', NUM_FMT.format(d.total || 0));
    setText('ds-pools', NUM_FMT.format(d.pools || 0));
    setText('ds-wallets', NUM_FMT.format(d.wallets || 0));
    const profitRate = d.total ? (d.profitable / d.total) : 0;
    setText('ds-profit-rate', PCT_FMT.format(profitRate));
    setText('ds-exported', NUM_FMT.format(d.exported || 0));
    setText('dataset-meta', `${NUM_FMT.format(d.total || 0)} records · ${NUM_FMT.format(d.wallets || 0)} wallets · ${(profitRate * 100).toFixed(1)}% profitable`);
    setText('c-training-rate', (profitRate * 100).toFixed(1) + '%');
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
      tbody.innerHTML = '<tr><td colspan="5" class="empty-row">no subsystem data yet</td></tr>';
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
          <td class="col-num ${errCount > 0 ? 'pnl-neg' : 'muted'}">${errCount}</td>
          <td>${isStalled ? '<span class="pill pill-stalled">stalled</span>' : '<span class="pill pill-ok">ok</span>'}</td>
        </tr>
      `;
    }).join('');
  }

  function renderCron(d) {
    const tbody = document.querySelector('#table-cron tbody');
    const entries = Object.entries(d).filter(([k]) => k.startsWith('cron_') || k.startsWith('last_'));
    if (!entries.length) {
      tbody.innerHTML = '<tr><td colspan="2" class="empty-row">no cron data yet</td></tr>';
      return;
    }
    tbody.innerHTML = entries.map(([key, val]) => {
      const ts = Number(val);
      const ago = Number.isFinite(ts) && ts > 1e9 ? fmtAgo(ts) : String(val);
      return `
        <tr>
          <td class="mono">${escHtml(key)}</td>
          <td>${escHtml(ago)}</td>
        </tr>
      `;
    }).join('');
  }

  document.addEventListener('DOMContentLoaded', () => {
    $$('.nav-tab').forEach((tab) => {
      tab.addEventListener('click', () => switchView(tab.dataset.view));
    });

    $('filter-status').addEventListener('change', () => refresh());
    $('order-by').addEventListener('change', () => refresh());
    $('coverage-sort').addEventListener('change', (e) => {
      coverageSortMode = e.target.value;
      renderCoverage(lastData?.summary?.data);
    });

    const onSearch = debounce((e) => {
      searchTerm = e.target.value.trim();
      renderLeaderboard();
    }, SEARCH_DEBOUNCE_MS);
    $('lb-search').addEventListener('input', onSearch);

    $('detail-close').addEventListener('click', () => {
      $('lb-detail').hidden = true;
      selectedWallet = null;
    });

    $('btn-refresh').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.classList.add('spinning');
      await refresh();
      setTimeout(() => btn.classList.remove('spinning'), 400);
    });

    refresh();
    setInterval(refresh, POLL_INTERVAL_MS);
  });
})();
