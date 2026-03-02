let currentState = null;
let activeTab = 'polymarket';
let socialSignals = [];
let lastSocialFetchAt = 0;

const tabsEl = document.getElementById('tabs');
const contentEl = document.getElementById('content');

function money(n) { return `$${Number(n || 0).toFixed(2)}`; }

function initTabs() {
  tabsEl.innerHTML = '';
  ['polymarket', 'meme'].forEach(tab => {
    const btn = document.createElement('button');
    btn.textContent = tab === 'polymarket' ? 'Polymarket' : 'Meme Coins';
    btn.className = (tab === activeTab) ? 'tab-btn active' : 'tab-btn';
    btn.onclick = () => {
      activeTab = tab;
      initTabs(); // re-render tabs for active class
      render();
    };
    tabsEl.appendChild(btn);
  });
}

function renderMetrics(m) {
  const cards = [
    ['Cash', money(m.bankrollCash)],
    ['Equity', money(m.equity)],
    ['Realized', money(m.realizedPnl)],
    ['Unrealized', money(m.unrealizedPnl)],
    ['Win Rate', `${m.winRate.toFixed(1)}%`],
    ['Drawdown', `${m.maxDrawdownPct.toFixed(2)}%`]
  ];
  return cards.map(([l, v]) => `<div class="metric"><div class="label">${l}</div><div class="value">${v}</div></div>`).join('');
}

function renderBets(bets, status) {
  const list = bets.filter(b => b.status === status);
  if (!list.length) return '<p class="small">No bets.</p>';
  
  if (status === 'closed') {
    return list.slice(0, 20).map(b => `
      <div class="bet">
        <strong>${b.market}</strong> (${b.side})<br/>
        <span class="small">Result: ${money(b.realizedPnl)} | Payout: ${money(b.payout)}</span>
      </div>
    `).join('');
  }

  return list.map(b => {
    const entry = Number(b.entryOdds || 0);
    const curr = Number(b.currentOdds || b.entryOdds || 0);
    const pnl = entry > 0 ? (b.size * (curr / entry) - b.size) : 0;

    if (activeTab === 'meme') {
      return `
        <div class="bet">
          <strong>${b.market}</strong> (${b.side})<br/>
          <span class="small">Entry: ${entry.toFixed(6)} | Curr: ${curr.toFixed(6)} | Size: ${money(b.size)} | U-PnL: ${money(pnl)}</span>
          <div class="small" style="color:#999">Auto-managed (mark + auto-close)</div>
        </div>
      `;
    }

    return `
      <div class="bet">
        <strong>${b.market}</strong> (${b.side})<br/>
        <span class="small">Entry: ${entry.toFixed(6)} | Curr: ${curr.toFixed(6)} | Size: ${money(b.size)}</span>
        <div class="row">
          <input id="odds-${b.id}" type="number" step="0.001" placeholder="New odds" style="flex:1"> 
          <button onclick="updateBet('${b.id}')" style="flex:0.5">Upd</button>
          <button onclick="closeBet('${b.id}', true)" class="btn-win" style="flex:0.5">Win</button>
          <button onclick="closeBet('${b.id}', false)" class="btn-loss" style="flex:0.5">Loss</button>
        </div>
      </div>
    `;
  }).join('');
}

function renderActivity(list) {
  return list.slice(0, 15).map(a => `
    <div class="bet small">
      <span style="color:#888">${new Date(a.at).toLocaleTimeString()}</span> 
      <strong>${a.type}</strong>: ${a.payload.market || ''}
    </div>
  `).join('');
}

function renderMemeStatusPanel() {
  const s = currentState?.memeStatus;
  if (!s) return '';
  const lastRun = s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : 'never';
  return `
    <div class="card" style="margin-bottom:12px;">
      <h2>Meme Status</h2>
      <div class="small">Last scan: ${lastRun}</div>
      <div class="small">Source: ${s.source || '-'}</div>
      <div class="small">Min gain: ${s.minGainPercent ?? '-'}% | Min score: ${s.minScore ?? '-'}</div>
      <div class="small">Scanned: ${s.scanned ?? 0} | Qualifying: ${s.qualifying ?? 0} | Opened: ${s.posted ?? 0}</div>
      <div class="small">Marked: ${s.updated ?? 0} | AutoClosed: ${s.closed ?? 0}</div>
      <div class="small">TP: ${s.takeProfitPct ?? 30}% | SL: ${s.stopLossPct ?? -15}% | MaxHold: ${s.maxHoldHours ?? 6}h</div>
      <div class="small">Tuning samples: ${s.tuningSampleSize ?? 0}</div>
      <div class="small">Weights: M=${s.tuningWeights?.momentum ?? 0.35} L=${s.tuningWeights?.liquidity ?? 0.30} R=${s.tuningWeights?.risk ?? 0.20} S=${s.tuningWeights?.social ?? 0.15}</div>
      <div class="small"><strong>Message:</strong> ${s.message || '-'}</div>
      <div class="row" style="margin-top:8px;gap:8px;">
        <input id="meme-min-gain" type="number" min="0" step="1" value="${Number(s.minGainPercent ?? 50)}" style="max-width:140px" title="Min 24h gain %" />
        <input id="meme-min-score" type="number" min="0" max="100" step="1" value="${Number(s.minScore ?? 70)}" style="max-width:120px" title="Min score (0-100)" />
        <button onclick="saveMemeConfig()">Save Thresholds</button>
        <button onclick="runMemeScanNow()">Run Scan Now</button>
        <button onclick="runMemeCloseCheckNow()" class="btn-win">Run Close Check</button>
      </div>
    </div>
  `;
}

function renderSocialSignalsPanel() {
  const rows = socialSignals.slice(0, 8);
  const listHtml = rows.length
    ? rows.map((s) => `
      <div class="bet small">
        <strong>${s.account || 'unknown'}</strong> → ${s.symbol || s.mint || '-'}
        <span style="color:#999"> | w:${Number(s.weight || 1)} | sentiment:${Number(s.sentiment || 1)}</span><br/>
        <span style="color:#888">${new Date(s.at).toLocaleString()}</span>
      </div>
    `).join('')
    : '<p class="small">No trusted signals yet.</p>';

  return `
    <div class="card" style="margin-bottom:12px;">
      <h2>Trusted Social Signals (Phase B)</h2>
      <form onsubmit="addSocialSignal(event)">
        <div class="row" style="gap:8px;">
          <input name="mint" placeholder="Mint (optional)" style="flex:1.2" />
          <input name="symbol" placeholder="Symbol (optional)" style="flex:0.8" />
        </div>
        <div class="row" style="gap:8px; margin-top:6px;">
          <input name="account" placeholder="Trusted account (e.g. @name)" required style="flex:1.2" />
          <input name="weight" type="number" step="0.1" min="0" value="1" placeholder="Weight" style="max-width:110px" />
          <input name="sentiment" type="number" step="0.1" min="-1" max="1" value="1" placeholder="Sentiment" style="max-width:120px" />
        </div>
        <input name="note" placeholder="Note (optional)" style="margin-top:6px" />
        <div class="row" style="gap:8px; margin-top:6px;">
          <button type="submit">Add Signal</button>
          <button type="button" onclick="refreshSocialSignals(true)">Refresh Signals</button>
        </div>
      </form>
      <div style="margin-top:10px;">${listHtml}</div>
    </div>
  `;
}

function render() {
  if (!currentState) return;
  const data = currentState[activeTab]; // { metrics, bets, activity }

  if (activeTab === 'meme') {
    const now = Date.now();
    if (now - lastSocialFetchAt > 15000) {
      refreshSocialSignals();
    }
  }
  
  contentEl.innerHTML = `
    <div class="row" style="margin-bottom:12px;gap:8px;">
      <button onclick="resetActiveTab()" class="btn-loss">Reset ${activeTab === 'meme' ? 'Meme' : 'Polymarket'}</button>
      <button onclick="resetAll()">Reset All</button>
    </div>

    ${activeTab === 'meme' ? renderMemeStatusPanel() : ''}
    ${activeTab === 'meme' ? renderSocialSignalsPanel() : ''}

    <div class="metrics">${renderMetrics(data.metrics)}</div>
    
    <div class="grid">
      ${activeTab === 'meme' ? '' : `
      <div class="card">
        <h2>New Poly Entry</h2>
        <form onsubmit="handleEntry(event)">
          <input name="market" placeholder="Market/Coin" required>
          <div class="row">
            <input name="side" placeholder="Side (YES/LONG)" required>
            <input name="entryOdds" type="number" step="0.001" placeholder="Price/Odds" required>
          </div>
          <input name="size" type="number" placeholder="Size ($)" required>
          <input name="thesis" placeholder="Thesis">
          <button type="submit">Submit Entry</button>
        </form>
      </div>
      `}

      <div class="card">
        <h2>Open Positions</h2>
        ${renderBets(data.bets, 'open')}
      </div>

      <div class="card">
        <h2>History</h2>
        ${renderBets(data.bets, 'closed')}
      </div>

      <div class="card">
        <h2>Log</h2>
        ${renderActivity(data.activity)}
      </div>
    </div>
  `;
}

// Actions
window.handleEntry = async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const json = Object.fromEntries(fd.entries());
  await api(`/api/bets?ledger=${activeTab}`, 'POST', json);
  e.target.reset();
};

window.updateBet = async (id) => {
  const odds = document.getElementById(`odds-${id}`).value;
  if (!odds) return;
  await api(`/api/bets/${id}?ledger=${activeTab}`, 'PATCH', { currentOdds: odds });
};

window.closeBet = async (id, resolved) => {
  if (!confirm('Close this position?')) return;
  await api(`/api/bets/${id}/close?ledger=${activeTab}`, 'POST', { resolved });
};

window.resetActiveTab = async () => {
  const label = activeTab === 'meme' ? 'Meme' : 'Polymarket';
  if (!confirm(`Reset all ${label} data?`)) return;
  await api(`/api/reset?ledger=${activeTab}`, 'POST', {});
};

window.resetAll = async () => {
  if (!confirm('Reset ALL data (Polymarket + Meme)?')) return;
  await api('/api/reset?ledger=all', 'POST', {});
};

window.saveMemeConfig = async () => {
  const gainEl = document.getElementById('meme-min-gain');
  const scoreEl = document.getElementById('meme-min-score');
  const minGainPercent = Number(gainEl?.value);
  const minScore = Number(scoreEl?.value);

  if (!Number.isFinite(minGainPercent) || minGainPercent < 0) {
    alert('Min gain must be a non-negative number.');
    return;
  }
  if (!Number.isFinite(minScore) || minScore < 0 || minScore > 100) {
    alert('Min score must be between 0 and 100.');
    return;
  }

  await api('/api/meme/config', 'POST', { minGainPercent, minScore });
};

window.runMemeScanNow = async () => {
  await api('/api/meme/scan', 'POST', {});
};

window.runMemeCloseCheckNow = async () => {
  await api('/api/meme/close-check', 'POST', {});
};

window.addSocialSignal = async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const payload = Object.fromEntries(fd.entries());

  if (!payload.mint && !payload.symbol) {
    alert('Provide mint or symbol.');
    return;
  }

  payload.weight = Number(payload.weight || 1);
  payload.sentiment = Number(payload.sentiment || 1);

  await api('/api/meme/social-signal', 'POST', payload);
  e.target.reset();
  refreshSocialSignals(true);
};

window.refreshSocialSignals = async (force = false) => {
  const now = Date.now();
  if (!force && now - lastSocialFetchAt < 5000) return;

  try {
    const r = await fetch('/api/meme/social-signals');
    if (!r.ok) return;
    const j = await r.json();
    socialSignals = Array.isArray(j.signals) ? j.signals : [];
    lastSocialFetchAt = Date.now();
    if (activeTab === 'meme') render();
  } catch (e) {
    console.error('social signals fetch failed', e);
  }
};

async function api(url, method, body) {
  try {
    const r = await fetch(url, { method, headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
    if (!r.ok) alert((await r.json()).error);
  } catch (e) { console.error(e); }
}

// Init
initTabs();
refreshSocialSignals(true);
const es = new EventSource('/api/stream');
es.onmessage = (e) => {
  currentState = JSON.parse(e.data);
  render();
};
