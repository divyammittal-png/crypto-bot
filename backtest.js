'use strict';
// ══════════════════════════════════════════════════════════════════════════════
// APEX BOT — Backtesting Engine
// ══════════════════════════════════════════════════════════════════════════════
const https  = require('https');
const fs     = require('fs');
const path   = require('path');

const F_BACKTEST = path.join(__dirname, 'backtest-results.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

const CLASSES = {
  crypto:      ['BTC','ETH','SOL','BNB','XRP'],
  equities:    ['AAPL','TSLA','NVDA','SPY','AMZN','MSFT','GOOGL','META','NFLX','JPM','QQQ'],
  commodities: ['GC=F','SI=F','CL=F','NG=F'],
};
const ALL_ASSETS = [...CLASSES.crypto, ...CLASSES.equities, ...CLASSES.commodities];
const ASSET_CLASS = {};
for (const [cls, arr] of Object.entries(CLASSES)) arr.forEach(a => ASSET_CLASS[a] = cls);

const YF_SYM = {
  BTC:'BTC-USD', ETH:'ETH-USD', SOL:'SOL-USD', BNB:'BNB-USD', XRP:'XRP-USD',
  AAPL:'AAPL', TSLA:'TSLA', NVDA:'NVDA', SPY:'SPY', AMZN:'AMZN',
  MSFT:'MSFT', GOOGL:'GOOGL', META:'META', NFLX:'NFLX', JPM:'JPM', QQQ:'QQQ',
  'GC=F':'GC=F', 'SI=F':'SI=F', 'CL=F':'CL=F', 'NG=F':'NG=F',
};

const PROFILES = {
  aggressive:   { capital:333, sl:0.030, tp:0.09 },
  balanced:     { capital:334, sl:0.020, tp:0.06 },
  conservative: { capital:333, sl:0.010, tp:0.03 },
};

function log(msg) { console.log(`[BT ${new Date().toISOString()}] ${msg}`); }
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpsGetJSON(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ─── FETCH OHLCV ─────────────────────────────────────────────────────────────
async function fetchOHLCV(asset) {
  try {
    const sym = encodeURIComponent(YF_SYM[asset]);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1h&range=60d`;
    const data = await httpsGetJSON(url);
    const result = data?.chart?.result?.[0];
    if (!result) return null;

    const ts  = result.timestamp || [];
    const q   = result.indicators?.quote?.[0] || {};
    const candles = [];
    for (let i = 0; i < ts.length; i++) {
      if (!q.close?.[i] || isNaN(q.close[i])) continue;
      candles.push({
        ts:     ts[i] * 1000,
        open:   q.open?.[i]   || q.close[i],
        high:   q.high?.[i]   || q.close[i],
        low:    q.low?.[i]    || q.close[i],
        close:  q.close[i],
        volume: q.volume?.[i] || 0,
      });
    }
    return candles;
  } catch(e) {
    log(`${asset} fetch error: ${e.message}`);
    return null;
  }
}

// ─── INDICATORS ──────────────────────────────────────────────────────────────
function sma(arr, p) {
  if (arr.length < p) return null;
  return arr.slice(-p).reduce((a,b)=>a+b,0)/p;
}
function ema(arr, p) {
  if (arr.length < p) return null;
  const k = 2/(p+1);
  let v = arr.slice(0,p).reduce((a,b)=>a+b,0)/p;
  for (let i=p; i<arr.length; i++) v = arr[i]*k + v*(1-k);
  return v;
}
function rsi(closes, p=14) {
  if (closes.length < p+1) return 50;
  const r = closes.slice(-(p*2+1));
  let ag=0, al=0;
  for (let i=1; i<=p; i++) {
    const d = r[i]-r[i-1];
    if (d>0) ag+=d/p; else al+=(-d)/p;
  }
  for (let i=p+1; i<r.length; i++) {
    const d = r[i]-r[i-1];
    ag = (ag*(p-1)+Math.max(d,0))/p;
    al = (al*(p-1)+Math.max(-d,0))/p;
  }
  if (al===0) return 100;
  return 100 - 100/(1+ag/al);
}
function zscore(s, p=20) {
  if (s.length < p) return null;
  const sl = s.slice(-p);
  const m = sl.reduce((a,b)=>a+b,0)/p;
  const std = Math.sqrt(sl.reduce((a,b)=>a+(b-m)**2,0)/p);
  return std===0 ? 0 : (sl[sl.length-1]-m)/std;
}
function bb(closes, p=20, mult=2) {
  if (closes.length < p) return null;
  const s = closes.slice(-p);
  const mid = s.reduce((a,b)=>a+b,0)/p;
  const std = Math.sqrt(s.reduce((a,b)=>a+(b-mid)**2,0)/p);
  return { upper:mid+mult*std, middle:mid, lower:mid-mult*std };
}

// ─── SIMULATE STRATEGY ───────────────────────────────────────────────────────
function simulateAsset(candles, profile, strategy) {
  const prof  = PROFILES[profile];
  const closes = candles.map(c => c.close);
  const trades = [];
  let openPos  = null;

  for (let i = 50; i < candles.length; i++) {
    const slice  = closes.slice(0, i+1);
    const price  = closes[i];
    const rsiVal = rsi(slice);
    const sma200 = sma(slice, Math.min(200, i));
    const ema20  = ema(slice, 20);
    const ema50  = ema(slice, Math.min(50, i));
    const bbVal  = bb(slice);

    let signal = 'HOLD';

    if (strategy === 'ptj' && sma200 && ema20 && ema50) {
      const up  = price > sma200 && ema20 > ema50;
      const dn  = price < sma200 && ema20 < ema50;
      if (up && rsiVal < 40)  signal = 'BUY';
      if (dn && rsiVal > 60)  signal = 'SHORT';
    }

    if (strategy === 'multiFactor') {
      if (rsiVal < 35 && bbVal && price <= bbVal.lower) signal = 'BUY';
      if (rsiVal > 65 && bbVal && price >= bbVal.upper) signal = 'SHORT';
    }

    if (strategy === 'allWeather') {
      if (price > (sma200 || 0)) signal = 'BUY';
      else signal = 'SHORT';
    }

    // Manage open position
    if (openPos) {
      const sl = openPos.side === 'LONG' ? openPos.entry*(1-prof.sl) : openPos.entry*(1+prof.sl);
      const tp = openPos.side === 'LONG' ? openPos.entry*(1+prof.tp) : openPos.entry*(1-prof.tp);
      let exit = null, exitReason = '';

      if (openPos.side === 'LONG') {
        if (price <= sl) { exit = sl; exitReason = 'SL'; }
        else if (price >= tp) { exit = tp; exitReason = 'TP'; }
        else if (signal === 'SHORT') { exit = price; exitReason = 'REVERSAL'; }
      } else {
        if (price >= sl) { exit = sl; exitReason = 'SL'; }
        else if (price <= tp) { exit = tp; exitReason = 'TP'; }
        else if (signal === 'BUY') { exit = price; exitReason = 'REVERSAL'; }
      }

      if (exit) {
        const pnl = openPos.side === 'LONG' ? (exit-openPos.entry)/openPos.entry : (openPos.entry-exit)/openPos.entry;
        trades.push({ entry:openPos.entry, exit, pnl, win:pnl>0, bars:i-openPos.bar, reason:exitReason });
        openPos = null;
      }
    }

    // Open new position
    if (!openPos && (signal === 'BUY' || signal === 'SHORT')) {
      openPos = { entry:price, side: signal==='BUY'?'LONG':'SHORT', bar:i };
    }
  }

  return trades;
}

function simStatArb(candlesA, candlesB, profile) {
  const prof  = PROFILES[profile];
  const len   = Math.min(candlesA.length, candlesB.length);
  const spread = [];
  for (let i=0; i<len; i++) spread.push(candlesA[i].close / candlesB[i].close);

  const trades = [];
  let openPos  = null;

  for (let i=25; i<spread.length; i++) {
    const sl = spread.slice(0, i+1);
    const z  = zscore(sl, 20);
    if (z == null) continue;

    if (openPos) {
      const absZ = Math.abs(z);
      if (absZ < 0.3) {
        const exitA = candlesA[i].close;
        const exitB = candlesB[i].close;
        const pnlA = openPos.sideA === 'LONG' ? (exitA-openPos.entryA)/openPos.entryA : (openPos.entryA-exitA)/openPos.entryA;
        const pnlB = openPos.sideB === 'LONG' ? (exitB-openPos.entryB)/openPos.entryB : (openPos.entryB-exitB)/openPos.entryB;
        const pnl  = (pnlA + pnlB) / 2;
        trades.push({ pnl, win:pnl>0, bars:i-openPos.bar, reason:'ZSCORE_REVERT' });
        openPos = null;
      }
    }

    if (!openPos) {
      if (z > 2.0)  openPos = { sideA:'SHORT',sideB:'LONG',  entryA:candlesA[i].close, entryB:candlesB[i].close, bar:i };
      if (z < -2.0) openPos = { sideA:'LONG', sideB:'SHORT', entryA:candlesA[i].close, entryB:candlesB[i].close, bar:i };
    }
  }
  return trades;
}

// ─── METRICS ─────────────────────────────────────────────────────────────────
function calcMetrics(trades, initialCapital) {
  if (trades.length === 0) return { totalReturn:0, sharpe:0, maxDD:0, winRate:0, avgWin:0, avgLoss:0, profitFactor:0, trades:0, bestAsset:null, worstAsset:null };

  const wins   = trades.filter(t => t.win);
  const losses = trades.filter(t => !t.win);
  const winRate   = wins.length / trades.length;
  const avgWin    = wins.length   ? wins.reduce((s,t)=>s+t.pnl,0)/wins.length     : 0;
  const avgLoss   = losses.length ? losses.reduce((s,t)=>s+Math.abs(t.pnl),0)/losses.length : 0;
  const profitFactor = avgLoss > 0 ? (winRate*avgWin)/((1-winRate)*avgLoss) : 0;
  const totalReturn  = trades.reduce((s,t)=>s+t.pnl,0) * initialCapital;

  const returns = trades.map(t => t.pnl);
  const mean    = returns.reduce((a,b)=>a+b,0)/returns.length;
  const std     = returns.length>1 ? Math.sqrt(returns.reduce((a,b)=>a+(b-mean)**2,0)/returns.length) : 0;
  const sharpe  = std>0 ? (mean/std)*Math.sqrt(252) : 0;

  let peak=0, maxDD=0, run=0;
  for (const t of trades) {
    run += t.pnl;
    if (run > peak) peak = run;
    maxDD = Math.max(maxDD, peak-run);
  }

  return { totalReturn:+totalReturn.toFixed(2), sharpe:+sharpe.toFixed(3), maxDD:+maxDD.toFixed(4), winRate:+winRate.toFixed(3), avgWin:+avgWin.toFixed(4), avgLoss:+avgLoss.toFixed(4), profitFactor:+profitFactor.toFixed(3), trades:trades.length };
}

// ─── MAIN BACKTEST ────────────────────────────────────────────────────────────
async function runBacktest() {
  log('Starting full backtest...');
  const allData = {};

  for (const asset of ALL_ASSETS) {
    log(`Fetching ${asset}...`);
    const candles = await fetchOHLCV(asset);
    if (candles && candles.length > 50) allData[asset] = candles;
    else log(`${asset}: insufficient data (${candles?.length || 0} candles)`);
    await delay(2000);
  }

  const results = {};

  for (const profile of Object.keys(PROFILES)) {
    results[profile] = {};

    for (const strategy of ['ptj','multiFactor','allWeather']) {
      const allTrades = [];
      let bestAsset = null, worstAsset = null;
      let bestPnl = -Infinity, worstPnl = Infinity;

      for (const asset of ALL_ASSETS) {
        if (!allData[asset]) continue;
        const trades = simulateAsset(allData[asset], profile, strategy);
        const pnl    = trades.reduce((s,t)=>s+t.pnl,0);
        if (pnl > bestPnl)  { bestPnl = pnl;  bestAsset = asset; }
        if (pnl < worstPnl) { worstPnl = pnl; worstAsset = asset; }
        allTrades.push(...trades);
      }

      const metrics = calcMetrics(allTrades, PROFILES[profile].capital);
      results[profile][strategy] = { ...metrics, bestAsset, worstAsset };
    }

    // Stat-arb backtest
    const pairsTrades = [];
    const PAIRS = [['BTC','ETH'],['BTC','SOL'],['AAPL','MSFT'],['GOOGL','META'],['NVDA','SPY'],['GC=F','SI=F'],['CL=F','NG=F']];
    for (const [a, b] of PAIRS) {
      if (allData[a] && allData[b]) {
        pairsTrades.push(...simStatArb(allData[a], allData[b], profile));
      }
    }
    results[profile]['statArb'] = calcMetrics(pairsTrades, PROFILES[profile].capital);
  }

  const output = {
    runAt:   new Date().toISOString(),
    assetsLoaded: Object.keys(allData).length,
    results,
    dataRange: { from: Object.values(allData)[0]?.[0]?.ts, to: Object.values(allData)[0]?.slice(-1)[0]?.ts },
  };

  fs.writeFileSync(F_BACKTEST, JSON.stringify(output, null, 2));
  log(`Backtest complete. Results saved to ${F_BACKTEST}`);
  return output;
}

module.exports = { runBacktest };
