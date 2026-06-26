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

  function fmtUptime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '--';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
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
    const d = new Date(Number(unixSec) * 1000);
    return `${TIME_FMT.format(d)} (${fmtAgo(unixSec)})`;
  }

  function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  async function fetchJson(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  }

  function setStatus(state) {
    const dot = $('status-dot');
    if (!dot) return;
    dot.classList.remove('ok', 'err');
    if (state === 'ok') dot.classList.add('ok');
    else if (state === 'err') dot.classList.add('err');
  }

  async function refreshOverview() {
    try {
      const r = await fetchJson('/api/overview');
      if (!r.ok) throw new Error(r.error || 'bad response');
      const d = r.data;
      setText('c-wallets-total', NUM_FMT.format(d.wallets.total));
      setText('c-wallets-top', `${NUM_FMT.format(d.wallets.top)} top`);
      setText('c-wallets-tracked', `${NUM_FMT.format(d.wallets.tracked)} tracked`);
      setText('c-wallets-candidate', `${NUM_FMT.format(d.wallets.candidate)} candidate`);
      setText('c-wallets-rejected', `${NUM_FMT.format(d.wallets.rejected)} rejected`);
      setText('c-positions-total', NUM_FMT.format(d.positions.total));
      setText('c-positions-open', `${NUM_FMT.format(d.positions.open)} open`);
      setText('c-positions-closed', `${NUM_FMT.format(d.positions.closed)} closed`);
      setText('c-signals-total', NUM_FMT.format(d.signals.total));
      setText('c-signals-pending', `${NUM_FMT.format(d.signals.pending)} pending`);
      setText('c-signals-sent', `${NUM_FMT.format(d.signals.sent)} sent`);
      setText('c-training-total', NUM_FMT.format(d.training_records.total));
      setText('c-training-exported', `${NUM_FMT.format(d.training_records.exported)} exported`);
      setText('c-processed-txs', NUM_FMT.format(d.processed_txs));
      setText('c-snapshots', NUM_FMT.format(d.snapshots));
      setText('uptime', fmtUptime(d.uptime_s));
      setStatus('ok');
    } catch (err) {
      console.error('overview failed', err);
      setStatus('err');
    }
  }

  async function refreshTopWallets() {
    try {
      const r = await fetchJson('/api/wallets/top?limit=10');
      const tbody = document.querySelector('#table-top-wallets tbody');
      if (!r.ok || !r.data.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty">no top wallets yet</td></tr>';
        return;
      }
      tbody.innerHTML = r.data.map((w) => `
        <tr>
          <td class="mono" title="${escHtml(w.address)}">${escHtml(w.short)}</td>
          <td class="num"><strong>${w.score}</strong></td>
          <td class="num">${w.win_rate}%</td>
          <td class="num">${NUM_FMT.format(w.total_positions)}</td>
          <td class="num ${w.total_pnl_usd >= 0 ? 'ok-text' : 'stalled'}">${USD_FMT.format(w.total_pnl_usd)}</td>
          <td class="num">${NUM_FMT.format(w.unique_pools_traded)}</td>
          <td><span class="pill">${escHtml(w.source || 'unknown')}</span></td>
        </tr>
      `).join('');
    } catch (err) {
      console.error('top wallets failed', err);
    }
  }

  async function refreshSignals() {
    try {
      const r = await fetchJson('/api/signals/recent?limit=10');
      const tbody = document.querySelector('#table-signals tbody');
      if (!r.ok || !r.data.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty">no signals yet — waiting for top wallet to enter a screened pool</td></tr>';
        return;
      }
      tbody.innerHTML = r.data.map((s) => {
        const trig = s.triggered_by || 'unknown';
        const trigShort = trig.length > 12 ? trig.slice(0, 6) + '…' + trig.slice(-4) : trig;
        const conf = Number(s.combined_confidence || 0);
        const pill = s.status === 'sent' ? 'pill-sent' : s.status === 'expired' ? 'pill-rejected' : 'pill-pending';
        return `
          <tr>
            <td class="mono" title="${escHtml(new Date(Number(s.created_at) * 1000).toISOString())}">${escHtml(fmtAgo(s.created_at))}</td>
            <td>${escHtml(s.token_pair || 'unknown')}</td>
            <td class="mono" title="${escHtml(trig)}">${escHtml(trigShort)}</td>
            <td class="num"><strong>${(conf * 100).toFixed(0)}%</strong></td>
            <td><span class="pill ${pill}">${escHtml(s.status)}</span></td>
          </tr>
        `;
      }).join('');
    } catch (err) {
      console.error('signals failed', err);
    }
  }

  async function refreshPositions() {
    try {
      const r = await fetchJson('/api/positions/recent?status=closed&limit=10');
      const tbody = document.querySelector('#table-positions tbody');
      if (!r.ok || !r.data.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty">no closed positions yet</td></tr>';
        return;
      }
      tbody.innerHTML = r.data.map((p) => `
        <tr>
          <td class="mono" title="${escHtml(p.id)}">${escHtml(p.short)}</td>
          <td class="mono" title="${escHtml(p.wallet_address)}">${escHtml(p.wallet_short)}</td>
          <td>${escHtml(p.token_pair || '—')}</td>
          <td class="num ${p.pnl_usd >= 0 ? 'ok-text' : 'stalled'}">${USD_FMT.format(p.pnl_usd)}</td>
          <td class="num">${USD_FMT.format(p.fees_earned_usd)}</td>
          <td class="num">${p.duration_hours.toFixed(1)}h</td>
          <td>${p.is_profitable ? '<span class="pill pill-sent">profit</span>' : '<span class="pill pill-rejected">loss</span>'}</td>
        </tr>
      `).join('');
    } catch (err) {
      console.error('positions failed', err);
    }
  }

  async function refreshDiscoveries() {
    try {
      const r = await fetchJson('/api/discovery-recent?limit=15');
      const tbody = document.querySelector('#table-discoveries tbody');
      if (!r.ok || !r.data.length) {
        tbody.innerHTML = '<tr><td colspan="4" class="empty">no discovery events recorded</td></tr>';
        return;
      }
      tbody.innerHTML = r.data.map((d) => {
        const wallet = d.wallet_address || '';
        const walletShort = wallet.length > 12 ? wallet.slice(0, 6) + '…' + wallet.slice(-4) : wallet;
        const detail = d.source_detail || '';
        const detailShort = detail.length > 14 ? detail.slice(0, 8) + '…' + detail.slice(-4) : detail;
        return `
          <tr>
            <td class="mono">${escHtml(fmtAgo(d.discovered_at))}</td>
            <td class="mono" title="${escHtml(wallet)}">${escHtml(walletShort)}</td>
            <td><span class="pill">${escHtml(d.discovery_source)}</span></td>
            <td class="mono" title="${escHtml(detail)}">${escHtml(detailShort)}</td>
          </tr>
        `;
      }).join('');
    } catch (err) {
      console.error('discoveries failed', err);
    }
  }

  async function refreshScoreDistribution() {
    try {
      const r = await fetchJson('/api/score-distribution');
      const target = $('chart-score');
      if (!r.ok || !r.data.length) {
        target.innerHTML = '<div class="empty">no scored wallets</div>';
        return;
      }
      const max = Math.max(...r.data.map((d) => d.n), 1);
      const colors = { '80-100': 'var(--purple)', '60-80': 'var(--blue)', '40-60': 'var(--accent)', '20-40': 'var(--amber)', '1-20': 'var(--muted)', '0': 'var(--muted)' };
      target.innerHTML = r.data.map((d) => `
        <div class="bar-row">
          <div class="bar-label">${escHtml(d.bucket)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${(d.n / max * 100).toFixed(1)}%; background:${colors[d.bucket] || 'var(--accent)'}"></div></div>
          <div class="bar-value">${NUM_FMT.format(d.n)}</div>
        </div>
      `).join('');
    } catch (err) {
      console.error('score distribution failed', err);
    }
  }

  async function refreshSources() {
    try {
      const r = await fetchJson('/api/discovery-sources');
      const target = $('chart-sources');
      if (!r.ok || !r.data.rows.length) {
        target.innerHTML = '<div class="empty">no discoveries yet</div>';
        return;
      }
      const total = r.data.total || 1;
      const colors = { 'pool_discovery': 'var(--accent)', 'tx_mining': 'var(--blue)', 'follow_winner': 'var(--purple)', 'manual': 'var(--amber)', 'seed': 'var(--green)' };
      target.innerHTML = r.data.rows.map((d) => `
        <div class="bar-row">
          <div class="bar-label">${escHtml(d.source)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${(d.n / total * 100).toFixed(1)}%; background:${colors[d.source] || 'var(--accent)'}"></div></div>
          <div class="bar-value">${NUM_FMT.format(d.n)}</div>
        </div>
      `).join('');
    } catch (err) {
      console.error('sources failed', err);
    }
  }

  async function refreshHealth() {
    try {
      const r = await fetchJson('/api/health');
      const tbody = document.querySelector('#table-health tbody');
      if (!r.ok || !Object.keys(r.data.subsystems).length) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty">no subsystem data</td></tr>';
        return;
      }
      const stalled = new Set(r.data.stalled || []);
      tbody.innerHTML = Object.entries(r.data.subsystems).map(([name, info]) => {
        const ls = info.lastSuccess ? fmtAgo(info.lastSuccess) : '—';
        const le = info.lastError ? fmtAgo(info.lastError) : '—';
        const errCount = info.errorCount ?? 0;
        const isStalled = stalled.has(name);
        return `
          <tr>
            <td class="mono">${escHtml(name)}</td>
            <td class="mono">${escHtml(ls)}</td>
            <td class="mono">${escHtml(le)}</td>
            <td class="num ${errCount > 0 ? 'stalled' : 'muted'}">${errCount}</td>
            <td>${isStalled ? '<span class="stalled">STALLED</span>' : '<span class="ok-text">ok</span>'}</td>
          </tr>
        `;
      }).join('');
    } catch (err) {
      console.error('health failed', err);
    }
  }

  async function refreshCron() {
    try {
      const r = await fetchJson('/api/cron-status');
      const tbody = document.querySelector('#table-cron tbody');
      const data = r.data || {};
      const entries = Object.entries(data);
      if (!entries.length) {
        tbody.innerHTML = '<tr><td colspan="2" class="empty">no cron metadata yet (scout writes these on first cycle)</td></tr>';
        return;
      }
      tbody.innerHTML = entries.map(([k, v]) => `
        <tr>
          <td class="mono">${escHtml(k)}</td>
          <td class="mono">${escHtml(fmtAgo(v))}</td>
        </tr>
      `).join('');
    } catch (err) {
      console.error('cron failed', err);
    }
  }

  async function refreshAll() {
    await Promise.all([
      refreshOverview(),
      refreshTopWallets(),
      refreshSignals(),
      refreshPositions(),
      refreshDiscoveries(),
      refreshScoreDistribution(),
      refreshSources(),
      refreshHealth(),
      refreshCron(),
    ]);
    setText('last-poll', TIME_FMT.format(new Date()));
  }

  refreshAll();
  setInterval(refreshAll, POLL_INTERVAL_MS);
})();