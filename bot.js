'use strict';
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const { dataPath, migrate } = require('./storage');
migrate();

// ─── FILE PATHS ───────────────────────────────────────────────────────────────
const F = {
  state:       dataPath('state.json'),
  trades:      dataPath('trades.json'),
  learning:    dataPath('learning.json'),
  weights:     dataPath('strategy-weights.json'),
  reports:     dataPath('reports.json'),
  config:      dataPath('config.json'),
  configLog:   dataPath('config-log.json'),
  backtest:    dataPath('backtest-results.json'),
  priceHistory:dataPath('price-history.json'),
};

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const ASSETS          = ['BTC', 'ETH'];
const CG_IDS          = { BTC: 'bitcoin', ETH: 'ethereum' };
const PAPER_STAKE     = 100;                       // £100 per trade
const MAX_HOLD_MS     = 10 * 24 * 60 * 60 * 1000; // 10 days
const POLL_MS         = 5 * 60 * 1000;             // 5 minutes
const INITIAL_CAPITAL = 1000;
const PAPER_MODE      = process.env.PAPER_MODE !== 'false'; // default true

// ─── PRICE DATA STORE ─────────────────────────────────────────────────────────
const pd = {};
for (const a of ASSETS)
  pd[a] = { closes: [], highs: [], lows: [], opens: [], volumes: [], timestamps: [] };

// ─── RUNTIME STATE ────────────────────────────────────────────────────────────
let state     = null;
let allTrades = [];

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function log(msg)    { console.log(`[${new Date().toISOString()}] ${msg}`); }
function uid()       { return Math.random().toString(36).slice(2, 10); }
function now()       { return new Date().toISOString(); }
function loadJSON(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function saveJSON(f, d) { try { fs.writeFileSync(f, JSON.stringify(d, null, 2)); } catch(e) { log(`Save error ${f}: ${e.message}`); } }
function delay(ms)   { return new Promise(r => setTimeout(r, ms)); }

// ─── STATE INIT ───────────────────────────────────────────────────────────────
function initPortfolios() {
  return {
    paper: {
      nav:      INITIAL_CAPITAL,
      cash:     INITIAL_CAPITAL,
      positions:[],
      peakNav:  INITIAL_CAPITAL,
      strategyStats: {
        breakout:    { peakNav: INITIAL_CAPITAL / 2, nav: INITIAL_CAPITAL / 2, drawdown: 0, suspended: false, suspendedAt: null, halfSize: false },
        emaPullback: { peakNav: INITIAL_CAPITAL / 2, nav: INITIAL_CAPITAL / 2, drawdown: 0, suspended: false, suspendedAt: null, halfSize: false },
      },
    },
  };
}

function initState() {
  return {
    portfolios:      initPortfolios(),
    regime:          'RISK_ON',
    regimeReason:    'Paper trading mode',
    regimeChangedAt: now(),
    killSwitch:      { triggered: false, triggeredAt: null, reason: null },
    allTimeHigh:     INITIAL_CAPITAL,
    equityCurve:     [],
    lastUpdate:      null,
    livePrices:      {},
    impliedVol:      null,
  };
}

// ─── HTTP UTILITIES ───────────────────────────────────────────────────────────
function httpsGet(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers: { Accept: 'application/json', ...extraHeaders } },
      res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
          resolve(data);
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

async function httpsGetJSON(url, extraHeaders = {}) {
  return JSON.parse(await httpsGet(url, extraHeaders));
}

// ─── COINGECKO DATA ───────────────────────────────────────────────────────────
async function fetchKlines(asset) {
  const id  = CG_IDS[asset];
  const url = `https://api.coingecko.com/api/v3/coins/${id}/ohlc?vs_currency=usd&days=90`;
  const headers = process.env.COINGECKO_API_KEY
    ? { 'x-cg-demo-api-key': process.env.COINGECKO_API_KEY }
    : {};
  try {
    const raw = await httpsGetJSON(url, headers);
    if (!Array.isArray(raw) || !raw.length) throw new Error('Empty response');

    const d = pd[asset];
    d.timestamps = raw.map(c => c[0]);
    d.opens      = raw.map(c => c[1]);
    d.highs      = raw.map(c => c[2]);
    d.lows       = raw.map(c => c[3]);
    d.closes     = raw.map(c => c[4]);
    // CoinGecko OHLC does not include volume

    const lastClose   = d.closes[d.closes.length - 1];
    const close24hAgo = d.closes.length >= 25 ? d.closes[d.closes.length - 25] : d.closes[0];
    const change24h   = close24hAgo > 0 ? ((lastClose - close24hAgo) / close24hAgo) * 100 : 0;

    state.livePrices[asset] = { price: lastClose, change24h };
    log(`[CG] ${asset}: ${raw.length} candles, price=${lastClose.toFixed(2)}, 24h=${change24h.toFixed(2)}%`);
    return true;
  } catch(e) {
    log(`[CG] ${asset} fetch error: ${e.message}`);
    return false;
  }
}

// ─── DERIBIT DVOL ─────────────────────────────────────────────────────────────
async function fetchDVOL() {
  try {
    const url = 'https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&resolution=3600&count=1';
    const data = await httpsGetJSON(url);
    const entry = data?.result?.data?.[0];
    if (entry) {
      const dvol = entry[4] != null ? entry[4] : entry[1];
      state.impliedVol = dvol / 100;
      log(`[DVOL] BTC implied vol: ${(state.impliedVol * 100).toFixed(1)}%`);
    }
  } catch(e) {
    log(`[DVOL] Error: ${e.message}`);
  }
}

function getCurrentPrice(asset) {
  return state.livePrices[asset]?.price ?? pd[asset].closes[pd[asset].closes.length - 1] ?? 0;
}

// ─── INDICATORS ───────────────────────────────────────────────────────────────
function emaFull(arr, period) {
  if (arr.length < period) return [];
  const k = 2 / (period + 1);
  const result = [];
  let val = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(val);
  for (let i = period; i < arr.length; i++) {
    val = arr[i] * k + val * (1 - k);
    result.push(val);
  }
  return result;
}

function emaLast(arr, period) {
  const full = emaFull(arr, period);
  return full.length ? full[full.length - 1] : null;
}

// ─── STRATEGY 1: BREAKOUT ────────────────────────────────────────────────────
// Entry: current candle closes above 20-period resistance (price only — no volume data)
// SL: 3% below entry  |  TP: 10% above entry  |  Max hold: 10 days
function breakoutSignal(asset) {
  const d = pd[asset];
  if (d.closes.length < 22) return false;

  // 20 candles before current (exclude current candle)
  const priorHighs = d.highs.slice(-21, -1);
  const resistance = Math.max(...priorHighs);
  const currentClose = d.closes[d.closes.length - 1];

  if (currentClose > resistance) {
    log(`[BREAKOUT] ${asset}: close ${currentClose.toFixed(2)} > resistance ${resistance.toFixed(2)}`);
    return true;
  }
  return false;
}

// ─── STRATEGY 2: EMA PULLBACK ─────────────────────────────────────────────────
// Uptrend: price > 50 EMA AND 200 EMA
// Entry: prev candle low ≤ 21 EMA AND current candle closes back above 21 EMA
// SL: 50 EMA at entry  |  TP: 8% above entry  |  Max hold: 10 days
function emaPullbackSignal(asset) {
  const d = pd[asset];
  if (d.closes.length < 201) return null;

  const currentClose = d.closes[d.closes.length - 1];
  const ema21        = emaLast(d.closes, 21);
  const ema50        = emaLast(d.closes, 50);
  const ema200       = emaLast(d.closes, 200);

  if (ema21 == null || ema50 == null || ema200 == null) return null;

  // Uptrend: price above both 50 EMA and 200 EMA
  if (currentClose <= ema50 || currentClose <= ema200) return null;

  // 21 EMA value at the close of the previous candle
  const prevCloses = d.closes.slice(0, -1);
  const prevEma21  = emaLast(prevCloses, 21);
  if (prevEma21 == null) return null;

  const prevLow = d.lows[d.lows.length - 2];

  // Pullback: prev candle low touched or pierced the 21 EMA
  // Bounce: current candle closes back above the 21 EMA
  if (prevLow <= prevEma21 && currentClose > ema21) {
    log(`[EMA_PULLBACK] ${asset}: prevLow ${prevLow.toFixed(2)} ≤ prevEMA21 ${prevEma21.toFixed(2)}, close ${currentClose.toFixed(2)} > EMA21 ${ema21.toFixed(2)}`);
    return { ema50 };
  }
  return null;
}

// ─── POSITION MANAGEMENT ──────────────────────────────────────────────────────
function openPosition(strategy, asset, stopLoss, takeProfit) {
  const port = state.portfolios.paper;

  // Max 1 open position per asset+strategy combination
  if (port.positions.find(p => p.asset === asset && p.strategy === strategy)) return null;

  const price = getCurrentPrice(asset);
  if (!price) return null;

  const qty      = PAPER_STAKE / price;
  const notional = PAPER_STAKE;

  const position = {
    id:         uid(),
    strategy,
    profile:    'paper',
    asset,
    side:       'LONG',
    entryPrice: price,
    qty,
    notional,
    stopLoss,
    takeProfit,
    openedAt:   now(),
  };

  port.positions.push(position);

  const tag = PAPER_MODE ? '[PAPER]' : '[TRADE]';
  log(`${tag} OPEN LONG ${asset} @${price.toFixed(4)} notional=£${notional} strategy=${strategy} SL=${stopLoss.toFixed(4)} TP=${takeProfit.toFixed(4)}`);
  return position;
}

function closePosition(posId, reason) {
  const port = state.portfolios.paper;
  const idx  = port.positions.findIndex(p => p.id === posId);
  if (idx === -1) return null;
  const pos  = port.positions[idx];

  const exitPrice = getCurrentPrice(pos.asset);
  if (!exitPrice) return null;

  const pnl      = (exitPrice - pos.entryPrice) * pos.qty;
  const pnlPct   = (pnl / pos.notional) * 100;
  const win      = pnl >= 0;
  const result   = pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'BREAKEVEN';
  const holdMins = (Date.now() - new Date(pos.openedAt).getTime()) / 60000;

  port.positions.splice(idx, 1);

  const closedTrade = {
    ...pos,
    exitPrice,
    pnl:                 +pnl.toFixed(4),
    pnlPct:              +pnlPct.toFixed(4),
    win,
    result,
    exitReason:          reason,
    closedAt:            now(),
    holdDurationMinutes: +holdMins.toFixed(0),
  };

  allTrades.push(closedTrade);

  const tag = PAPER_MODE ? '[PAPER]' : '[TRADE]';
  log(`${tag} CLOSE LONG ${pos.asset} @${exitPrice.toFixed(4)} P&L=£${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%) reason=${reason}`);
  return closedTrade;
}

// ─── CHECK STOPS AND MAX HOLD ─────────────────────────────────────────────────
function checkPositions() {
  const port    = state.portfolios.paper;
  const toClose = [];

  for (const pos of port.positions) {
    const price = getCurrentPrice(pos.asset);
    if (!price) continue;

    if (Date.now() - new Date(pos.openedAt).getTime() >= MAX_HOLD_MS) {
      toClose.push({ id: pos.id, reason: 'MAX_HOLD' });
    } else if (price <= pos.stopLoss) {
      toClose.push({ id: pos.id, reason: 'STOP_LOSS' });
    } else if (price >= pos.takeProfit) {
      toClose.push({ id: pos.id, reason: 'TAKE_PROFIT' });
    }
  }

  for (const { id, reason } of toClose) closePosition(id, reason);
}

// ─── STRATEGY RUNNER ──────────────────────────────────────────────────────────
function runStrategies() {
  for (const asset of ASSETS) {
    const price = getCurrentPrice(asset);
    if (!price) continue;

    // Strategy 1: Breakout with Volume
    if (breakoutSignal(asset)) {
      openPosition('breakout', asset, price * 0.97, price * 1.10);
    }

    // Strategy 2: EMA Pullback
    const pullback = emaPullbackSignal(asset);
    if (pullback) {
      openPosition('emaPullback', asset, pullback.ema50, price * 1.08);
    }
  }
}

// ─── NAV ──────────────────────────────────────────────────────────────────────
function updateNAV() {
  const port = state.portfolios.paper;
  let unrealised = 0;
  for (const pos of port.positions) {
    const cur = getCurrentPrice(pos.asset);
    if (cur) unrealised += (cur - pos.entryPrice) * pos.qty;
  }
  const closedPnl = allTrades.reduce((s, t) => s + t.pnl, 0);
  port.nav  = INITIAL_CAPITAL + closedPnl + unrealised;
  port.cash = port.nav - port.positions.reduce((s, p) => s + p.notional, 0);
  if (port.nav > port.peakNav)        port.peakNav        = port.nav;
  if (port.nav > state.allTimeHigh)   state.allTimeHigh   = port.nav;
}

function recordEquityCurve() {
  const nav = state.portfolios.paper.nav;
  state.equityCurve.push({ timestamp: now(), paper: nav, total: nav });
  if (state.equityCurve.length > 500) state.equityCurve = state.equityCurve.slice(-500);
}

// ─── MAIN TICK ────────────────────────────────────────────────────────────────
async function tick() {
  for (const asset of ASSETS) {
    await fetchKlines(asset);
    await delay(300);
  }

  checkPositions();
  runStrategies();
  updateNAV();
  recordEquityCurve();

  state.lastUpdate = now();
  saveJSON(F.state, state);
  saveJSON(F.trades, allTrades.slice(-1000));
  saveJSON(F.priceHistory, pd);

  const port = state.portfolios.paper;
  log(`[BOT] NAV=£${port.nav.toFixed(2)} | Open=${port.positions.length} | Trades=${allTrades.length}`);
}

// ─── STARTUP ──────────────────────────────────────────────────────────────────
async function start() {
  log('═══════════════════════════════════════════════════');
  log('      SWING BOT — Breakout + EMA Pullback');
  log(`      PAPER_MODE=${PAPER_MODE} | STAKE=£${PAPER_STAKE}`);
  log('═══════════════════════════════════════════════════');

  state     = loadJSON(F.state) || initState();
  allTrades = loadJSON(F.trades) || [];

  // Migrate old multi-profile state to new single paper portfolio
  if (!state.portfolios?.paper) {
    log('[BOT] New portfolio structure — resetting portfolios');
    state.portfolios  = initPortfolios();
    state.allTimeHigh = INITIAL_CAPITAL;
    state.equityCurve = [];
  }

  const savedPd = loadJSON(F.priceHistory);
  if (savedPd) {
    for (const asset of ASSETS) {
      if (savedPd[asset]?.closes?.length) pd[asset] = savedPd[asset];
    }
    log('[BOT] Price history restored from disk');
  }

  await tick();
  await fetchDVOL();

  setInterval(async () => {
    try { await tick(); }
    catch(e) { log(`[LOOP] Error: ${e.message}`); }
  }, POLL_MS);

  setInterval(async () => {
    try { await fetchDVOL(); saveJSON(F.state, state); }
    catch(e) { log(`[DVOL] Interval error: ${e.message}`); }
  }, 60 * 60 * 1000);

  log('[BOT] Running. Polling Binance every 5 minutes.');
}

start().catch(e => { console.error('[BOT] Fatal startup error:', e); process.exit(1); });
