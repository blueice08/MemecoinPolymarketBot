const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { fetchMemeMarketsFromPump } = require('./pumpsource');

const SOURCE_URL = 'https://frontend-api-v3.pump.fun/homepage-cache/search?limit=1000&offset=0&includeNsfw=true&sortBy=price_change_24h&sortOrder=DESC';
const MIN_GAIN = Number(process.env.MIN_GAIN || 50);
const MIN_SCORE = Number(process.env.MIN_SCORE || 70);
const POSITION_SIZE = Number(process.env.POSITION_SIZE || 6);

// Auto-exit defaults
const TAKE_PROFIT_PCT = Number(process.env.TP_PCT || 30);
const STOP_LOSS_PCT = Number(process.env.SL_PCT || -15);
const MAX_HOLD_HOURS = Number(process.env.MAX_HOLD_HOURS || 6);
const SCAN_MODE = String(process.env.SCAN_MODE || 'full'); // full | entries_only | close_only

const SCORING_CONFIG_PATH = path.join(__dirname, 'data', 'meme_scoring_config.json');
const MIN_TUNING_SAMPLES = Number(process.env.MIN_TUNING_SAMPLES || 25);

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function httpJson(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: 8787,
      path,
      method,
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, data: data ? JSON.parse(data) : null });
        } catch {
          resolve({ statusCode: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function httpsJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error(`Invalid JSON from ${url}: ${err.message}`));
        }
      });
    }).on('error', reject);
  });
}

async function getState() {
  const res = await httpJson('GET', '/api/state');
  return res?.data || null;
}

async function postMemeStatus(status) {
  await httpJson('POST', '/api/meme/status', status);
}

function extractMintFromBet(bet) {
  const inv = String(bet?.invalidation || '');
  const mInv = inv.match(/mint:([A-Za-z0-9]+)/i);
  if (mInv) return mInv[1];

  const market = String(bet?.market || '');
  const mName = market.match(/\(([A-Za-z0-9]+)\)\s*$/);
  if (mName) return mName[1];

  return null;
}

async function fetchCoinMarkValue(mint) {
  const coin = await httpsJson(`https://frontend-api-v3.pump.fun/coins/${mint}`);
  const markValue = Number(coin?.usd_market_cap || coin?.market_cap || 0);
  return Number.isFinite(markValue) && markValue > 0 ? markValue : null;
}

async function postMemeBet(candidate) {
  const body = {
    market: candidate.title,
    side: 'LONG',
    entryOdds: candidate.markValue,
    size: POSITION_SIZE,
    confidence: `score:${candidate.score}`,
    thesis: `pump.fun scored-entry | score=${candidate.score} (M:${candidate.scoreParts.momentum} L:${candidate.scoreParts.liquidity} R:${candidate.scoreParts.risk} S:${candidate.scoreParts.social}) | mentions=${candidate.socialMeta?.trustedMentions || 0} | gain24h=${candidate.gain.toFixed(2)}%`,
    invalidation: `mint:${candidate.mint}`
  };
  return httpJson('POST', '/api/bets?ledger=meme', body);
}

async function updateMemeBet(betId, currentOdds, note) {
  return httpJson('PATCH', `/api/bets/${betId}?ledger=meme`, { currentOdds, note });
}

async function closeMemeBet(betId, exitOdds, note) {
  return httpJson('POST', `/api/bets/${betId}/close?ledger=meme`, { exitOdds, note });
}

function parseFactorsFromThesis(thesis = '') {
  const t = String(thesis || '');
  const rx = /M:([\d.]+)\s+L:([\d.]+)\s+R:([\d.]+)\s+S:([\d.]+)/i;
  const m = t.match(rx);
  if (!m) return null;
  return {
    momentum: Number(m[1]),
    liquidity: Number(m[2]),
    risk: Number(m[3]),
    social: Number(m[4])
  };
}

function safeWriteJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function optimizeScoringWeightsFromClosedBets(closedBets) {
  const parsed = closedBets
    .map((b) => {
      const factors = parseFactorsFromThesis(b.thesis);
      if (!factors) return null;
      const size = Number(b.size || 0);
      const realized = Number(b.realizedPnl || 0);
      if (!size || !Number.isFinite(realized)) return null;
      return {
        factors,
        ret: realized / size // return multiple
      };
    })
    .filter(Boolean);

  if (parsed.length < MIN_TUNING_SAMPLES) {
    return { ok: false, reason: `insufficient_samples:${parsed.length}` };
  }

  const keys = ['momentum', 'liquidity', 'risk', 'social'];
  const strengths = {};

  for (const k of keys) {
    let cov = 0;
    for (const row of parsed) {
      const x = (Number(row.factors[k] || 0) / 100) - 0.5;
      const y = clamp(row.ret, -1.5, 1.5);
      cov += x * y;
    }
    cov /= parsed.length;
    strengths[k] = cov;
  }

  // convert to positive weights with floor
  const floor = 0.08;
  const raw = {
    momentum: floor + Math.max(0, strengths.momentum * 6),
    liquidity: floor + Math.max(0, strengths.liquidity * 6),
    risk: floor + Math.max(0, strengths.risk * 6),
    social: floor + Math.max(0, strengths.social * 6)
  };

  const sum = raw.momentum + raw.liquidity + raw.risk + raw.social;
  const weights = {
    momentum: Number((raw.momentum / sum).toFixed(4)),
    liquidity: Number((raw.liquidity / sum).toFixed(4)),
    risk: Number((raw.risk / sum).toFixed(4)),
    social: Number((raw.social / sum).toFixed(4))
  };

  const payload = {
    updatedAt: new Date().toISOString(),
    sampleSize: parsed.length,
    strengths,
    weights,
    note: 'Phase C auto-tuned from closed trade outcomes'
  };

  safeWriteJson(SCORING_CONFIG_PATH, payload);
  return { ok: true, sampleSize: parsed.length, weights };
}

async function runOnce() {
  const runAt = new Date();
  let scanned = 0;
  let qualifying = 0;
  let posted = 0;
  let updated = 0;
  let closed = 0;
  let message = 'Runner started.';

  try {
    const state = await getState();
    const memeBets = state?.meme?.bets || [];
    const openBets = memeBets.filter((b) => b.status === 'open');
    let candidates = [];

    // 1) Discover/open entries unless this is close-only mode
    if (SCAN_MODE !== 'close_only') {
      candidates = await fetchMemeMarketsFromPump({
        url: SOURCE_URL,
        minGainPercent: MIN_GAIN,
        minScore: MIN_SCORE,
        limit: 10,
        maxAgeHours: 48
      });

      scanned = Array.isArray(candidates) ? candidates.length : 0;
      qualifying = scanned;

      const openMints = new Set(openBets.map(extractMintFromBet).filter(Boolean));
      const freshCandidates = (candidates || []).filter((c) => !openMints.has(c.mint));

      for (const c of freshCandidates) {
        try {
          const res = await postMemeBet(c);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            posted += 1;
            console.log(`[PUMP MVP] OPEN market='${c.title}' mint=${c.mint} score=${c.score} gain=${c.gain.toFixed(2)}% entry=${c.markValue}`);
          }
        } catch (e) {
          console.error('[PUMP MVP] Failed opening meme bet for', c.mint, e.message);
        }
      }
    }

    // 2) Mark-to-market + auto-close for existing open bets
    if (SCAN_MODE !== 'entries_only') {
      const refreshedState = await getState();
      const openAfterEntries = (refreshedState?.meme?.bets || []).filter((b) => b.status === 'open');

      for (const bet of openAfterEntries) {
        const mint = extractMintFromBet(bet);
        if (!mint) continue;

        try {
          const markValue = await fetchCoinMarkValue(mint);
          if (!markValue) continue;

          // mark update
          const prev = Number(bet.currentOdds || bet.entryOdds || 0);
          if (Math.abs(markValue - prev) > 1e-9) {
            const upd = await updateMemeBet(bet.id, markValue, 'auto-mark-from-pump-api');
            if (upd.statusCode >= 200 && upd.statusCode < 300) updated += 1;
          }

          // auto-close checks
          const entry = Number(bet.entryOdds || 0);
          if (!entry) continue;

          const pnlPct = ((markValue / entry) - 1) * 100;
          const ageMs = runAt.getTime() - new Date(bet.createdAt).getTime();
          const maxHoldMs = MAX_HOLD_HOURS * 60 * 60 * 1000;

          let reason = null;
          if (pnlPct >= TAKE_PROFIT_PCT) reason = `TP hit (${pnlPct.toFixed(2)}%)`;
          else if (pnlPct <= STOP_LOSS_PCT) reason = `SL hit (${pnlPct.toFixed(2)}%)`;
          else if (ageMs >= maxHoldMs) reason = `Max hold reached (${MAX_HOLD_HOURS}h)`;

          if (reason) {
            const cls = await closeMemeBet(bet.id, markValue, `auto-close: ${reason}`);
            if (cls.statusCode >= 200 && cls.statusCode < 300) {
              closed += 1;
              console.log(`[PUMP MVP] CLOSE market='${bet.market}' mint=${mint} reason="${reason}" exit=${markValue}`);
            }
          }
        } catch (e) {
          console.error('[PUMP MVP] Failed update/close for', mint, e.message);
        }
      }
    }

    // Phase C: auto-tune weights from closed trade outcomes (full cycle only)
    let tuning = { ok: false, reason: 'skipped' };
    if (SCAN_MODE === 'full') {
      const stateForTune = await getState();
      const closedForTune = (stateForTune?.meme?.bets || []).filter((b) => b.status === 'closed');
      tuning = optimizeScoringWeightsFromClosedBets(closedForTune);
      if (tuning.ok) {
        console.log(`[PUMP MVP] TUNER updated weights from ${tuning.sampleSize} samples`, tuning.weights);
      }
    }

    if (SCAN_MODE === 'close_only') {
      message = `Manual close-check complete. marked=${updated}, autoClosed=${closed}.`;
    } else if (!candidates || candidates.length === 0) {
      message = `No qualifying meme markets detected (gain>=${MIN_GAIN}% and score>=${MIN_SCORE}).`;
    } else if (SCAN_MODE === 'entries_only') {
      message = `Manual entries-only scan complete. qualifying=${qualifying}, opened=${posted}.`;
    } else {
      message = `Cycle complete. qualifying=${qualifying}, opened=${posted}, marked=${updated}, autoClosed=${closed}, tuning=${tuning.ok ? 'updated' : tuning.reason}.`;
    }

    await postMemeStatus({
      lastRunAt: runAt.toISOString(),
      source: SOURCE_URL,
      minGainPercent: MIN_GAIN,
      minScore: MIN_SCORE,
      scanned,
      qualifying,
      posted,
      updated,
      closed,
      takeProfitPct: TAKE_PROFIT_PCT,
      stopLossPct: STOP_LOSS_PCT,
      maxHoldHours: MAX_HOLD_HOURS,
      tuningSampleSize: Number(tuning.sampleSize || 0),
      tuningWeights: tuning.weights || null,
      message
    });
  } catch (e) {
    message = `Runner error: ${e.message || 'unknown error'}`;
    console.error('[PUMP MVP] Error during run', e);
    await postMemeStatus({
      lastRunAt: runAt.toISOString(),
      source: SOURCE_URL,
      minGainPercent: MIN_GAIN,
      minScore: MIN_SCORE,
      scanned,
      qualifying,
      posted,
      updated,
      closed,
      takeProfitPct: TAKE_PROFIT_PCT,
      stopLossPct: STOP_LOSS_PCT,
      maxHoldHours: MAX_HOLD_HOURS,
      message
    });
  }
}

function startScheduler() {
  runOnce();
  setInterval(runOnce, 15 * 60 * 1000);
}

if (process.argv.includes('--once')) {
  runOnce()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
} else {
  startScheduler();
}
