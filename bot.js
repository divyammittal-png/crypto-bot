'use strict';
// ══════════════════════════════════════════════════════════════════════════════
// APEX BOT — Hedge Fund Grade Autonomous Trading System
// ══════════════════════════════════════════════════════════════════════════════
const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { /* optional */ }
const ai = (Anthropic && process.env.ANTHROPIC_API_KEY)
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

// ─── FILE PATHS ────────────────────────────────────────────────────────────────
const F = {
  state:    path.join(__dirname, 'state.json'),
  trades:   path.join(__dirname, 'trades.json'),
  learning: path.join(__dirname, 'learning.json'),
  sentiment:path.join(__dirname, 'sentiment.json'),
  weights:  path.join(__dirname, 'strategy-weights.json'),
  reports:  path.join(__dirname, 'reports.json'),
  config:   path.join(__dirname, 'config.json'),
  configLog:path.join(__dirname, 'config-log.json'),
  backtest: path.join(__dirname, 'backtest-results.json'),
  avCache:  path.join(__dirname, 'av-cache.json'),
};

// ─── ASSET UNIVERSE ───────────────────────────────────────────────────────────
const CLASSES = {
  crypto:      ['BTC','ETH','SOL','BNB','XRP'],
  equities:    ['AAPL','TSLA','NVDA','SPY','AMZN','MSFT','GOOGL','META','NFLX','JPM','QQQ'],
  commodities: ['GC=F','SI=F','CL=F','NG=F'],
};
const ALL_ASSETS = [...CLASSES.crypto, ...CLASSES.equities, ...CLASSES.commodities];
const ASSET_CLASS = {};
for (const [cls, arr] of Object.entries(CLASSES)) arr.forEach(a => ASSET_CLASS[a] = cls);

const CG_IDS = { BTC:'bitcoin',ETH:'ethereum',SOL:'solana',BNB:'binancecoin',XRP:'ripple' };

// Alpha Vantage — commodity futures mapped to liquid ETF proxies for GLOBAL_QUOTE
const AV_COMMODITY_PROXY = { 'GC=F':'GLD', 'SI=F':'SLV', 'CL=F':'USO', 'NG=F':'UNG' };
const AV_DAILY_LIMIT  = 25;
const AV_CALL_GAP_MS  = 13_000; // free tier: 5 req/min → 12s gap + 1s buffer

// ─── STAT-ARB PAIRS ──────────────────────────────────────────────────────────
const PAIRS = [
  ['BTC','ETH'],['BTC','SOL'],
  ['AAPL','MSFT'],['GOOGL','META'],
  ['NVDA','SPY'],
  ['GC=F','SI=F'],['CL=F','NG=F'],
];

// ─── RISK PROFILES ────────────────────────────────────────────────────────────
const PROFILES = {
  aggressive:   { capital:333, kelly:0.75, maxRisk:0.030, tp:0.09, sl:0.030, maxHeat:0.70 },
  balanced:     { capital:334, kelly:0.50, maxRisk:0.010, tp:0.06, sl:0.020, maxHeat:0.50 },
  conservative: { capital:333, kelly:0.25, maxRisk:0.005, tp:0.03, sl:0.010, maxHeat:0.30 },
};

// ─── DEFAULT CONFIG ───────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  strategyWeights: { ptj:1, statArb:1, multiFactor:1, allWeather:1 },
  rsiPeriod:14, rsiOversold:35, rsiOverbought:65,
  emaFast:9, emaSlow:21, bbPeriod:20, bbStdDev:2.0,
  macdFast:12, macdSlow:26, riskReward:3,
  maxTradeRisk:1.0, kellyFraction:50,
  killSwitchThreshold:-20, maxPortfolioHeat:60, cashBuffer:20,
  cryptoMax:40, equitiesMax:50, commoditiesMax:30,
  enabledAssets: Object.fromEntries(ALL_ASSETS.map(a => [a, true])),
};

// ─── PRICE DATA STORE ─────────────────────────────────────────────────────────
const MAX_CANDLES = 1500;
const pd = {};
for (const a of ALL_ASSETS) pd[a] = { closes:[], highs:[], lows:[], opens:[], volumes:[], timestamps:[] };

// ─── RUNTIME STATE ────────────────────────────────────────────────────────────
let state       = null;
let allTrades   = [];
let learningData= [];
let sentimentData = {};
let strategyWeights = {};
let reports     = [];
let config      = { ...DEFAULT_CONFIG };

let lastSentimentUpdate  = 0;
let lastRegimeUpdate     = 0;
let lastLearningCycle    = 0;
let lastMultiFactorReb   = 0;
let lastAllWeatherReb    = 0;
// Alpha Vantage on-disk cache — persists across restarts to protect daily budget
let avCache = { data:{}, dailyCalls:0, dailyDate:'' };

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ──────────────────────────────────────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────────────────────────────────────
function log(msg)    { console.log(`[${new Date().toISOString()}] ${msg}`); }
function uid()       { return Math.random().toString(36).slice(2,10); }
function now()       { return new Date().toISOString(); }
function loadJSON(f) { try { return JSON.parse(fs.readFileSync(f,'utf8')); } catch { return null; } }
function saveJSON(f, d) { try { fs.writeFileSync(f, JSON.stringify(d,null,2)); } catch(e) { log(`Save error ${f}: ${e.message}`); } }
function delay(ms)   { return new Promise(r => setTimeout(r, ms)); }
function clamp(v,mn,mx) { return Math.min(Math.max(v,mn),mx); }

// ─── STATE INIT ───────────────────────────────────────────────────────────────
function initState() {
  const portfolios = {};
  for (const [name, p] of Object.entries(PROFILES)) {
    const perStrat = p.capital / 4;
    portfolios[name] = {
      nav: p.capital, cash: p.capital, positions: [],
      peakNav: p.capital,
      strategyStats: {
        ptj:         { peakNav:perStrat, nav:perStrat, drawdown:0, suspended:false, suspendedAt:null, halfSize:false },
        statArb:     { peakNav:perStrat, nav:perStrat, drawdown:0, suspended:false, suspendedAt:null, halfSize:false },
        multiFactor: { peakNav:perStrat, nav:perStrat, drawdown:0, suspended:false, suspendedAt:null, halfSize:false },
        allWeather:  { peakNav:perStrat, nav:perStrat, drawdown:0, suspended:false, suspendedAt:null, halfSize:false },
      },
    };
  }
  return {
    portfolios,
    regime: 'RISK_ON',
    regimeReason: 'Initialising',
    regimeChangedAt: now(),
    killSwitch: { triggered:false, triggeredAt:null, reason:null },
    allTimeHigh: 1000,
    equityCurve: [],
    lastUpdate: null,
    livePrices: {},
  };
}

function initWeights() {
  const w = {};
  for (const profile of Object.keys(PROFILES))
    for (const strat of ['ptj','statArb','multiFactor','allWeather'])
      w[`${strat}_${profile}`] = 0.25;
  return w;
}

// ──────────────────────────────────────────────────────────────────────────────
// HTTP UTILITIES
// ──────────────────────────────────────────────────────────────────────────────
function httpsGet(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: { 'User-Agent': UA, 'Accept': 'application/json', ...opts.headers },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        try { resolve({ body: data, headers: res.headers, status: res.statusCode }); }
        catch { resolve({ body: data, headers: res.headers, status: res.statusCode }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

async function httpsGetJSON(url, opts = {}) {
  const { body } = await httpsGet(url, opts);
  return JSON.parse(body);
}

// ──────────────────────────────────────────────────────────────────────────────
// DATA FETCHING — CoinGecko (crypto) + Alpha Vantage (equities/commodities)
// ──────────────────────────────────────────────────────────────────────────────

// ─── ALPHA VANTAGE BUDGET HELPERS ─────────────────────────────────────────────
function avKey() { return process.env.ALPHA_VANTAGE_KEY || ''; }

function avBudgetOk() {
  const today = new Date().toISOString().slice(0, 10);
  if (avCache.dailyDate !== today) { avCache.dailyCalls = 0; avCache.dailyDate = today; }
  return avCache.dailyCalls < AV_DAILY_LIMIT;
}

function avRecordCall() {
  const today = new Date().toISOString().slice(0, 10);
  if (avCache.dailyDate !== today) { avCache.dailyCalls = 0; avCache.dailyDate = today; }
  avCache.dailyCalls++;
  saveJSON(F.avCache, avCache);
  log(`[AV] Budget: ${avCache.dailyCalls}/${AV_DAILY_LIMIT} calls used today`);
}

// Cache is fresh if fetched within the last hour
function avCacheFresh(asset) {
  const entry = avCache.data?.[asset];
  return !!(entry && (Date.now() - entry.fetchedAt) < 3_600_000);
}

// Copy candle array into the pd[asset] in-memory store
function loadIntoPd(asset, candles) {
  if (!candles?.length) return;
  const d = pd[asset];
  d.timestamps = candles.map(c => c.ts);
  d.opens      = candles.map(c => c.open);
  d.highs      = candles.map(c => c.high);
  d.lows       = candles.map(c => c.low);
  d.closes     = candles.map(c => c.close);
  d.volumes    = candles.map(c => c.volume ?? 0);
}

// ─── COINGECKO: LIVE TICKER ───────────────────────────────────────────────────
async function fetchCoinGeckoLive() {
  try {
    const ids = Object.values(CG_IDS).join(',');
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&sparkline=false`;
    const headers = {};
    if (process.env.COINGECKO_API_KEY) headers['x-cg-demo-api-key'] = process.env.COINGECKO_API_KEY;
    const data = await httpsGetJSON(url, { headers });
    for (const item of data) {
      const symbol = Object.keys(CG_IDS).find(k => CG_IDS[k] === item.id);
      if (!symbol) continue;
      state.livePrices[symbol] = {
        price:     item.current_price,
        change24h: item.price_change_percentage_24h || 0,
        high24h:   item.high_24h,
        low24h:    item.low_24h,
        marketCap: item.market_cap,
        volume24h: item.total_volume,
      };
    }
    log(`[CG] Live prices updated for ${Object.keys(CG_IDS).join(',')}`);
  } catch(e) { log(`[CG] Live fetch error: ${e.message}`); }
}

// ─── COINGECKO: HISTORICAL OHLC (4h candles, 90 days) ────────────────────────
async function fetchCGOHLC(asset) {
  const id = CG_IDS[asset];
  if (!id) return false;
  try {
    const headers = {};
    if (process.env.COINGECKO_API_KEY) headers['x-cg-demo-api-key'] = process.env.COINGECKO_API_KEY;
    const data = await httpsGetJSON(
      `https://api.coingecko.com/api/v3/coins/${id}/ohlc?vs_currency=usd&days=90`,
      { headers }
    );
    if (!Array.isArray(data) || data.length === 0) throw new Error('Empty OHLC response');
    const candles = data
      .map(([ts, o, h, l, c]) => ({ ts, open:o, high:h, low:l, close:c, volume:0 }))
      .slice(-MAX_CANDLES);
    loadIntoPd(asset, candles);
    log(`[CG] ${asset} OHLC: ${candles.length} 4h-candles loaded`);
    return true;
  } catch(e) {
    log(`[CG] ${asset} OHLC error: ${e.message}`);
    return false;
  }
}

// ─── SHARED: raw GLOBAL_QUOTE API call ───────────────────────────────────────
async function _doGlobalQuoteFetch(avSym) {
  const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(avSym)}&apikey=${avKey()}`;
  const data = await httpsGetJSON(url);
  if (data.Note || data.Information) {
    log(`[AV] GLOBAL_QUOTE ${avSym}: ${(data.Note || data.Information).slice(0, 80)}`);
    return null;
  }
  const q = data['Global Quote'];
  if (!q?.['05. price']) return null;
  return {
    price:  +q['05. price'],
    open:   +q['02. open']   || +q['05. price'],
    high:   +q['03. high']   || +q['05. price'],
    low:    +q['04. low']    || +q['05. price'],
    volume: +q['06. volume'] || 0,
    chgPct: parseFloat(q['10. change percent']) || 0,
  };
}

// ─── SHARED: restore a cached last-close snapshot into live state + pd ────────
// Called on restart and whenever intraday data is unavailable.
function _restoreLastClose(asset, entry) {
  if (!entry?.fallbackPrice) return;
  state.livePrices[asset] = {
    price:       entry.fallbackPrice,
    change24h:   entry.chgPct  || 0,
    high24h:     entry.high    || entry.fallbackPrice,
    low24h:      entry.low     || entry.fallbackPrice,
    isLastClose: true,
  };
  // Inject one synthetic candle so getCurrentPrice() returns a non-zero value
  if (pd[asset].closes.length === 0) {
    const d = pd[asset];
    const ts = entry.fetchedAt || Date.now();
    d.timestamps.push(ts);
    d.opens.push(entry.fallbackPrice);
    d.highs.push(entry.high  || entry.fallbackPrice);
    d.lows.push( entry.low   || entry.fallbackPrice);
    d.closes.push(entry.fallbackPrice);
    d.volumes.push(0);
  }
  log(`[AV] ${asset}: restored last close $${entry.fallbackPrice.toFixed(2)} from cache (isLastClose)`);
}

// ─── SHARED: fetch GLOBAL_QUOTE, persist to cache, restore into state ─────────
// Used both as commodity primary fetch and as equity intraday fallback.
async function _applyGlobalQuoteFallback(asset, avSym) {
  if (!avBudgetOk() || !avKey()) return false;
  try {
    const quote = await _doGlobalQuoteFetch(avSym);
    if (!quote) return false;
    const entry = {
      fetchedAt:     Date.now(),
      fallbackPrice: quote.price,
      high:          quote.high,
      low:           quote.low,
      chgPct:        quote.chgPct,
      avSym,
      isLastClose:   true,
    };
    avCache.data[asset] = entry;
    avRecordCall();
    _restoreLastClose(asset, entry);
    return true;
  } catch(e) {
    log(`[AV] ${asset} GLOBAL_QUOTE fallback error: ${e.message}`);
    return false;
  }
}

// ─── ALPHA VANTAGE: EQUITIES — TIME_SERIES_INTRADAY 60min ────────────────────
async function fetchAVIntraday(asset) {
  // Fresh cache — load candles or restore last-close snapshot
  if (avCacheFresh(asset)) {
    const entry = avCache.data[asset];
    if (entry?.candles) {
      loadIntoPd(asset, entry.candles);
      // Re-populate livePrices if state was reset (e.g. fresh restart loaded state.json)
      if (!state.livePrices[asset]?.price) {
        const last   = entry.candles[entry.candles.length - 1];
        const prev24 = entry.candles[Math.max(0, entry.candles.length - 25)];
        state.livePrices[asset] = {
          price:       last.close,
          change24h:   prev24.close > 0 ? (last.close - prev24.close) / prev24.close * 100 : 0,
          high24h:     Math.max(...entry.candles.slice(-24).map(c => c.high)),
          low24h:      Math.min(...entry.candles.slice(-24).map(c => c.low)),
          isLastClose: false,
        };
      }
    } else if (entry?.fallbackPrice) {
      _restoreLastClose(asset, entry);
    }
    return true;
  }

  // Budget exhausted — serve whatever cache we have
  if (!avBudgetOk()) {
    log(`[AV] Budget exhausted (${avCache.dailyCalls}/${AV_DAILY_LIMIT}) — using cached data for ${asset}`);
    const entry = avCache.data[asset];
    if (entry?.candles)       loadIntoPd(asset, entry.candles);
    else if (entry?.fallbackPrice) _restoreLastClose(asset, entry);
    return false;
  }
  if (!avKey()) { log(`[AV] ALPHA_VANTAGE_KEY not set — skipping ${asset}`); return false; }

  try {
    const url = `https://www.alphavantage.co/query?function=TIME_SERIES_INTRADAY&symbol=${asset}&interval=60min&outputsize=full&apikey=${avKey()}`;
    const data = await httpsGetJSON(url);

    // AV rate-limit or auth error
    if (data.Note || data.Information) {
      log(`[AV] ${asset} API message: ${(data.Note || data.Information).slice(0, 100)}`);
      const entry = avCache.data[asset];
      if (entry?.candles)            loadIntoPd(asset, entry.candles);
      else if (entry?.fallbackPrice) _restoreLastClose(asset, entry);
      else if (avBudgetOk()) {
        log(`[AV] ${asset}: rate-limited + no cache, trying GLOBAL_QUOTE fallback`);
        await delay(AV_CALL_GAP_MS);
        await _applyGlobalQuoteFallback(asset, asset);
      }
      return false;
    }

    const series = data['Time Series (60min)'];
    if (!series) throw new Error(`Unexpected response keys: ${Object.keys(data).join(', ')}`);

    const candles = Object.entries(series)
      .map(([dt, v]) => ({
        ts:     new Date(dt).getTime(),
        open:   +v['1. open'],
        high:   +v['2. high'],
        low:    +v['3. low'],
        close:  +v['4. close'],
        volume: +v['5. volume'],
      }))
      .filter(c => c.close > 0 && !isNaN(c.close))
      .sort((a, b) => a.ts - b.ts)
      .slice(-MAX_CANDLES);

    if (candles.length === 0) throw new Error('No valid candles after parsing');

    avCache.data[asset] = { candles, fetchedAt: Date.now() };
    avRecordCall();
    loadIntoPd(asset, candles);

    const last   = candles[candles.length - 1];
    const prev24 = candles[Math.max(0, candles.length - 25)];
    state.livePrices[asset] = {
      price:       last.close,
      change24h:   prev24.close > 0 ? (last.close - prev24.close) / prev24.close * 100 : 0,
      high24h:     Math.max(...candles.slice(-24).map(c => c.high)),
      low24h:      Math.min(...candles.slice(-24).map(c => c.low)),
      isLastClose: false,
    };
    log(`[AV] ${asset}: ${candles.length} candles, last=$${last.close.toFixed(2)}`);
    return true;
  } catch(e) {
    log(`[AV] ${asset} intraday error: ${e.message}`);
    const entry = avCache.data[asset];
    if (entry?.candles) {
      loadIntoPd(asset, entry.candles);
    } else if (entry?.fallbackPrice) {
      _restoreLastClose(asset, entry);
    } else {
      // No cache at all (first run on a weekend/holiday) — fetch last close via GLOBAL_QUOTE
      log(`[AV] ${asset}: no cache available, falling back to GLOBAL_QUOTE for last close`);
      await delay(AV_CALL_GAP_MS);
      await _applyGlobalQuoteFallback(asset, asset);
    }
    return false;
  }
}

// ─── ALPHA VANTAGE: COMMODITIES — GLOBAL_QUOTE ───────────────────────────────
// Commodity futures are mapped to their ETF proxies (GC=F→GLD, etc.)
// GLOBAL_QUOTE returns a single snapshot; we accumulate a price history over time.
async function fetchAVGlobalQuote(asset) {
  const avSym = AV_COMMODITY_PROXY[asset];
  if (!avSym) return false;

  // Fresh cache — ensure livePrices is populated in case state was reset
  if (avCacheFresh(asset)) {
    if (avCache.data[asset]?.fallbackPrice) _restoreLastClose(asset, avCache.data[asset]);
    return true;
  }

  if (!avBudgetOk()) {
    log(`[AV] Budget exhausted (${avCache.dailyCalls}/${AV_DAILY_LIMIT}) — keeping last price for ${asset}`);
    if (avCache.data[asset]?.fallbackPrice) _restoreLastClose(asset, avCache.data[asset]);
    return false;
  }
  if (!avKey()) { log(`[AV] ALPHA_VANTAGE_KEY not set — skipping ${asset}`); return false; }

  try {
    const quote = await _doGlobalQuoteFetch(avSym);
    if (!quote) throw new Error('Empty Global Quote response');

    // Append snapshot to running price history (builds indicators over time)
    const d = pd[asset];
    d.timestamps.push(Date.now());
    d.opens.push(quote.open); d.highs.push(quote.high); d.lows.push(quote.low);
    d.closes.push(quote.price); d.volumes.push(quote.volume);
    for (const k of ['closes','highs','lows','opens','volumes','timestamps'])
      if (d[k].length > MAX_CANDLES) d[k] = d[k].slice(-MAX_CANDLES);

    // Persist enough data to _restoreLastClose can reconstruct price on restart
    avCache.data[asset] = {
      fetchedAt:     Date.now(),
      fallbackPrice: quote.price,
      high:          quote.high,
      low:           quote.low,
      chgPct:        quote.chgPct,
      avSym,
      isLastClose:   true,
    };
    avRecordCall();

    state.livePrices[asset] = {
      price:       quote.price,
      change24h:   quote.chgPct,
      high24h:     quote.high,
      low24h:      quote.low,
      isLastClose: true,
    };
    log(`[AV] ${asset} (${avSym}): $${quote.price.toFixed(2)} ${quote.chgPct >= 0 ? '+' : ''}${quote.chgPct.toFixed(2)}%`);
    return true;
  } catch(e) {
    log(`[AV] ${asset} quote error: ${e.message}`);
    if (avCache.data[asset]?.fallbackPrice) _restoreLastClose(asset, avCache.data[asset]);
    return false;
  }
}

// ─── REFRESH ORCHESTRATION ────────────────────────────────────────────────────

// Startup: walk all equities then commodities, respecting budget and 1h cache TTL.
// Stale cache from a previous run is loaded first — avoids wasting calls on restart.
async function startupFetch() {
  if (!avKey()) {
    log('[AV] ALPHA_VANTAGE_KEY not set — equity/commodity price data will be unavailable');
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  log(`[AV] Startup fetch — ${avCache.dailyCalls}/${AV_DAILY_LIMIT} calls used today (${today})`);

  for (const asset of CLASSES.equities) {
    await fetchAVIntraday(asset);
    if (!avCacheFresh(asset)) await delay(AV_CALL_GAP_MS); // only pause after a live API call
  }
  for (const asset of CLASSES.commodities) {
    await fetchAVGlobalQuote(asset);
    if (!avCacheFresh(asset)) await delay(AV_CALL_GAP_MS);
  }
  log(`[AV] Startup fetch complete — budget remaining: ${AV_DAILY_LIMIT - avCache.dailyCalls}`);
}

// Crypto refresh: CoinGecko live prices + OHLC history
async function refreshCrypto() {
  await fetchCoinGeckoLive();
  for (const asset of CLASSES.crypto) {
    await fetchCGOHLC(asset);
    await delay(2000);
  }
}

// Rolling AV refresh: pick the single stalest non-crypto asset and refresh it.
// One call per invocation — naturally caps daily usage well within 25/day.
async function rollingAvRefresh() {
  if (!avBudgetOk()) {
    log(`[AV] Daily budget exhausted (${avCache.dailyCalls}/${AV_DAILY_LIMIT}) — no refresh this cycle`);
    return;
  }
  const nonCrypto = [...CLASSES.equities, ...CLASSES.commodities];
  let stale = null, oldestFetch = Infinity;
  for (const asset of nonCrypto) {
    const fetched = avCache.data?.[asset]?.fetchedAt ?? 0;
    if (fetched < oldestFetch) { oldestFetch = fetched; stale = asset; }
  }
  if (!stale) return;
  const ageMin = Math.floor((Date.now() - oldestFetch) / 60_000);
  if (ageMin < 60) { log(`[AV] All caches fresh — oldest is ${stale} at ${ageMin}min`); return; }

  log(`[AV] Rolling refresh: ${stale} (${ageMin}min old)`);
  if (CLASSES.equities.includes(stale)) await fetchAVIntraday(stale);
  else await fetchAVGlobalQuote(stale);
}

function getCurrentPrice(asset) {
  return state.livePrices[asset]?.price || pd[asset].closes[pd[asset].closes.length - 1] || 0;
}

// ──────────────────────────────────────────────────────────────────────────────
// TECHNICAL INDICATORS
// ──────────────────────────────────────────────────────────────────────────────
function sma(arr, period) {
  if (arr.length < period) return null;
  const s = arr.slice(-period);
  return s.reduce((a, b) => a + b, 0) / period;
}

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

function ema(arr, period) {
  const full = emaFull(arr, period);
  return full.length ? full[full.length - 1] : null;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const recent = closes.slice(-(period * 3 + 1));
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = recent[i] - recent[i - 1];
    if (diff > 0) avgGain += diff / period;
    else avgLoss += (-diff) / period;
  }
  for (let i = period + 1; i < recent.length; i++) {
    const diff = recent[i] - recent[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function bollingerBands(closes, period = 20, stdDevMult = 2) {
  if (closes.length < period) return null;
  const s = closes.slice(-period);
  const mid = s.reduce((a, b) => a + b, 0) / period;
  const variance = s.reduce((a, b) => a + (b - mid) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return {
    upper: mid + stdDevMult * std,
    middle: mid,
    lower: mid - stdDevMult * std,
    bandwidth: std > 0 ? (stdDevMult * 2 * std) / mid : 0,
    std,
  };
}

function atr(highs, lows, closes, period = 14) {
  const len = Math.min(highs.length, lows.length, closes.length);
  if (len < period + 1) return null;
  const h = highs.slice(-len), l = lows.slice(-len), c = closes.slice(-len);
  const trs = [];
  for (let i = 1; i < h.length; i++)
    trs.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i-1]), Math.abs(l[i] - c[i-1])));
  let atrVal = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++)
    atrVal = (atrVal * (period - 1) + trs[i]) / period;
  return atrVal;
}

function adx(highs, lows, closes, period = 14) {
  const len = Math.min(highs.length, lows.length, closes.length);
  if (len < period * 3) return null;
  const h = highs.slice(-len), l = lows.slice(-len), c = closes.slice(-len);
  const trs=[], dmp=[], dmm=[];
  for (let i = 1; i < h.length; i++) {
    const up = h[i] - h[i-1], dn = l[i-1] - l[i];
    dmp.push(up > dn && up > 0 ? up : 0);
    dmm.push(dn > up && dn > 0 ? dn : 0);
    trs.push(Math.max(h[i]-l[i], Math.abs(h[i]-c[i-1]), Math.abs(l[i]-c[i-1])));
  }
  let sTR = trs.slice(0,period).reduce((a,b)=>a+b,0);
  let sDMP = dmp.slice(0,period).reduce((a,b)=>a+b,0);
  let sDMM = dmm.slice(0,period).reduce((a,b)=>a+b,0);
  const dxArr = [];
  for (let i = period; i < trs.length; i++) {
    sTR  = sTR  - sTR/period  + trs[i];
    sDMP = sDMP - sDMP/period + dmp[i];
    sDMM = sDMM - sDMM/period + dmm[i];
    const diP = sTR>0 ? 100*sDMP/sTR : 0;
    const diM = sTR>0 ? 100*sDMM/sTR : 0;
    dxArr.push((diP+diM)>0 ? 100*Math.abs(diP-diM)/(diP+diM) : 0);
  }
  if (dxArr.length < period) return null;
  let adxVal = dxArr.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for (let i = period; i < dxArr.length; i++) adxVal = (adxVal*(period-1)+dxArr[i])/period;
  return adxVal;
}

function macd(closes, fast=12, slow=26, signal=9) {
  if (closes.length < slow + signal) return null;
  const fastEma = emaFull(closes, fast);
  const slowEma = emaFull(closes, slow);
  const len = Math.min(fastEma.length, slowEma.length);
  const macdLine = [];
  for (let i = 0; i < len; i++)
    macdLine.push(fastEma[fastEma.length-len+i] - slowEma[slowEma.length-len+i]);
  if (macdLine.length < signal) return null;
  const sigEma = emaFull(macdLine, signal);
  const sigVal = sigEma[sigEma.length-1];
  const macdVal = macdLine[macdLine.length-1];
  return { macd: macdVal, signal: sigVal, histogram: macdVal - sigVal };
}

function roc(closes, period=14) {
  if (closes.length < period + 1) return null;
  const prev = closes[closes.length - period - 1];
  return prev ? ((closes[closes.length-1] - prev) / prev) * 100 : 0;
}

function zscore(series, period=20) {
  if (series.length < period) return null;
  const s = series.slice(-period);
  const mean = s.reduce((a,b)=>a+b,0) / period;
  const std  = Math.sqrt(s.reduce((a,b)=>a+(b-mean)**2,0) / period);
  if (std === 0) return 0;
  return (s[s.length-1] - mean) / std;
}

function rollingVolatility(closes, period=20) {
  if (closes.length < period+1) return null;
  const returns = [];
  for (let i = closes.length-period; i < closes.length; i++)
    returns.push(Math.log(closes[i] / closes[i-1]));
  const mean = returns.reduce((a,b)=>a+b,0)/period;
  const std  = Math.sqrt(returns.reduce((a,b)=>a+(b-mean)**2,0)/period);
  return std * Math.sqrt(252 * 24); // annualised from hourly
}

// ─── BB SIGNAL HELPERS ────────────────────────────────────────────────────────
function bbSignal(asset, cfg) {
  const d = pd[asset];
  if (d.closes.length < cfg.bbPeriod) return { boost:0, position:'none' };
  const bb = bollingerBands(d.closes, cfg.bbPeriod, cfg.bbStdDev);
  const price = getCurrentPrice(asset);
  const rsiVal = rsi(d.closes, cfg.rsiPeriod) || 50;
  let boost = 0, position = 'middle';

  // Squeeze
  const isSqueeze = bb && bb.bandwidth < 0.10;

  if (bb) {
    if (price <= bb.lower) { position = 'lower'; if (rsiVal < cfg.rsiOversold) boost += 0.20; }
    else if (price >= bb.upper) { position = 'upper'; if (rsiVal > cfg.rsiOverbought) boost -= 0.20; }
    else if (price > bb.middle) position = 'above_mid';
    else position = 'below_mid';

    // Squeeze breakout
    if (isSqueeze) {
      if (price > bb.upper) boost += 0.10;
      if (price < bb.lower) boost -= 0.10;
    }
  }
  return { boost, position, bb, isSqueeze };
}

// ──────────────────────────────────────────────────────────────────────────────
// STRATEGY 1 — PTJ TREND
// ──────────────────────────────────────────────────────────────────────────────
function ptjSignal(asset, cfg) {
  const d = pd[asset];
  if (d.closes.length < 210) return 'HOLD'; // need ~200 candles for daily SMA

  // Daily: every 24 hourly candles = 1 day
  // Use all hourly closes as proxy (1h data, SMA200 = ~8 days in hourly candles)
  // For proper daily SMA200, we'd need 200 daily candles = 4800 hourly
  // We approximate: use available closes, SMA200 of hourly
  const sma200  = sma(d.closes, 200);
  const ema20   = ema(d.closes, 20);
  const ema50   = ema(d.closes, 50);
  const rsiVal  = rsi(d.closes, cfg.rsiPeriod);
  const prevRsi = d.closes.length > cfg.rsiPeriod+2 ? rsi(d.closes.slice(0,-1), cfg.rsiPeriod) : rsiVal;
  const price   = getCurrentPrice(asset);

  if (!sma200 || !ema20 || !ema50 || rsiVal == null) return 'HOLD';

  const uptrend  = price > sma200;
  const downtrend = price < sma200;
  const bullMomentum = ema20 > ema50;
  const bearMomentum = ema20 < ema50;

  // RSI crossing above 40 in uptrend
  const rsiBuyEntry  = prevRsi < cfg.rsiOversold  && rsiVal >= cfg.rsiOversold  && uptrend  && bullMomentum;
  // RSI crossing below 60 in downtrend
  const rsiShortEntry = prevRsi > cfg.rsiOverbought && rsiVal <= cfg.rsiOverbought && downtrend && bearMomentum;

  const { boost } = bbSignal(asset, cfg);

  if (rsiBuyEntry)  return boost >= 0 ? 'BUY'   : 'HOLD';
  if (rsiShortEntry) return boost <= 0 ? 'SHORT' : 'HOLD';
  return 'HOLD';
}

// ──────────────────────────────────────────────────────────────────────────────
// STRATEGY 2 — RENAISSANCE STAT-ARB
// ──────────────────────────────────────────────────────────────────────────────
function statArbSignals(cfg) {
  const signals = [];
  for (const [assetA, assetB] of PAIRS) {
    const dA = pd[assetA], dB = pd[assetB];
    const minLen = 25;
    if (dA.closes.length < minLen || dB.closes.length < minLen) continue;

    const len = Math.min(dA.closes.length, dB.closes.length, 100);
    const spread = [];
    for (let i = dA.closes.length - len; i < dA.closes.length; i++) {
      const idxB = i - (dA.closes.length - dB.closes.length);
      if (idxB >= 0 && idxB < dB.closes.length)
        spread.push(dA.closes[i] / dB.closes[idxB]);
    }

    const z = zscore(spread, 20);
    if (z == null) continue;

    if (z > 2.0)  signals.push({ assetA, assetB, side:'A_SHORT_B_LONG',  zscore:z });
    if (z < -2.0) signals.push({ assetA, assetB, side:'A_LONG_B_SHORT',  zscore:z });
    if (Math.abs(z) < 0.3) signals.push({ assetA, assetB, side:'EXIT', zscore:z });
  }
  return signals;
}

// ──────────────────────────────────────────────────────────────────────────────
// STRATEGY 3 — CITADEL MULTI-FACTOR
// ──────────────────────────────────────────────────────────────────────────────
function multiFactor_score(asset, cfg) {
  const d = pd[asset];
  if (d.closes.length < 50) return null;
  const price = getCurrentPrice(asset);
  const rsiVal = rsi(d.closes, cfg.rsiPeriod) || 50;
  const rocVal = roc(d.closes, 14) || 0;
  const atrVal = atr(d.highs, d.lows, d.closes, 14) || 1;
  const adxVal = adx(d.highs, d.lows, d.closes, 14) || 0;

  const avgVol = d.volumes.length >= 20
    ? d.volumes.slice(-20).reduce((a,b)=>a+b,0)/20 : 0;
  const curVol = d.volumes[d.volumes.length-1] || 0;

  // Factor 1: Momentum (0-20)
  const momentumScore = clamp((rsiVal/100)*10 + clamp(rocVal/2,0,10), 0, 20);

  // Factor 2: Volume (0-20)
  const volScore = avgVol > 0 ? clamp((curVol/avgVol)*10, 0, 20) : 10;

  // Factor 3: Volatility inverse (0-20) — low vol = high score
  const normalAtr = price > 0 ? atrVal / price : 0;
  const volAtility = clamp(20 - normalAtr * 2000, 0, 20);

  // Factor 4: Trend Strength ADX (0-20)
  const trendScore = clamp(adxVal / 5, 0, 20);

  // Factor 5: Relative Strength (0-20)
  const classAssets = CLASSES[ASSET_CLASS[asset]];
  const classReturns = classAssets
    .filter(a => pd[a].closes.length >= 24)
    .map(a => { const c = pd[a].closes; return (c[c.length-1] - c[c.length-25]) / c[c.length-25] * 100; });
  const avgClassReturn = classReturns.length ? classReturns.reduce((a,b)=>a+b,0)/classReturns.length : 0;
  const myReturn = d.closes.length >= 24
    ? (d.closes[d.closes.length-1] - d.closes[d.closes.length-25]) / d.closes[d.closes.length-25] * 100 : 0;
  const relStr = clamp(10 + (myReturn - avgClassReturn) * 2, 0, 20);

  const total = momentumScore + volScore + volAtility + trendScore + relStr;
  return { total, momentumScore, volScore, volAtility, trendScore, relStr };
}

function multiFactorSignals(cfg) {
  const signals = {};
  for (const [cls, assets] of Object.entries(CLASSES)) {
    const scored = [];
    for (const asset of assets) {
      const score = multiFactor_score(asset, cfg);
      if (score !== null) scored.push({ asset, ...score });
    }
    scored.sort((a, b) => b.total - a.total);
    const top3    = scored.slice(0, 3).map(s => ({ asset:s.asset, signal:'BUY',   score:s.total }));
    const bottom3 = scored.slice(-3).map(s => ({ asset:s.asset, signal:'SHORT', score:s.total }));
    for (const s of [...top3, ...bottom3]) signals[s.asset] = s;
  }
  return signals;
}

// ──────────────────────────────────────────────────────────────────────────────
// STRATEGY 4 — BRIDGEWATER ALL-WEATHER
// ──────────────────────────────────────────────────────────────────────────────
function allWeatherTargets(cfg, regime) {
  let buckets = {
    crypto:      { target:0.25, assets: CLASSES.crypto },
    equities:    { target:0.40, assets: CLASSES.equities },
    commodities: { target:0.25, assets: CLASSES.commodities },
    cash:        { target:0.10, assets: [] },
  };

  // Risk-Off: shift 20% from equities to gold + cash
  if (regime === 'RISK_OFF') {
    buckets.equities.target   -= 0.20;
    buckets.commodities.target += 0.10;
    buckets.cash.target        += 0.10;
  }
  // Stagflation: favour commodities, reduce crypto
  if (regime === 'STAGFLATION') {
    buckets.commodities.target += 0.10;
    buckets.crypto.target      -= 0.05;
    buckets.equities.target    -= 0.05;
  }

  const targets = {};
  for (const [bName, b] of Object.entries(buckets)) {
    if (b.assets.length === 0) continue;

    // Risk parity within bucket: allocate inversely proportional to 30d vol
    const vols = b.assets.map(a => {
      const v = rollingVolatility(pd[a].closes, 30);
      return { asset:a, vol: v || 0.01 };
    });
    const totalInvVol = vols.reduce((s, v) => s + 1/v.vol, 0);

    for (const { asset, vol } of vols) {
      let weight = (1/vol / totalInvVol) * b.target;
      weight = Math.min(weight, 0.15); // max 15% per asset
      targets[asset] = weight;
    }
  }
  return targets;
}

// ──────────────────────────────────────────────────────────────────────────────
// MACRO REGIME DETECTION
// ──────────────────────────────────────────────────────────────────────────────
function detectRegime() {
  const spyCloses  = pd['SPY'].closes;
  const goldCloses = pd['GC=F'].closes;
  const oilCloses  = pd['CL=F'].closes;

  if (spyCloses.length < 200) return { regime: state.regime, reason: 'Insufficient data' };

  const spyNow   = spyCloses[spyCloses.length-1];
  const spy200   = sma(spyCloses, 200);
  const spyVol   = rollingVolatility(spyCloses, 20) || 0;

  // Gold 30d momentum
  const goldMom = goldCloses.length >= 720
    ? (goldCloses[goldCloses.length-1] - goldCloses[goldCloses.length-720]) / goldCloses[goldCloses.length-720] * 100
    : 0;
  // Oil 30d momentum
  const oilMom = oilCloses.length >= 720
    ? (oilCloses[oilCloses.length-1] - oilCloses[oilCloses.length-720]) / oilCloses[oilCloses.length-720] * 100
    : 0;
  // SPY 30d return
  const spyMom = spyCloses.length >= 720
    ? (spyCloses[spyCloses.length-1] - spyCloses[spyCloses.length-720]) / spyCloses[spyCloses.length-720] * 100
    : 0;

  const aboveSMA200 = spy200 && spyNow > spy200;
  const annualVol = spyVol;

  let regime, reason;

  if (goldMom > 5 && oilMom > 5 && spyMom <= 2) {
    regime = 'STAGFLATION';
    reason = `Gold +${goldMom.toFixed(1)}%, Oil +${oilMom.toFixed(1)}% 30d, SPY flat`;
  } else if (!aboveSMA200 || annualVol > 0.25) {
    regime = 'RISK_OFF';
    reason = aboveSMA200 ? `SPY vol ${(annualVol*100).toFixed(1)}% > 25%` : 'SPY below 200 SMA';
  } else {
    regime = 'RISK_ON';
    reason = `SPY above 200 SMA, vol ${(annualVol*100).toFixed(1)}% < 25%`;
  }

  if (regime !== state.regime) {
    log(`[REGIME] Change: ${state.regime} → ${regime} — ${reason}`);
    state.regimeChangedAt = now();
  }
  return { regime, reason };
}

// ──────────────────────────────────────────────────────────────────────────────
// SENTIMENT ANALYSIS via Claude API
// ──────────────────────────────────────────────────────────────────────────────
async function updateSentiment(cfg) {
  if (!ai) return;
  log('[SENTIMENT] Updating for all assets...');

  for (const asset of ALL_ASSETS) {
    const d = pd[asset];
    if (d.closes.length < 20) continue;
    const price    = getCurrentPrice(asset);
    const rsiVal   = rsi(d.closes, cfg.rsiPeriod) || 50;
    const ema20Val = ema(d.closes, 20);
    const ema50Val = ema(d.closes, 50);

    try {
      const resp = await ai.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        system: [
          {
            type: 'text',
            text: 'You are a financial sentiment analyst. Respond only with valid JSON.',
            cache_control: { type: 'ephemeral' },
          }
        ],
        messages: [{
          role: 'user',
          content: `Rate the current market sentiment for ${asset} on a scale from -1.0 (extremely bearish) to +1.0 (extremely bullish) based on: current price $${price.toFixed(2)}, RSI=${rsiVal.toFixed(1)}, price vs EMA20=${ema20Val ? (price>ema20Val?'above':'below') : 'N/A'}, price vs EMA50=${ema50Val ? (price>ema50Val?'above':'below') : 'N/A'}. Return ONLY a JSON object: {"score": number, "reasoning": string, "confidence": string}`,
        }],
      });

      const text = resp.content[0].text.trim();
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        sentimentData[asset] = { ...parsed, updatedAt: now() };
      }
    } catch(e) { log(`[SENTIMENT] ${asset} error: ${e.message}`); }

    await delay(500);
  }
  saveJSON(F.sentiment, sentimentData);
  log('[SENTIMENT] Update complete');
}

function sentimentBoost(asset) {
  const s = sentimentData[asset];
  if (!s || s.score == null) return 0;
  if (s.score > 0.5)  return 0.20;
  if (s.score < -0.5) return -0.20;
  return 0;
}

// ──────────────────────────────────────────────────────────────────────────────
// POSITION SIZING — KELLY CRITERION
// ──────────────────────────────────────────────────────────────────────────────
function kellyPositionSize(profile, strategy, asset, entryPrice, stopLoss) {
  const prof  = PROFILES[profile];
  const port  = state.portfolios[profile];
  const cfg   = config;

  // Kelly from trade history
  const hist = allTrades.filter(t => t.profile === profile && t.strategy === strategy && t.asset === asset).slice(-20);
  let kellyFrac = prof.kelly;
  if (hist.length >= 5) {
    const wins     = hist.filter(t => t.win);
    const winRate  = wins.length / hist.length;
    const avgWin   = wins.length > 0 ? wins.reduce((s,t) => s+t.pnlPct,0)/wins.length : prof.tp;
    const losses   = hist.filter(t => !t.win);
    const avgLoss  = losses.length > 0 ? losses.reduce((s,t) => s+Math.abs(t.pnlPct),0)/losses.length : prof.sl;
    const rr       = avgLoss > 0 ? avgWin / avgLoss : 1;
    const raw      = winRate - (1 - winRate) / rr;
    kellyFrac = clamp(raw / 2, prof.kelly * 0.5, prof.kelly);
  }
  // Apply config override
  kellyFrac = Math.min(kellyFrac, cfg.kellyFraction / 100);

  const slPct  = entryPrice > 0 ? Math.abs(entryPrice - stopLoss) / entryPrice : prof.sl;
  const maxRisk = (cfg.maxTradeRisk / 100) * port.nav;
  const kellyRisk = kellyFrac * port.nav * slPct;
  const riskAmount = Math.min(maxRisk, kellyRisk, prof.maxRisk * port.nav);

  if (slPct === 0 || entryPrice === 0) return 0;
  const qty = riskAmount / (entryPrice * slPct);
  const notional = qty * entryPrice;

  // Apply half-size if strategy in recovery
  const stats = port.strategyStats[strategy];
  const sizeMultiplier = (stats.halfSize || stats.suspended) ? 0.5 : 1;

  // Apply regime reduction
  let regimeMult = 1;
  if (state.regime === 'RISK_OFF') regimeMult = 0.5;

  return { qty: qty * sizeMultiplier * regimeMult, notional: notional * sizeMultiplier * regimeMult, riskAmount };
}

// ──────────────────────────────────────────────────────────────────────────────
// RISK LAYERS
// ──────────────────────────────────────────────────────────────────────────────
function layer1_checkTrade(profile, riskAmount) {
  const port = state.portfolios[profile];
  const maxAllowed = (config.maxTradeRisk / 100) * port.nav;
  return riskAmount <= maxAllowed;
}

function layer2_checkStrategy(profile, strategy) {
  const stats = state.portfolios[profile].strategyStats[strategy];
  if (stats.suspended) {
    // Auto-resume after 24h
    if (stats.suspendedAt && Date.now() - new Date(stats.suspendedAt).getTime() > 86400000) {
      stats.suspended = false;
      stats.halfSize  = true;
      log(`[RISK] ${strategy}/${profile} auto-resumed at half size`);
    } else return false;
  }
  return true;
}

function layer3_checkAssetClass(profile, asset, notional) {
  const port = state.portfolios[profile];
  const cls  = ASSET_CLASS[asset];
  const limits = { crypto: config.cryptoMax/100, equities: config.equitiesMax/100, commodities: config.commoditiesMax/100 };
  const limit = limits[cls] || 1;

  const classExposure = port.positions
    .filter(p => ASSET_CLASS[p.asset] === cls)
    .reduce((s, p) => s + p.notional, 0);

  return (classExposure + notional) / port.nav <= limit;
}

function layer4_portfolioChecks() {
  const totalNAV = Object.values(state.portfolios).reduce((s, p) => s + p.nav, 0);

  // Kill switch
  if (!state.killSwitch.triggered) {
    if (totalNAV > state.allTimeHigh) state.allTimeHigh = totalNAV;
    const drawdown = (totalNAV - state.allTimeHigh) / state.allTimeHigh * 100;
    const threshold = config.killSwitchThreshold;
    if (drawdown <= threshold) {
      state.killSwitch.triggered  = true;
      state.killSwitch.triggeredAt = now();
      state.killSwitch.reason     = `Portfolio dropped ${drawdown.toFixed(2)}% from ATH £${state.allTimeHigh.toFixed(2)}`;
      log(`[KILL SWITCH] TRIGGERED: ${state.killSwitch.reason}`);
    }
  }
  return !state.killSwitch.triggered;
}

function portfolioHeat(profile) {
  const port = state.portfolios[profile];
  if (port.nav === 0) return 0;
  const risk = port.positions.reduce((s, pos) => {
    const cur = getCurrentPrice(pos.asset);
    const slDiff = pos.side === 'LONG' ? pos.entryPrice - pos.stopLoss : pos.stopLoss - pos.entryPrice;
    return s + pos.qty * Math.max(slDiff, 0);
  }, 0);
  return risk / port.nav;
}

function correlationRisk(profile) {
  const positions = state.portfolios[profile].positions;
  if (positions.length < 5) return false;
  // Simplified: count positions in same direction per class
  const longCount  = positions.filter(p => p.side === 'LONG').length;
  const shortCount = positions.filter(p => p.side === 'SHORT').length;
  return longCount >= 5 || shortCount >= 5;
}

// ──────────────────────────────────────────────────────────────────────────────
// TRADE EXECUTION
// ──────────────────────────────────────────────────────────────────────────────
function openPosition(profile, strategy, asset, side, cfg) {
  if (!layer4_portfolioChecks()) return null;
  if (!layer2_checkStrategy(profile, strategy)) return null;
  if (!(config.enabledAssets?.[asset] !== false)) return null;

  const port  = state.portfolios[profile];
  const prof  = PROFILES[profile];
  const price = getCurrentPrice(asset);
  if (!price) return null;

  // Check for existing position on same asset+strategy
  if (port.positions.find(p => p.asset === asset && p.strategy === strategy)) return null;

  const sl = side === 'LONG'
    ? price * (1 - prof.sl)
    : price * (1 + prof.sl);
  const tp = side === 'LONG'
    ? price * (1 + prof.tp)
    : price * (1 - prof.tp);

  const sizing = kellyPositionSize(profile, strategy, asset, price, sl);
  if (sizing.qty <= 0 || sizing.notional <= 0) return null;
  if (!layer1_checkTrade(profile, sizing.riskAmount)) return null;
  if (!layer3_checkAssetClass(profile, asset, sizing.notional)) return null;

  // Check heat
  const heat = portfolioHeat(profile);
  if (heat >= config.maxPortfolioHeat / 100) {
    log(`[RISK] ${profile} heat ${(heat*100).toFixed(1)}% at max, skipping ${asset}`);
    return null;
  }
  // Correlation check
  const corrHigh = correlationRisk(profile);
  const finalQty = corrHigh ? sizing.qty * 0.5 : sizing.qty;
  const finalNotional = finalQty * price;

  if (port.cash < finalNotional * 0.1) return null; // need at least 10% cash margin

  const rsiVal = rsi(pd[asset].closes, cfg.rsiPeriod);
  const { position: bbPos } = bbSignal(asset, cfg);
  const avgVol = pd[asset].volumes.length >= 20
    ? pd[asset].volumes.slice(-20).reduce((a,b)=>a+b,0)/20 : 1;
  const curVol = pd[asset].volumes[pd[asset].volumes.length-1] || 0;

  const position = {
    id:           uid(),
    strategy,
    profile,
    asset,
    side,
    entryPrice:   price,
    qty:          finalQty,
    notional:     finalNotional,
    stopLoss:     sl,
    takeProfit:   tp,
    openedAt:     now(),
    rsiAtEntry:   rsiVal,
    trendAtEntry: price > (sma(pd[asset].closes, 200) || 0) ? 'up' : 'down',
    bbPositionAtEntry: bbPos,
    volumeAtEntry: avgVol > 0 ? curVol / avgVol : 1,
  };

  port.positions.push(position);
  port.cash -= finalNotional * 0.1; // reserve 10% as margin

  log(`[TRADE] OPEN ${side} ${asset} @${price.toFixed(4)} qty=${finalQty.toFixed(6)} strategy=${strategy} profile=${profile}`);
  return position;
}

function closePosition(profile, posId, reason) {
  const port = state.portfolios[profile];
  const idx  = port.positions.findIndex(p => p.id === posId);
  if (idx === -1) return null;
  const pos  = port.positions[idx];
  const exitPrice = getCurrentPrice(pos.asset);
  if (!exitPrice) return null;

  const pnl = pos.side === 'LONG'
    ? (exitPrice - pos.entryPrice) * pos.qty
    : (pos.entryPrice - exitPrice) * pos.qty;
  const pnlPct = (pnl / pos.notional) * 100;
  const win  = pnl > 0;

  const openedMs  = new Date(pos.openedAt).getTime();
  const holdMins  = (Date.now() - openedMs) / 60000;

  // Credit P&L to portfolio cash + return margin
  port.cash += pos.notional * 0.1 + pnl;
  port.positions.splice(idx, 1);

  const closedTrade = {
    ...pos,
    exitPrice, pnl: +pnl.toFixed(4), pnlPct: +pnlPct.toFixed(4),
    win, exitReason: reason, closedAt: now(), holdDurationMinutes: +holdMins.toFixed(0),
  };

  allTrades.push(closedTrade);
  learningData.push({
    strategy: pos.strategy, profile, asset: pos.asset, assetClass: ASSET_CLASS[pos.asset],
    entryPrice: pos.entryPrice, exitPrice, pnl: +pnl.toFixed(4), pnlPct: +pnlPct.toFixed(4),
    win, rsiAtEntry: pos.rsiAtEntry, trendAtEntry: pos.trendAtEntry,
    bbPositionAtEntry: pos.bbPositionAtEntry, volumeAtEntry: pos.volumeAtEntry,
    holdDurationMinutes: +holdMins.toFixed(0), exitReason: reason,
  });

  log(`[TRADE] CLOSE ${pos.side} ${pos.asset} @${exitPrice.toFixed(4)} P&L=£${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%) reason=${reason}`);
  return closedTrade;
}

function checkPositionsSLTP(profile) {
  const port  = state.portfolios[profile];
  const toClose = [];

  for (const pos of port.positions) {
    const price = getCurrentPrice(pos.asset);
    if (!price) continue;

    if (pos.side === 'LONG') {
      if (price <= pos.stopLoss) toClose.push({ id:pos.id, reason:'STOP_LOSS' });
      else if (price >= pos.takeProfit) toClose.push({ id:pos.id, reason:'TAKE_PROFIT' });
    } else {
      if (price >= pos.stopLoss) toClose.push({ id:pos.id, reason:'STOP_LOSS' });
      else if (price <= pos.takeProfit) toClose.push({ id:pos.id, reason:'TAKE_PROFIT' });
    }
  }
  for (const { id, reason } of toClose) closePosition(profile, id, reason);
}

// ──────────────────────────────────────────────────────────────────────────────
// NAV CALCULATION
// ──────────────────────────────────────────────────────────────────────────────
function updateNAV(profile) {
  const port  = state.portfolios[profile];
  let unrealised = 0;
  for (const pos of port.positions) {
    const cur = getCurrentPrice(pos.asset);
    if (!cur) continue;
    const pnl = pos.side === 'LONG'
      ? (cur - pos.entryPrice) * pos.qty
      : (pos.entryPrice - cur) * pos.qty;
    unrealised += pnl;
  }
  const closedPnl = allTrades
    .filter(t => t.profile === profile)
    .reduce((s, t) => s + t.pnl, 0);

  port.nav = PROFILES[profile].capital + closedPnl + unrealised;
  if (port.nav > port.peakNav) port.peakNav = port.nav;

  // Update strategy drawdown stats
  for (const [strat, stats] of Object.entries(port.strategyStats)) {
    const stratPnl = allTrades
      .filter(t => t.profile === profile && t.strategy === strat)
      .reduce((s, t) => s + t.pnl, 0);
    stats.nav = PROFILES[profile].capital / 4 + stratPnl;
    if (stats.nav > stats.peakNav) stats.peakNav = stats.nav;
    stats.drawdown = stats.peakNav > 0 ? (stats.nav - stats.peakNav) / stats.peakNav : 0;

    // Layer 2: suspend on -15% strategy drawdown
    if (!stats.suspended && stats.drawdown <= -0.15) {
      stats.suspended = true;
      stats.suspendedAt = now();
      log(`[RISK] ${strat}/${profile} suspended: drawdown ${(stats.drawdown*100).toFixed(1)}%`);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// SELF-LEARNING ENGINE
// ──────────────────────────────────────────────────────────────────────────────
function strategyMetrics(strategy, profile) {
  const trades = allTrades.filter(t => t.strategy === strategy && t.profile === profile);
  if (trades.length === 0) return { winRate:0.5, sharpe:0, maxDD:0, trades:0, pnl:0, profitFactor:1 };

  const wins   = trades.filter(t => t.win);
  const losses = trades.filter(t => !t.win);
  const winRate = wins.length / trades.length;
  const avgWin  = wins.length   ? wins.reduce((s,t)=>s+t.pnlPct,0)/wins.length     : 0;
  const avgLoss = losses.length ? losses.reduce((s,t)=>s+Math.abs(t.pnlPct),0)/losses.length : 0;
  const profitFactor = avgLoss > 0 ? (winRate*avgWin)/((1-winRate)*avgLoss) : 0;

  const returns = trades.map(t => t.pnlPct);
  const mean    = returns.reduce((a,b)=>a+b,0)/returns.length;
  const std     = returns.length>1 ? Math.sqrt(returns.reduce((a,b)=>a+(b-mean)**2,0)/returns.length) : 0;
  const sharpe  = std>0 ? (mean/std)*Math.sqrt(252) : 0;

  let peak=0, maxDD=0, run=0;
  for (const t of trades) {
    run += t.pnl;
    if (run > peak) peak = run;
    maxDD = Math.max(maxDD, peak - run);
  }
  return { winRate, sharpe, maxDD, trades:trades.length, pnl:trades.reduce((s,t)=>s+t.pnl,0), profitFactor };
}

function runLearningCycle() {
  log('[LEARNING] Running daily learning cycle...');
  const combos = [];
  for (const profile of Object.keys(PROFILES))
    for (const strategy of ['ptj','statArb','multiFactor','allWeather'])
      combos.push({ key:`${strategy}_${profile}`, strategy, profile, ...strategyMetrics(strategy, profile) });

  combos.sort((a, b) => b.sharpe - a.sharpe);

  // Adjust weights
  const newWeights = { ...strategyWeights };
  for (let i = 0; i < Math.min(3, combos.length); i++)
    newWeights[combos[i].key] = Math.min(0.40, (newWeights[combos[i].key] || 0.25) + 0.05);
  for (let i = Math.max(0, combos.length-3); i < combos.length; i++)
    newWeights[combos[i].key] = Math.max(0.05, (newWeights[combos[i].key] || 0.25) - 0.05);

  // Normalise per profile
  for (const profile of Object.keys(PROFILES)) {
    const keys   = ['ptj','statArb','multiFactor','allWeather'].map(s => `${s}_${profile}`);
    const total  = keys.reduce((s, k) => s + (newWeights[k] || 0.25), 0);
    for (const k of keys) newWeights[k] = (newWeights[k] || 0.25) / total;
  }

  strategyWeights = newWeights;
  saveJSON(F.weights, strategyWeights);

  const report = {
    generatedAt: now(),
    bestCombo:  combos[0],
    worstCombo: combos[combos.length-1],
    allCombos:  combos,
    regimePerformance: state.regime,
  };
  reports.unshift(report);
  if (reports.length > 30) reports = reports.slice(0, 30);
  saveJSON(F.reports, reports);
  saveJSON(F.learning, learningData);
  log(`[LEARNING] Best: ${combos[0]?.key} Sharpe=${combos[0]?.sharpe.toFixed(2)}`);
}

// ──────────────────────────────────────────────────────────────────────────────
// MAIN STRATEGY EXECUTION
// ──────────────────────────────────────────────────────────────────────────────
function runPTJ(cfg) {
  for (const profile of Object.keys(PROFILES)) {
    const port = state.portfolios[profile];
    for (const asset of ALL_ASSETS) {
      if (!config.enabledAssets?.[asset]) continue;
      const signal = ptjSignal(asset, cfg);
      const boost  = bbSignal(asset, cfg).boost + sentimentBoost(asset);

      if (signal === 'BUY' || (signal === 'HOLD' && boost > 0.3)) {
        // Check if already long
        if (!port.positions.find(p => p.asset === asset && p.strategy === 'ptj' && p.side === 'LONG'))
          openPosition(profile, 'ptj', asset, 'LONG', cfg);
        // Close any existing short
        const shortPos = port.positions.find(p => p.asset === asset && p.strategy === 'ptj' && p.side === 'SHORT');
        if (shortPos) closePosition(profile, shortPos.id, 'SIGNAL_REVERSAL');
      } else if (signal === 'SHORT' || (signal === 'HOLD' && boost < -0.3)) {
        if (!port.positions.find(p => p.asset === asset && p.strategy === 'ptj' && p.side === 'SHORT'))
          openPosition(profile, 'ptj', asset, 'SHORT', cfg);
        const longPos = port.positions.find(p => p.asset === asset && p.strategy === 'ptj' && p.side === 'LONG');
        if (longPos) closePosition(profile, longPos.id, 'SIGNAL_REVERSAL');
      }
    }
  }
}

function runStatArb(cfg) {
  const signals = statArbSignals(cfg);
  for (const profile of Object.keys(PROFILES)) {
    const port = state.portfolios[profile];

    for (const sig of signals) {
      const pairKey = `${sig.assetA}_${sig.assetB}`;

      if (sig.side === 'EXIT') {
        // Close both legs
        const toClose = port.positions.filter(p => p.pairKey === pairKey && p.strategy === 'statArb');
        for (const p of toClose) closePosition(profile, p.id, 'ZSCORE_MEAN_REVERT');
        continue;
      }

      // Already have this pair open?
      if (port.positions.find(p => p.pairKey === pairKey && p.strategy === 'statArb')) continue;

      const sideA = sig.side === 'A_SHORT_B_LONG' ? 'SHORT' : 'LONG';
      const sideB = sig.side === 'A_SHORT_B_LONG' ? 'LONG'  : 'SHORT';

      const posA = openPosition(profile, 'statArb', sig.assetA, sideA, cfg);
      const posB = openPosition(profile, 'statArb', sig.assetB, sideB, cfg);
      if (posA) posA.pairKey = pairKey;
      if (posB) posB.pairKey = pairKey;
    }
  }
}

function runMultiFactor(cfg) {
  const now4h = Date.now() - lastMultiFactorReb > 4 * 3600 * 1000;
  if (!now4h) return;
  lastMultiFactorReb = Date.now();

  const signals = multiFactorSignals(cfg);

  for (const profile of Object.keys(PROFILES)) {
    const port = state.portfolios[profile];
    // Close all existing multi-factor positions
    const existing = port.positions.filter(p => p.strategy === 'multiFactor').map(p => p.id);
    for (const id of existing) closePosition(profile, id, 'REBALANCE');

    // Open new positions
    for (const [asset, sig] of Object.entries(signals)) {
      if (!config.enabledAssets?.[asset]) continue;
      openPosition(profile, 'multiFactor', asset, sig.signal === 'BUY' ? 'LONG' : 'SHORT', cfg);
    }
  }
}

function runAllWeather(cfg) {
  const now7d = Date.now() - lastAllWeatherReb > 7 * 24 * 3600 * 1000;
  if (!now7d && !checkAllWeatherDrift()) return;
  lastAllWeatherReb = Date.now();

  const targets = allWeatherTargets(cfg, state.regime);
  for (const profile of Object.keys(PROFILES)) {
    const port = state.portfolios[profile];
    // Close all All-Weather positions
    const existing = port.positions.filter(p => p.strategy === 'allWeather').map(p => p.id);
    for (const id of existing) closePosition(profile, id, 'REBALANCE');

    // Open new positions proportional to target weights
    for (const [asset, targetWeight] of Object.entries(targets)) {
      if (targetWeight < 0.01) continue;
      if (!config.enabledAssets?.[asset]) continue;
      openPosition(profile, 'allWeather', asset, 'LONG', cfg);
    }
  }
}

function checkAllWeatherDrift() {
  // Check if any asset has drifted > 5% from target
  const targets = allWeatherTargets(config, state.regime);
  for (const profile of Object.keys(PROFILES)) {
    const port = state.portfolios[profile];
    for (const [asset, target] of Object.entries(targets)) {
      const pos = port.positions.find(p => p.asset === asset && p.strategy === 'allWeather');
      const actual = pos ? pos.notional / port.nav : 0;
      if (Math.abs(actual - target) > 0.05) return true;
    }
  }
  return false;
}

// ──────────────────────────────────────────────────────────────────────────────
// EQUITY CURVE
// ──────────────────────────────────────────────────────────────────────────────
function recordEquityCurve() {
  const navs = {};
  let total = 0;
  for (const profile of Object.keys(PROFILES)) {
    navs[profile] = state.portfolios[profile].nav;
    total += navs[profile];
  }
  const point = { timestamp: now(), ...navs, total };
  state.equityCurve.push(point);
  if (state.equityCurve.length > 500) state.equityCurve = state.equityCurve.slice(-500);
}

// ──────────────────────────────────────────────────────────────────────────────
// MAIN TICK
// ──────────────────────────────────────────────────────────────────────────────
async function tick() {
  // Reload config on every tick (so DJ console changes apply immediately)
  const freshConfig = loadJSON(F.config);
  if (freshConfig) config = { ...DEFAULT_CONFIG, ...freshConfig };

  if (state.killSwitch.triggered) {
    log('[APEX] Kill switch triggered — trading halted');
    saveJSON(F.state, state);
    return;
  }

  const cfg = config;

  // Check SL/TP on all open positions
  for (const profile of Object.keys(PROFILES)) checkPositionsSLTP(profile);

  // Run strategies (pass config)
  if (cfg.strategyWeights?.ptj > 0)         runPTJ(cfg);
  if (cfg.strategyWeights?.statArb > 0)     runStatArb(cfg);
  if (cfg.strategyWeights?.multiFactor > 0) runMultiFactor(cfg);
  if (cfg.strategyWeights?.allWeather > 0)  runAllWeather(cfg);

  // Update NAV for all portfolios
  for (const profile of Object.keys(PROFILES)) updateNAV(profile);

  // Record equity curve point
  recordEquityCurve();

  state.lastUpdate = now();
  saveJSON(F.state, state);
  saveJSON(F.trades, allTrades.slice(-1000));

  // Log summary
  const total = Object.values(state.portfolios).reduce((s, p) => s + p.nav, 0);
  const openCount = Object.values(state.portfolios).reduce((s, p) => s + p.positions.length, 0);
  log(`[APEX] NAV=£${total.toFixed(2)} | Open=${openCount} | Regime=${state.regime}`);
}

// ──────────────────────────────────────────────────────────────────────────────
// STARTUP
// ──────────────────────────────────────────────────────────────────────────────
async function start() {
  log('═══════════════════════════════════════════════════');
  log('      APEX BOT — Starting up...');
  log('═══════════════════════════════════════════════════');

  // Load persisted state
  state           = loadJSON(F.state) || initState();
  allTrades       = loadJSON(F.trades) || [];
  learningData    = loadJSON(F.learning) || [];
  sentimentData   = loadJSON(F.sentiment) || {};
  strategyWeights = loadJSON(F.weights) || initWeights();
  reports         = loadJSON(F.reports) || [];
  config          = { ...DEFAULT_CONFIG, ...(loadJSON(F.config) || {}) };

  // Write default config if none exists
  if (!loadJSON(F.config)) saveJSON(F.config, DEFAULT_CONFIG);

  // Load AV on-disk cache (survives restarts — protects 25/day budget)
  avCache = loadJSON(F.avCache) || { data:{}, dailyCalls:0, dailyDate:'' };

  // Initial data load
  log('[APEX] Loading crypto OHLC from CoinGecko...');
  await fetchCoinGeckoLive();
  for (const asset of CLASSES.crypto) { await fetchCGOHLC(asset); await delay(2000); }

  log('[APEX] Loading equities + commodities from Alpha Vantage...');
  await startupFetch();

  // Initial regime detection
  const regimeResult = detectRegime();
  state.regime = regimeResult.regime;
  state.regimeReason = regimeResult.reason;
  lastRegimeUpdate = Date.now();

  // Initial sentiment (if API key available)
  if (ai) {
    await updateSentiment(config);
    lastSentimentUpdate = Date.now();
  }

  // Run backtest on startup
  try {
    const { runBacktest } = require('./backtest');
    log('[APEX] Running startup backtest...');
    await runBacktest();
    log('[APEX] Backtest complete');
  } catch(e) { log(`[APEX] Backtest skipped: ${e.message}`); }

  // Run first tick
  await tick();

  // ─── SCHEDULERS ───────────────────────────────────────────────────────────

  // Crypto: CoinGecko live prices every 60 seconds + OHLC every 5 minutes
  setInterval(async () => {
    try { await fetchCoinGeckoLive(); await tick(); }
    catch(e) { log(`[LOOP] CG live tick error: ${e.message}`); }
  }, 60_000);

  setInterval(async () => {
    try {
      for (const asset of CLASSES.crypto) { await fetchCGOHLC(asset); await delay(2000); }
      await tick();
    } catch(e) { log(`[LOOP] CG OHLC tick error: ${e.message}`); }
  }, 5 * 60_000);

  // Equities/Commodities: rolling AV refresh every 60 minutes (one asset per cycle)
  // Max 24 calls/day from this loop; combined with startup stays under 25/day limit.
  setInterval(async () => {
    try { await rollingAvRefresh(); await tick(); }
    catch(e) { log(`[LOOP] AV refresh error: ${e.message}`); }
  }, 60 * 60_000);

  // Sentiment: every 4 hours
  setInterval(async () => {
    if (!ai) return;
    try { await updateSentiment(config); } catch(e) { log(`[SENT] Error: ${e.message}`); }
  }, 4 * 3600_000);

  // Regime: every 4 hours
  setInterval(() => {
    try {
      const r = detectRegime();
      state.regime = r.regime;
      state.regimeReason = r.reason;
    } catch(e) { log(`[REGIME] Error: ${e.message}`); }
  }, 4 * 3600_000);

  // Learning cycle: every 24 hours
  setInterval(() => {
    try { runLearningCycle(); } catch(e) { log(`[LEARN] Error: ${e.message}`); }
  }, 24 * 3600_000);

  // Weekly backtest
  setInterval(async () => {
    try {
      const { runBacktest } = require('./backtest');
      await runBacktest();
    } catch(e) { log(`[BACKTEST] Weekly error: ${e.message}`); }
  }, 7 * 24 * 3600_000);

  // Daily analyst report at 08:00 UTC
  (function scheduleAnalyst() {
    let analyst;
    try { analyst = require('./analyst'); } catch(e) { log(`[ANALYST] Module load failed: ${e.message}`); return; }

    const runReport = async () => {
      try { await analyst.generateDailyReport(); }
      catch(e) { log(`[ANALYST] Report error: ${e.message}`); }
    };

    // Run on startup if no report for today
    if (!analyst.todayHasReport()) {
      log('[ANALYST] No report for today — generating startup report');
      runReport();
    }

    // Schedule precise 08:00 UTC daily trigger
    function msUntil8amUTC() {
      const now  = new Date();
      const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 8, 0, 0, 0));
      if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
      return next - now;
    }

    function scheduleNext() {
      const delay = msUntil8amUTC();
      log(`[ANALYST] Next report scheduled in ${Math.round(delay/3600000*10)/10}h (08:00 UTC)`);
      setTimeout(() => { runReport(); setInterval(runReport, 24 * 3600_000); }, delay);
    }

    scheduleNext();
  })();

  log('[APEX] All schedulers running. Bot is live.');
}

start().catch(e => { console.error('[APEX] Fatal startup error:', e); process.exit(1); });
