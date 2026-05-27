'use strict';
const https = require('https');
const http  = require('http');
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
    optionsSignal: {
      side:             null,
      totalStake:       0,
      weightedAvgPrice: null,
      pyramidLevel:     0,
      signalBuffer:     [],
      entryTime:        null,
      waitingForReentry:  false,
      reentryDirection: null,
    },
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

function httpsPost(url, bodyObj) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = JSON.stringify(bodyObj);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Accept: 'application/json' } },
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
    req.write(payload);
    req.end();
  });
}

async function httpsPostJSON(url, bodyObj) {
  return JSON.parse(await httpsPost(url, bodyObj));
}

function localGet(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: 'localhost', port: 8080, path: urlPath, method: 'GET' },
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
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
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
    const data = await httpsPostJSON('https://www.deribit.com/api/v2/public/get_volatility_index_data', {
      jsonrpc: '2.0', id: 2, method: 'public/get_volatility_index_data',
      params: { currency: 'BTC', start_timestamp: Date.now() - 3600000, end_timestamp: Date.now(), resolution: '3600' },
    });
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
  const os = state.optionsSignal;
  if (os?.side && os.weightedAvgPrice && os.totalStake) {
    const cur = getCurrentPrice('BTC');
    if (cur) {
      const qty = os.totalStake / os.weightedAvgPrice;
      unrealised += os.side === 'LONG'
        ? (cur - os.weightedAvgPrice) * qty
        : (os.weightedAvgPrice - cur) * qty;
    }
  }
  const closedPnl = allTrades.reduce((s, t) => s + t.pnl, 0);
  port.nav  = INITIAL_CAPITAL + closedPnl + unrealised;
  port.cash = port.nav
    - port.positions.reduce((s, p) => s + p.notional, 0)
    - (os?.side ? (os.totalStake || 0) : 0);
  if (port.nav > port.peakNav)        port.peakNav        = port.nav;
  if (port.nav > state.allTimeHigh)   state.allTimeHigh   = port.nav;
}

function recordEquityCurve() {
  const nav = state.portfolios.paper.nav;
  state.equityCurve.push({ timestamp: now(), paper: nav, total: nav });
  if (state.equityCurve.length > 500) state.equityCurve = state.equityCurve.slice(-500);
}

// ─── STRATEGY 3: OPTIONS SIGNAL ──────────────────────────────────────────────
async function fetchForecast() {
  try {
    return JSON.parse(await localGet('/api/forecast'));
  } catch(e) {
    log(`[OPTIONS_SIGNAL] Forecast fetch error: ${e.message}`);
    return null;
  }
}

function openOptionsPosition(side, price, stake) {
  const os            = state.optionsSignal;
  os.side             = side;
  os.totalStake       = stake;
  os.weightedAvgPrice = price;
  os.pyramidLevel     = 0;
  os.entryTime        = now();
  log(`[PAPER] OPTIONS_SIGNAL OPEN ${side} BTC @${price.toFixed(2)} stake=£${stake}`);
}

function closeOptionsPosition(price, reason) {
  const os = state.optionsSignal;
  if (!os.side) return null;

  const qty      = os.totalStake / os.weightedAvgPrice;
  const rawPnl   = os.side === 'LONG'
    ? (price - os.weightedAvgPrice) * qty
    : (os.weightedAvgPrice - price) * qty;
  const pnlPct   = (rawPnl / os.totalStake) * 100;
  const holdMins = (Date.now() - new Date(os.entryTime).getTime()) / 60000;

  allTrades.push({
    id:                  uid(),
    strategy:            'optionsSignal',
    profile:             'paper',
    asset:               'BTC',
    side:                os.side,
    entryPrice:          os.weightedAvgPrice,
    qty,
    notional:            os.totalStake,
    pyramidLevel:        os.pyramidLevel,
    openedAt:            os.entryTime,
    exitPrice:           price,
    pnl:                 +rawPnl.toFixed(4),
    pnlPct:              +pnlPct.toFixed(4),
    win:                 rawPnl >= 0,
    result:              rawPnl > 0 ? 'WIN' : rawPnl < 0 ? 'LOSS' : 'BREAKEVEN',
    exitReason:          reason,
    closedAt:            now(),
    holdDurationMinutes: +holdMins.toFixed(0),
  });

  log(`[PAPER] OPTIONS_SIGNAL CLOSE ${os.side} BTC @${price.toFixed(2)} P&L=£${rawPnl.toFixed(2)} (${pnlPct.toFixed(2)}%) reason=${reason}`);

  const prevSide      = os.side;
  os.side             = null;
  os.totalStake       = 0;
  os.weightedAvgPrice = null;
  os.pyramidLevel     = 0;
  os.entryTime        = null;
  return prevSide;
}

async function runOptionsSignal() {
  const forecast = await fetchForecast();
  if (!forecast || forecast.P_up == null || forecast.P_down == null) return;

  const { P_up, P_down } = forecast;
  const price = getCurrentPrice('BTC');
  if (!price) return;

  const os = state.optionsSignal;

  if (os.side && !os.totalStake) {
    log('[OPTIONS_SIGNAL] State corruption detected — resetting side/pyramidLevel');
    os.side         = null;
    os.pyramidLevel = 0;
  }

  os.signalBuffer.push({ P_up, P_down });
  if (os.signalBuffer.length > 5) os.signalBuffer = os.signalBuffer.slice(-5);

  let confirmed = null;
  if (os.signalBuffer.length === 5) {
    if (os.signalBuffer.every(r => r.P_up > r.P_down))  confirmed = 'BUY';
    if (os.signalBuffer.every(r => r.P_down > r.P_up))  confirmed = 'SHORT';
  }

  log(`[OPTIONS_SIGNAL] P_up=${(P_up*100).toFixed(1)}% P_down=${(P_down*100).toFixed(1)}% confirmed=${confirmed} side=${os.side || 'none'} pyramid=${os.pyramidLevel}`);

  if (os.side) {
    // Stop loss
    const stopHit = os.side === 'LONG'
      ? price < os.weightedAvgPrice * 0.95
      : price > os.weightedAvgPrice * 1.05;

    if (stopHit) {
      const stoppedSide      = closeOptionsPosition(price, 'STOP_LOSS');
      os.waitingForReentry   = true;
      os.reentryDirection    = stoppedSide;
      return;
    }

    // Signal flip
    if (os.side === 'LONG' && confirmed === 'SHORT') {
      closeOptionsPosition(price, 'SIGNAL_FLIP');
      os.waitingForReentry = false;
      os.reentryDirection  = null;
      openOptionsPosition('SHORT', price, 100);
      return;
    }
    if (os.side === 'SHORT' && confirmed === 'BUY') {
      closeOptionsPosition(price, 'SIGNAL_FLIP');
      os.waitingForReentry = false;
      os.reentryDirection  = null;
      openOptionsPosition('LONG', price, 100);
      return;
    }

    // Pyramid
    const unrealisedPct = os.side === 'LONG'
      ? (price - os.weightedAvgPrice) / os.weightedAvgPrice
      : (os.weightedAvgPrice - price) / os.weightedAvgPrice;

    for (const { threshold, level, addStake } of [
      { threshold: 0.05, level: 1, addStake: 200 },
      { threshold: 0.10, level: 2, addStake: 400 },
      { threshold: 0.15, level: 3, addStake: 800 },
    ]) {
      if (unrealisedPct >= threshold && os.pyramidLevel < level) {
        os.weightedAvgPrice = (os.totalStake * os.weightedAvgPrice + addStake * price)
                            / (os.totalStake + addStake);
        os.totalStake      += addStake;
        os.pyramidLevel     = level;
        log(`[OPTIONS_SIGNAL] PYRAMID L${level} ${os.side} BTC @${price.toFixed(2)} +£${addStake} total=£${os.totalStake}`);
        break;
      }
    }

  } else {
    // No open position — check entry
    if (os.waitingForReentry) {
      if (os.reentryDirection === 'LONG'  && confirmed === 'BUY')   { openOptionsPosition('LONG',  price, 100); os.waitingForReentry = false; os.reentryDirection = null; }
      if (os.reentryDirection === 'SHORT' && confirmed === 'SHORT') { openOptionsPosition('SHORT', price, 100); os.waitingForReentry = false; os.reentryDirection = null; }
    } else {
      if (confirmed === 'BUY')   openOptionsPosition('LONG',  price, 100);
      if (confirmed === 'SHORT') openOptionsPosition('SHORT', price, 100);
    }
  }
}

// ─── MAIN TICK ────────────────────────────────────────────────────────────────
async function tick() {
  for (const asset of ASSETS) {
    await fetchKlines(asset);
    await delay(300);
  }

  checkPositions();
  runStrategies();
  await runOptionsSignal();
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
  log('      SWING BOT — Breakout + EMA Pullback + OptionsSignal');
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

  // Migrate: ensure optionsSignal state exists
  if (!state.optionsSignal) {
    state.optionsSignal = {
      side: null, totalStake: 0, weightedAvgPrice: null, pyramidLevel: 0,
      signalBuffer: [], entryTime: null, waitingForReentry: false, reentryDirection: null,
    };
  }

  // One-time NAV reset for OptionsSignal strategy launch
  if (!state.optionsSignalReset) {
    const existing = loadJSON(F.trades) || [];
    if (existing.length) {
      const archivePath = dataPath(`trades-archive-${Date.now()}.json`);
      saveJSON(archivePath, existing);
      log(`[BOT] Archived ${existing.length} trades → ${path.basename(archivePath)}`);
    }
    allTrades                            = [];
    state.portfolios.paper.nav           = INITIAL_CAPITAL;
    state.portfolios.paper.cash          = INITIAL_CAPITAL;
    state.portfolios.paper.positions     = [];
    state.allTimeHigh                    = INITIAL_CAPITAL;
    state.equityCurve                    = [];
    state.optionsSignalReset             = true;
    log('[BOT] NAV reset to £1000 for OptionsSignal strategy launch');
  }

  log('[OPTIONS_SIGNAL] Resetting state on startup — signal buffer will rebuild within 25 minutes');
  state.optionsSignal.side = null;
  state.optionsSignal.totalStake = 0;
  state.optionsSignal.pyramidLevel = 0;
  state.optionsSignal.signalBuffer = [];
  saveJSON(F.state, state);

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
