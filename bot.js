const https = require('https');
const fs = require('fs');

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
const COINGECKO_IDS = {
  BTCUSDT: 'bitcoin',
  ETHUSDT: 'ethereum',
  SOLUSDT: 'solana',
  BNBUSDT: 'binancecoin',
  XRPUSDT: 'ripple',
};
const TRADE_PCT = 0.05;
const STOP_LOSS_PCT = 0.03;
const TAKE_PROFIT_PCT = 0.06;
const POLL_MS = 60_000;
const TRADES_FILE = require('path').join(__dirname, 'trades.json');
const STATE_FILE  = require('path').join(__dirname, 'state.json');

let balance = 1000; // GBP paper balance
let positions = {}; // { SYMBOL: { qty, entryPrice, stopLoss, takeProfit } }
let trades = loadTrades();
let marketSnapshot = {}; // latest price/ema/rsi per symbol

function loadTrades() {
  try {
    return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveTrades() {
  fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
}

function saveState() {
  const totalPnl = trades
    .filter(t => t.side === 'SELL' && t.pnl != null)
    .reduce((sum, t) => sum + t.pnl, 0);
  const positionsWithUnrealised = Object.fromEntries(
    Object.entries(positions).map(([sym, pos]) => {
      const snap = marketSnapshot[sym];
      const currentPrice = snap ? snap.price : pos.entryPrice;
      const unrealisedPnl = (currentPrice - pos.entryPrice) * pos.qty;
      return [sym, { ...pos, currentPrice, unrealisedPnl: +unrealisedPnl.toFixed(2) }];
    })
  );
  const state = {
    updatedAt: new Date().toISOString(),
    balance: +balance.toFixed(2),
    startBalance: 1000,
    totalPnl: +totalPnl.toFixed(2),
    positions: positionsWithUnrealised,
    market: marketSnapshot,
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function httpsGet(url) {
  const apiKey = process.env.COINGECKO_API_KEY;
  const options = {
    headers: { 'Accept': 'application/json', 'User-Agent': 'crypto-bot/1.0', ...(apiKey && { 'x-cg-demo-api-key': apiKey }) },
  };
  return new Promise((resolve, reject) => {
    https.get(url, options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

const delay = ms => new Promise(r => setTimeout(r, ms));

async function getKlines(symbol) {
  const id = COINGECKO_IDS[symbol];
  const url = `https://api.coingecko.com/api/v3/coins/${id}/ohlc?vs_currency=usd&days=1`;
  const raw = await httpsGet(url);
  if (!Array.isArray(raw)) throw new Error(`CoinGecko OHLC error for ${symbol}: ${JSON.stringify(raw)}`);
  // CoinGecko returns [timestamp, open, high, low, close] — close is index 4
  return raw.map(k => k[4]);
}

function ema(prices, period) {
  const k = 2 / (period + 1);
  let val = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    val = prices[i] * k + val * (1 - k);
  }
  return val;
}

function rsi(prices, period = 14) {
  const changes = [];
  for (let i = 1; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }
  const slice = changes.slice(-period);
  const gains = slice.map(c => c > 0 ? c : 0);
  const losses = slice.map(c => c < 0 ? -c : 0);
  const avgGain = gains.reduce((a, b) => a + b, 0) / period;
  const avgLoss = losses.reduce((a, b) => a + b, 0) / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

async function processSymbol(symbol) {
  let closes;
  try {
    closes = await getKlines(symbol);
  } catch (e) {
    log(`ERROR fetching ${symbol}: ${e.message}`);
    return;
  }

  const price = closes[closes.length - 1];
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const rsiVal = rsi(closes, 14);
  const pos = positions[symbol];

  // Check stop loss / take profit for open positions
  if (pos) {
    const pnlPct = (price - pos.entryPrice) / pos.entryPrice;
    if (price <= pos.stopLoss) {
      const proceeds = pos.qty * price;
      balance += proceeds;
      const pnl = (price - pos.entryPrice) * pos.qty;
      log(`STOP-LOSS ${symbol} | price=${price.toFixed(4)} entry=${pos.entryPrice.toFixed(4)} PnL=£${pnl.toFixed(2)} balance=£${balance.toFixed(2)}`);
      const trade = { time: new Date().toISOString(), symbol, side: 'SELL', reason: 'stop-loss', price, qty: pos.qty, pnl: +pnl.toFixed(2), balance: +balance.toFixed(2) };
      trades.push(trade);
      saveTrades();
      delete positions[symbol];
      return;
    }
    if (price >= pos.takeProfit) {
      const proceeds = pos.qty * price;
      balance += proceeds;
      const pnl = (price - pos.entryPrice) * pos.qty;
      log(`TAKE-PROFIT ${symbol} | price=${price.toFixed(4)} entry=${pos.entryPrice.toFixed(4)} PnL=£${pnl.toFixed(2)} balance=£${balance.toFixed(2)}`);
      const trade = { time: new Date().toISOString(), symbol, side: 'SELL', reason: 'take-profit', price, qty: pos.qty, pnl: +pnl.toFixed(2), balance: +balance.toFixed(2) };
      trades.push(trade);
      saveTrades();
      delete positions[symbol];
      return;
    }
  }

  marketSnapshot[symbol] = { price, ema9: +ema9.toFixed(4), ema21: +ema21.toFixed(4), rsi: +rsiVal.toFixed(1) };

  const bullish = rsiVal < 40;
  const bearish = ema9 < ema21 && rsiVal > 65;

  log(`${symbol} | price=${price.toFixed(4)} EMA9=${ema9.toFixed(4)} EMA21=${ema21.toFixed(4)} RSI=${rsiVal.toFixed(1)} pos=${pos ? 'OPEN' : 'NONE'}`);

  if (bullish && !pos) {
    const spend = balance * TRADE_PCT;
    if (spend < 1) { log(`Insufficient balance for ${symbol}`); return; }
    const qty = spend / price;
    balance -= spend;
    positions[symbol] = {
      qty,
      entryPrice: price,
      stopLoss: price * (1 - STOP_LOSS_PCT),
      takeProfit: price * (1 + TAKE_PROFIT_PCT),
    };
    log(`BUY  ${symbol} | qty=${qty.toFixed(6)} @ ${price.toFixed(4)} spend=£${spend.toFixed(2)} SL=${positions[symbol].stopLoss.toFixed(4)} TP=${positions[symbol].takeProfit.toFixed(4)} balance=£${balance.toFixed(2)}`);
    const trade = { time: new Date().toISOString(), symbol, side: 'BUY', reason: 'rsi<40', price, qty: +qty.toFixed(6), spend: +spend.toFixed(2), stopLoss: +positions[symbol].stopLoss.toFixed(4), takeProfit: +positions[symbol].takeProfit.toFixed(4), balance: +balance.toFixed(2) };
    trades.push(trade);
    saveTrades();
  } else if (bearish && pos) {
    const proceeds = pos.qty * price;
    balance += proceeds;
    const pnl = (price - pos.entryPrice) * pos.qty;
    log(`SELL ${symbol} | qty=${pos.qty.toFixed(6)} @ ${price.toFixed(4)} PnL=£${pnl.toFixed(2)} balance=£${balance.toFixed(2)}`);
    const trade = { time: new Date().toISOString(), symbol, side: 'SELL', reason: 'ema-cross+rsi', price, qty: pos.qty, pnl: +pnl.toFixed(2), balance: +balance.toFixed(2) };
    trades.push(trade);
    saveTrades();
    delete positions[symbol];
  }
}

async function tick() {
  log(`--- TICK | balance=£${balance.toFixed(2)} openPositions=${Object.keys(positions).join(',') || 'none'} ---`);
  for (const symbol of SYMBOLS) {
    await processSymbol(symbol);
    await delay(3000); // space out CoinGecko free-tier calls (~5 req/min)
  }
  saveState();
}

log('=== Crypto Momentum Bot Started ===');
log(`Symbols: ${SYMBOLS.join(', ')}`);
log(`Strategy: RSI14 + EMA9/21 | Buy RSI<40 | Sell RSI>65 EMA9<EMA21`);
log(`Risk: 5% per trade | SL 3% | TP 6% | Paper balance: £${balance}`);

// Stagger startup by 5s so server.js price fetch fires first
delay(5000).then(() => {
  tick();
  setInterval(tick, POLL_MS);
});
