const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 8787;
const STORE_PATH = path.join(__dirname, 'data', 'store.json');
const SOCIAL_SIGNALS_PATH = path.join(__dirname, 'data', 'meme_social_signals.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const clients = new Set();

function defaultMemeStatus() {
  return {
    lastRunAt: null,
    source: 'https://frontend-api-v3.pump.fun/homepage-cache/search?sortBy=price_change_24h',
    minGainPercent: 50,
    minScore: 70,
    scanned: 0,
    qualifying: 0,
    posted: 0,
    updated: 0,
    closed: 0,
    takeProfitPct: 30,
    stopLossPct: -15,
    maxHoldHours: 6,
    tuningSampleSize: 0,
    tuningWeights: null,
    message: 'Not started yet.'
  };
}

function readStore() {
  const raw = fs.readFileSync(STORE_PATH, 'utf8');
  let data = JSON.parse(raw);
  // Migration for old format (single root): wrap in 'polymarket' key if missing
  if (typeof data.bankrollStart === 'number' && !data.polymarket) {
    data = { polymarket: data, meme: { bankrollStart:1000, bankrollCash:1000, bets:[], activity:[] } };
  }
  if (!data.meme) data.meme = { bankrollStart:1000, bankrollCash:1000, bets:[], activity:[] };
  if (!data.memeStatus) data.memeStatus = defaultMemeStatus();
  return data;
}

function writeStore(store) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

function readSocialSignals() {
  try {
    if (!fs.existsSync(SOCIAL_SIGNALS_PATH)) return [];
    const raw = fs.readFileSync(SOCIAL_SIGNALS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.signals) ? parsed.signals : []);
  } catch {
    return [];
  }
}

function writeSocialSignals(signals) {
  fs.writeFileSync(SOCIAL_SIGNALS_PATH, JSON.stringify({ signals }, null, 2));
}

function cryptoId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function getLedger(store, type) {
  return (type === 'meme') ? store.meme : store.polymarket;
}

function calcMetrics(ledger) {
  const open = ledger.bets.filter(b => b.status === 'open');
  const closed = ledger.bets.filter(b => b.status === 'closed');

  const openCost = open.reduce((sum, b) => sum + b.size, 0);
  const openValue = open.reduce((sum, b) => sum + b.size * (b.currentOdds / b.entryOdds), 0);
  const unrealizedPnl = openValue - openCost;

  const realizedPnl = closed.reduce((sum, b) => sum + (b.realizedPnl || 0), 0);
  const equity = ledger.bankrollCash + openValue;

  const wins = closed.filter(b => (b.realizedPnl || 0) > 0).length;
  const winRate = closed.length ? (wins / closed.length * 100) : 0;

  // Drawdown helper
  const events = [{t:'start', eq: ledger.bankrollStart }];
  ledger.activity.slice().reverse().forEach(a => {
    if (a.type === 'bet_closed') events.push({ t: a.at, eq: a.payload?.equityAfter || null });
  });
  let peak = ledger.bankrollStart;
  let maxDD = 0;
  for (const e of events) {
    if (typeof e.eq === 'number') {
      peak = Math.max(peak, e.eq);
      const dd = peak===0 ? 0 : ((peak - e.eq)/peak)*100;
      maxDD = Math.max(maxDD, dd);
    }
  }

  return {
    bankrollStart: ledger.bankrollStart,
    bankrollCash: ledger.bankrollCash,
    equity,
    realizedPnl,
    unrealizedPnl,
    totalPnl: realizedPnl + unrealizedPnl,
    winRate,
    openCount: open.length,
    closedCount: closed.length,
    maxDrawdownPct: maxDD
  };
}

function addActivity(ledger, type, payload) {
  ledger.activity.unshift({
    id: cryptoId(),
    type,
    payload,
    at: new Date().toISOString()
  });
  ledger.activity = ledger.activity.slice(0, 500);
}

function payload(store) {
  return {
    polymarket: {
      metrics: calcMetrics(store.polymarket),
      bets: store.polymarket.bets,
      activity: store.polymarket.activity.slice(0, 50)
    },
    meme: {
      metrics: calcMetrics(store.meme),
      bets: store.meme.bets,
      activity: store.meme.activity.slice(0, 50)
    },
    memeStatus: store.memeStatus || defaultMemeStatus()
  };
}

function broadcast(store) {
  const msg = `data: ${JSON.stringify(payload(store))}\n\n`;
  for (const res of clients) res.write(msg);
}

// API
app.get('/api/state', (req, res) => {
  res.json(payload(readStore()));
});

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  clients.add(res);
  res.write(`data: ${JSON.stringify(payload(readStore()))}\n\n`);
  req.on('close', () => clients.delete(res));
});

// Create bet - accepts query param ?ledger=meme (default: polymarket)
app.post('/api/bets', (req, res) => {
  const ledgerName = (req.query.ledger === 'meme') ? 'meme' : 'polymarket';
  const { market, side, entryOdds, size, confidence='', thesis='', invalidation='' } = req.body;

  if (!market || !side || !entryOdds || !size) return res.status(400).json({error: 'market, side, entryOdds, size required'});

  const store = readStore();
  const ledger = getLedger(store, ledgerName);
  const amt = Number(size);
  const odds = Number(entryOdds);

  if (ledger.bankrollCash < amt) return res.status(400).json({error: 'Insufficient cash'});

  const bet = {
    id: cryptoId(),
    market,
    side,
    entryOdds: odds,
    currentOdds: odds,
    size: amt,
    confidence,
    thesis,
    invalidation,
    status: 'open',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  ledger.bankrollCash -= amt;
  ledger.bets.unshift(bet);
  addActivity(ledger, 'bet_opened', { betId: bet.id, market, side, size: amt, entryOdds: odds });

  writeStore(store);
  broadcast(store);
  res.status(201).json(bet);
});

// Update bet - needs ?ledger=meme if iterating over general ids?
// Better: search both if not specified, or force strictness. For now: accept ?ledger param.
app.patch('/api/bets/:id', (req, res) => {
  const ledgerName = (req.query.ledger === 'meme') ? 'meme' : 'polymarket';
  const { id } = req.params;
  const { currentOdds, confidence, note } = req.body;

  const store = readStore();
  const ledger = getLedger(store, ledgerName);
  const bet = ledger.bets.find(b => b.id === id && b.status === 'open');

  if (!bet) return res.status(404).json({error: 'Open bet not found'});

  if (currentOdds) bet.currentOdds = Number(currentOdds);
  if (confidence) bet.confidence = confidence;
  bet.updatedAt = new Date().toISOString();

  addActivity(ledger, 'bet_updated', {
    betId: id,
    market: bet.market,
    currentOdds: bet.currentOdds,
    note
  });

  writeStore(store);
  broadcast(store);
  res.json(bet);
});

app.post('/api/bets/:id/close', (req, res) => {
  const ledgerName = (req.query.ledger === 'meme') ? 'meme' : 'polymarket';
  const { id } = req.params;
  const { resolved, exitOdds, note } = req.body;

  const store = readStore();
  const ledger = getLedger(store, ledgerName);
  const bet = ledger.bets.find(b => b.id === id && b.status === 'open');

  if (!bet) return res.status(404).json({error: 'Open bet not found'});

  let payout = 0;
  if (typeof resolved === 'boolean') {
    payout = resolved ? (bet.size / bet.entryOdds) : 0;
  } else if (exitOdds) {
    payout = bet.size * (Number(exitOdds) / bet.entryOdds);
  } else {
    // Current odds close
    payout = bet.size * (bet.currentOdds / bet.entryOdds);
  }

  const realizedPnl = payout - bet.size;
  ledger.bankrollCash += payout;
  bet.status = 'closed';
  bet.closedAt = new Date().toISOString();
  bet.payout = payout;
  bet.realizedPnl = realizedPnl;

  const m = calcMetrics(ledger);
  addActivity(ledger, 'bet_closed', {
    betId: id,
    market: bet.market,
    payout,
    realizedPnl,
    equityAfter: m.equity,
    note
  });

  writeStore(store);
  broadcast(store);
  res.json(bet);
});

// Pump runner heartbeat/status
app.post('/api/meme/status', (req, res) => {
  const store = readStore();
  const incoming = req.body || {};
  store.memeStatus = {
    ...defaultMemeStatus(),
    ...(store.memeStatus || {}),
    ...incoming,
    lastRunAt: incoming.lastRunAt || new Date().toISOString()
  };
  writeStore(store);
  broadcast(store);
  res.json({ ok: true, memeStatus: store.memeStatus });
});

app.post('/api/meme/config', (req, res) => {
  const store = readStore();

  const incomingGain = req.body?.minGainPercent;
  const incomingScore = req.body?.minScore;

  const prev = store.memeStatus || defaultMemeStatus();
  const minGainPercent = incomingGain === undefined ? Number(prev.minGainPercent || 50) : Number(incomingGain);
  const minScore = incomingScore === undefined ? Number(prev.minScore || 70) : Number(incomingScore);

  if (!Number.isFinite(minGainPercent) || minGainPercent < 0) {
    return res.status(400).json({ error: 'minGainPercent must be a non-negative number.' });
  }
  if (!Number.isFinite(minScore) || minScore < 0 || minScore > 100) {
    return res.status(400).json({ error: 'minScore must be between 0 and 100.' });
  }

  store.memeStatus = {
    ...defaultMemeStatus(),
    ...prev,
    minGainPercent,
    minScore,
    message: `Config updated. Min gain: ${minGainPercent}% | Min score: ${minScore}`
  };

  writeStore(store);
  broadcast(store);
  res.json({ ok: true, memeStatus: store.memeStatus });
});

app.get('/api/meme/social-signals', (req, res) => {
  const signals = readSocialSignals();
  res.json({ ok: true, count: signals.length, signals: signals.slice(0, 200) });
});

app.post('/api/meme/social-signal', (req, res) => {
  const { mint = '', symbol = '', account = '', weight = 1, sentiment = 1, note = '' } = req.body || {};

  if (!mint && !symbol) {
    return res.status(400).json({ error: 'Provide mint or symbol.' });
  }
  if (!account) {
    return res.status(400).json({ error: 'account is required (trusted source handle).' });
  }

  const signals = readSocialSignals();
  const row = {
    id: cryptoId(),
    mint: String(mint || ''),
    symbol: String(symbol || '').toUpperCase(),
    account: String(account),
    weight: Number(weight || 1),
    sentiment: Number(sentiment || 1),
    note: String(note || ''),
    at: new Date().toISOString()
  };

  signals.unshift(row);
  const trimmed = signals.slice(0, 1000);
  writeSocialSignals(trimmed);

  // also log in meme activity
  const store = readStore();
  addActivity(store.meme, 'social_signal_added', {
    mint: row.mint,
    symbol: row.symbol,
    account: row.account,
    weight: row.weight,
    sentiment: row.sentiment
  });
  writeStore(store);
  broadcast(store);

  res.json({ ok: true, signal: row });
});

app.post('/api/meme/scan', (req, res) => {
  const store = readStore();
  const minGainPercent = Number(store?.memeStatus?.minGainPercent || 50);
  const minScore = Number(store?.memeStatus?.minScore || 70);

  const child = spawn(process.execPath, ['pump_runner.js', '--once'], {
    cwd: __dirname,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      MIN_GAIN: String(minGainPercent),
      MIN_SCORE: String(minScore),
      SCAN_MODE: 'entries_only'
    }
  });
  child.unref();

  store.memeStatus = {
    ...defaultMemeStatus(),
    ...(store.memeStatus || {}),
    message: `Manual scan requested (entries only, gain>=${minGainPercent}%, score>=${minScore}).`
  };
  writeStore(store);
  broadcast(store);

  res.json({ ok: true, started: true, minGainPercent, minScore, mode: 'entries_only' });
});

app.post('/api/meme/close-check', (req, res) => {
  const store = readStore();
  const minGainPercent = Number(store?.memeStatus?.minGainPercent || 50);
  const minScore = Number(store?.memeStatus?.minScore || 70);

  const child = spawn(process.execPath, ['pump_runner.js', '--once'], {
    cwd: __dirname,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      MIN_GAIN: String(minGainPercent),
      MIN_SCORE: String(minScore),
      SCAN_MODE: 'close_only'
    }
  });
  child.unref();

  store.memeStatus = {
    ...defaultMemeStatus(),
    ...(store.memeStatus || {}),
    message: 'Manual close-check requested (no new entries).'
  };
  writeStore(store);
  broadcast(store);

  res.json({ ok: true, started: true, mode: 'close_only' });
});

// Reset ledger(s): /api/reset?ledger=polymarket|meme|all
app.post('/api/reset', (req, res) => {
  const ledgerName = String(req.query.ledger || 'all').toLowerCase();
  const store = readStore();

  const defaultLedger = {
    bankrollStart: 1000,
    bankrollCash: 1000,
    bets: [],
    activity: []
  };

  if (ledgerName === 'all') {
    store.polymarket = { ...defaultLedger };
    store.meme = { ...defaultLedger };
    store.memeStatus = defaultMemeStatus();
    writeSocialSignals([]);
  } else if (ledgerName === 'meme') {
    store.meme = { ...defaultLedger };
    store.memeStatus = defaultMemeStatus();
    writeSocialSignals([]);
  } else if (ledgerName === 'polymarket') {
    store.polymarket = { ...defaultLedger };
  } else {
    return res.status(400).json({ error: 'Invalid ledger. Use polymarket, meme, or all.' });
  }

  writeStore(store);
  broadcast(store);
  res.json({ ok: true, reset: ledgerName });
});

app.listen(PORT, () => console.log(`Dashboard running on http://localhost:${PORT}`));
