# Polymarket Sim Dashboard (v1)

Realtime paper-trading dashboard for tracking simulated Polymarket bets.

## Features

- $1,000 default stress-test bankroll
- Create / update / close simulated bets
- Realtime updates via SSE (`/api/stream`)
- Metrics: cash, equity, realized/unrealized PnL, win rate, max drawdown
- Open/closed bets table
- Activity log
- Persistent JSON storage in `data/store.json`

## Run

```bash
npm install
npm start
```

Open: `http://localhost:8787`

## Dev

```bash
npm run dev
```

## API

- `GET /api/state`
- `GET /api/stream`
- `POST /api/bets`
- `PATCH /api/bets/:id`
- `POST /api/bets/:id/close`

### Example create bet

```json
{
  "market": "Will BTC be above 120k by Mar 31?",
  "side": "YES",
  "entryOdds": 0.52,
  "size": 40,
  "confidence": "medium-high",
  "thesis": "Momentum + ETF inflow",
  "invalidation": "Macro shock"
}
```
