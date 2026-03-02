const https = require('https');
const fs = require('fs');
const path = require('path');

const SOCIAL_SIGNALS_PATH = path.join(__dirname, 'data', 'meme_social_signals.json');
const SCORING_CONFIG_PATH = path.join(__dirname, 'data', 'meme_scoring_config.json');

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
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

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function normalize(v, min, max) {
  if (!Number.isFinite(v)) return 0;
  if (max <= min) return 0;
  return clamp((v - min) / (max - min), 0, 1);
}

function loadSocialSignals() {
  try {
    if (!fs.existsSync(SOCIAL_SIGNALS_PATH)) return [];
    const raw = fs.readFileSync(SOCIAL_SIGNALS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.signals) ? parsed.signals : []);
    return arr;
  } catch {
    return [];
  }
}

function defaultWeights() {
  return { momentum: 0.35, liquidity: 0.30, risk: 0.20, social: 0.15 };
}

function loadScoringConfig() {
  try {
    if (!fs.existsSync(SCORING_CONFIG_PATH)) {
      return { weights: defaultWeights(), sampleSize: 0, updatedAt: null };
    }
    const raw = fs.readFileSync(SCORING_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const w = parsed?.weights || {};
    const merged = {
      momentum: Number.isFinite(Number(w.momentum)) ? Number(w.momentum) : defaultWeights().momentum,
      liquidity: Number.isFinite(Number(w.liquidity)) ? Number(w.liquidity) : defaultWeights().liquidity,
      risk: Number.isFinite(Number(w.risk)) ? Number(w.risk) : defaultWeights().risk,
      social: Number.isFinite(Number(w.social)) ? Number(w.social) : defaultWeights().social
    };
    const sum = merged.momentum + merged.liquidity + merged.risk + merged.social;
    if (sum <= 0) return { weights: defaultWeights(), sampleSize: 0, updatedAt: null };
    return {
      weights: {
        momentum: merged.momentum / sum,
        liquidity: merged.liquidity / sum,
        risk: merged.risk / sum,
        social: merged.social / sum
      },
      sampleSize: Number(parsed?.sampleSize || 0),
      updatedAt: parsed?.updatedAt || null
    };
  } catch {
    return { weights: defaultWeights(), sampleSize: 0, updatedAt: null };
  }
}

function computeSocialSignalBoost(coin, signals, nowMs) {
  const mint = String(coin?.mint || '');
  const symbol = String(coin?.symbol || '').toUpperCase();
  const matched = signals.filter((s) => {
    const sMint = String(s?.mint || '');
    const sSymbol = String(s?.symbol || '').toUpperCase();
    return (sMint && sMint === mint) || (sSymbol && sSymbol === symbol);
  });

  // Recency-decayed trusted mention score in [0,1]
  let weighted = 0;
  for (const s of matched) {
    const ts = Number(new Date(s?.at || s?.timestamp || 0).getTime());
    if (!Number.isFinite(ts) || ts <= 0) continue;
    const ageH = (nowMs - ts) / (1000 * 60 * 60);
    if (ageH < 0 || ageH > 24) continue;

    const decay = 1 - (ageH / 24); // linear decay over 24h
    const weight = Number(s?.weight || 1);
    const sentiment = Number.isFinite(Number(s?.sentiment)) ? Number(s?.sentiment) : 1; // -1..1
    weighted += weight * sentiment * decay;
  }

  const boost = clamp(weighted / 4, 0, 1);
  return {
    boost,
    mentions: matched.length
  };
}

function scoreCoin(c, socialSignals = [], weights = defaultWeights(), now = Date.now()) {
  const p24 = Number(c.price_change_24h || 0);
  const p1h = Number(c.price_change_1h || 0);
  const p5m = Number(c.price_change_5m || 0);

  const mcap = Number(c.usd_market_cap || c.market_cap || 0);
  const v24 = Number(c.volume_24h || 0);
  const v1h = Number(c.volume_1h || 0);
  const v5m = Number(c.volume_5m || 0);

  const ageMin = Number.isFinite(Number(c.created_timestamp))
    ? (now - Number(c.created_timestamp)) / 60000
    : 60;

  // Momentum (0-100)
  const momentum = (
    normalize(p24, 20, 400) * 0.55 +
    normalize(p1h, 3, 80) * 0.30 +
    normalize(p5m, 0.5, 20) * 0.15
  ) * 100;

  // Liquidity/execution (0-100)
  const liquidity = (
    normalize(mcap, 20000, 1500000) * 0.45 +
    normalize(v1h, 5000, 400000) * 0.35 +
    normalize(v24, 20000, 1500000) * 0.20
  ) * 100;

  // Stability/risk proxy (0-100)
  const volToCap = mcap > 0 ? (v24 / mcap) : 0;
  const ageScore = clamp(ageMin / 30, 0, 1); // prefer >30 min old
  const turnoverScore = clamp(1 - Math.abs(volToCap - 1.8) / 1.8, 0, 1); // sweet-spot around ~1.8x
  const risk = (ageScore * 0.55 + turnoverScore * 0.45) * 100;

  // Phase B: social component
  const socialProxy = (
    normalize(Number(c.reply_count || 0), 0, 30) * 0.45 +
    normalize(v5m, 500, 50000) * 0.35 +
    (c.is_currently_live ? 0.20 : 0)
  );

  const trusted = computeSocialSignalBoost(c, socialSignals, now);
  const social = (socialProxy * 0.6 + trusted.boost * 0.4) * 100;

  // Final weighted score (Phase B/C)
  const total =
    momentum * Number(weights.momentum || 0) +
    liquidity * Number(weights.liquidity || 0) +
    risk * Number(weights.risk || 0) +
    social * Number(weights.social || 0);

  return {
    total,
    parts: {
      momentum: Number(momentum.toFixed(2)),
      liquidity: Number(liquidity.toFixed(2)),
      risk: Number(risk.toFixed(2)),
      social: Number(social.toFixed(2))
    },
    socialMeta: {
      trustedMentions: trusted.mentions,
      trustedBoost: Number((trusted.boost * 100).toFixed(2))
    },
    weightsUsed: {
      momentum: Number((weights.momentum || 0).toFixed(4)),
      liquidity: Number((weights.liquidity || 0).toFixed(4)),
      risk: Number((weights.risk || 0).toFixed(4)),
      social: Number((weights.social || 0).toFixed(4))
    }
  };
}

/**
 * Phase B selector:
 * - hard gates for basic quality
 * - deterministic score (0-100) from market + social signals
 */
async function fetchMemeMarketsFromPump(opts = {}) {
  const {
    minGainPercent = 50,
    minScore = 70,
    limit = 10,
    maxAgeHours = 48,
    minAgeMinutes = 5,
    includeNsfw = true,
    url = `https://frontend-api-v3.pump.fun/homepage-cache/search?limit=1000&offset=0&includeNsfw=${String(includeNsfw)}&sortBy=price_change_24h&sortOrder=DESC`
  } = opts;

  const rows = await getJson(url);
  if (!Array.isArray(rows)) return [];

  const now = Date.now();
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  const minAgeMs = minAgeMinutes * 60 * 1000;
  const socialSignals = loadSocialSignals();
  const scoringConfig = loadScoringConfig();

  const candidates = rows
    // hard gates
    .filter((c) => Number.isFinite(Number(c?.price_change_24h)))
    .filter((c) => Number(c.price_change_24h) >= minGainPercent)
    .filter((c) => Number(c.usd_market_cap || c.market_cap || 0) >= 5000)
    .filter((c) => Number(c.volume_1h || 0) >= 1000)
    .filter((c) => {
      const ts = Number(c?.created_timestamp || 0);
      if (!Number.isFinite(ts) || ts <= 0) return false;
      const age = now - ts;
      return age >= minAgeMs && age <= maxAgeMs;
    })
    .map((c) => {
      const score = scoreCoin(c, socialSignals, scoringConfig.weights, now);
      return {
        title: `${c.symbol || c.name || 'Unknown'} (${c.mint})`,
        mint: c.mint,
        gain: Number(c.price_change_24h),
        markValue: Number(c.usd_market_cap || c.market_cap || 0),
        created_timestamp: c.created_timestamp,
        url: `https://pump.fun/coin/${c.mint}`,
        score: Number(score.total.toFixed(2)),
        scoreParts: score.parts,
        socialMeta: score.socialMeta,
        scoring: {
          weights: score.weightsUsed,
          sampleSize: Number(scoringConfig.sampleSize || 0),
          updatedAt: scoringConfig.updatedAt || null
        },
        stats: {
          mcap: Number(c.usd_market_cap || c.market_cap || 0),
          volume1h: Number(c.volume_1h || 0),
          volume24h: Number(c.volume_24h || 0),
          change1h: Number(c.price_change_1h || 0),
          change5m: Number(c.price_change_5m || 0),
          replyCount: Number(c.reply_count || 0)
        }
      };
    })
    .filter((c) => c.score >= minScore)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return Number(b.created_timestamp || 0) - Number(a.created_timestamp || 0);
    })
    .slice(0, limit);

  return candidates;
}

module.exports = { fetchMemeMarketsFromPump };