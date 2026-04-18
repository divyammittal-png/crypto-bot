const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const TRADES_FILE = path.join(__dirname, 'trades.json');
const STATE_FILE  = path.join(__dirname, 'state.json');

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

app.get('/api/data', (req, res) => {
  const state  = readJSON(STATE_FILE,  { balance: 1000, startBalance: 1000, totalPnl: 0, positions: {}, market: {}, updatedAt: null });
  const trades = readJSON(TRADES_FILE, []);
  res.json({ state, trades });
});

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CRYPTO MOMENTUM BOT</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;600;700&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg:        #0a0c0f;
    --panel:     #0e1117;
    --border:    #1a2030;
    --green:     #00ff88;
    --green-dim: #00cc6a;
    --red:       #ff3b5c;
    --amber:     #ffb300;
    --blue:      #4da6ff;
    --muted:     #3a4a5c;
    --text:      #c8d8e8;
    --text-dim:  #5a7080;
  }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'JetBrains Mono', 'Courier New', monospace;
    font-size: 13px;
    line-height: 1.5;
    min-height: 100vh;
  }

  /* ── Header ── */
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 24px;
    border-bottom: 1px solid var(--border);
    background: var(--panel);
  }
  .header-left { display: flex; align-items: center; gap: 14px; }
  .logo {
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 3px;
    color: var(--green);
    text-shadow: 0 0 12px rgba(0,255,136,.35);
  }
  .status-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--green);
    box-shadow: 0 0 6px var(--green);
    animation: pulse 2s infinite;
  }
  @keyframes pulse {
    0%,100% { opacity: 1; }
    50%      { opacity: .4; }
  }
  .status-label { color: var(--green-dim); font-size: 11px; letter-spacing: 2px; }
  .header-right  { color: var(--text-dim); font-size: 11px; }
  #last-update   { color: var(--amber); }

  /* ── Layout ── */
  main { padding: 20px 24px; display: flex; flex-direction: column; gap: 20px; }

  /* ── Stat Cards ── */
  .cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 16px 18px;
    position: relative;
    overflow: hidden;
  }
  .card::before {
    content: '';
    position: absolute; top: 0; left: 0; right: 0;
    height: 2px;
  }
  .card.green::before  { background: var(--green); }
  .card.red::before    { background: var(--red); }
  .card.amber::before  { background: var(--amber); }
  .card.blue::before   { background: var(--blue); }

  .card-label { font-size: 10px; letter-spacing: 2px; color: var(--text-dim); text-transform: uppercase; margin-bottom: 8px; }
  .card-value { font-size: 26px; font-weight: 700; line-height: 1; }
  .card.green  .card-value { color: var(--green); }
  .card.amber  .card-value { color: var(--amber); }
  .card.blue   .card-value { color: var(--blue); }
  .card-sub { font-size: 11px; color: var(--text-dim); margin-top: 6px; }
  .up   { color: var(--green); }
  .down { color: var(--red); }

  /* ── Section titles ── */
  .section-title {
    font-size: 10px; letter-spacing: 3px; text-transform: uppercase;
    color: var(--text-dim); padding-bottom: 10px;
    border-bottom: 1px solid var(--border); margin-bottom: 12px;
    display: flex; align-items: center; gap: 8px;
  }
  .section-title span { color: var(--muted); }

  /* ── Market ticker ── */
  .market-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; }
  .ticker-card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 12px 14px;
  }
  .ticker-sym  { font-size: 11px; font-weight: 700; color: var(--blue); letter-spacing: 1px; margin-bottom: 6px; }
  .ticker-price { font-size: 16px; font-weight: 600; color: var(--text); }
  .ticker-row  { display: flex; justify-content: space-between; margin-top: 5px; font-size: 11px; color: var(--text-dim); }
  .ticker-row .val { color: var(--text); }
  .rsi-low  { color: var(--green) !important; }
  .rsi-high { color: var(--red)   !important; }
  .ema-bull { color: var(--green) !important; }
  .ema-bear { color: var(--red)   !important; }

  /* ── Two-column lower section ── */
  .lower { display: grid; grid-template-columns: 1fr 2fr; gap: 20px; }

  /* ── Tables ── */
  .panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }
  .panel-header {
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    font-size: 10px; letter-spacing: 2px;
    text-transform: uppercase; color: var(--text-dim);
    display: flex; align-items: center; justify-content: space-between;
  }
  .badge {
    background: var(--border); border-radius: 3px;
    padding: 2px 7px; font-size: 10px; color: var(--amber);
  }

  table { width: 100%; border-collapse: collapse; }
  th {
    text-align: left; font-size: 10px; letter-spacing: 1px;
    text-transform: uppercase; color: var(--text-dim);
    padding: 8px 16px; border-bottom: 1px solid var(--border);
    font-weight: 400;
  }
  td { padding: 8px 16px; border-bottom: 1px solid rgba(26,32,48,.6); font-size: 12px; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: rgba(255,255,255,.02); }

  .side-buy  { color: var(--green); font-weight: 600; }
  .side-sell { color: var(--red);   font-weight: 600; }
  .reason-tag {
    display: inline-block; font-size: 9px; padding: 1px 5px;
    border-radius: 2px; background: var(--border);
    color: var(--text-dim); letter-spacing: 1px;
  }
  .reason-tag.sl { background: rgba(255,59,92,.15); color: var(--red); }
  .reason-tag.tp { background: rgba(0,255,136,.12); color: var(--green); }

  .empty-row td { color: var(--muted); font-style: italic; text-align: center; padding: 24px; }

  /* ── PnL bar ── */
  .pnl-bar-wrap { height: 3px; background: var(--border); border-radius: 2px; margin-top: 4px; }
  .pnl-bar { height: 100%; border-radius: 2px; transition: width .4s; }

  /* ── Scrollable trade history ── */
  .scroll-body { max-height: 340px; overflow-y: auto; }
  .scroll-body::-webkit-scrollbar { width: 4px; }
  .scroll-body::-webkit-scrollbar-track { background: var(--panel); }
  .scroll-body::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

  /* ── Footer ── */
  footer {
    padding: 12px 24px; border-top: 1px solid var(--border);
    display: flex; gap: 24px; font-size: 10px; color: var(--text-dim);
    letter-spacing: 1px;
  }
  footer strong { color: var(--green); }
</style>
</head>
<body>

<header>
  <div class="header-left">
    <div class="logo">⬡ MOMENTUM BOT</div>
    <div class="status-dot"></div>
    <div class="status-label">LIVE PAPER</div>
  </div>
  <div class="header-right">LAST UPDATE: <span id="last-update">—</span></div>
</header>

<main>

  <!-- ── Stat cards ── -->
  <div class="cards">
    <div class="card green">
      <div class="card-label">Balance</div>
      <div class="card-value" id="balance">£—</div>
      <div class="card-sub" id="balance-chg">—</div>
    </div>
    <div class="card amber" id="pnl-card">
      <div class="card-label">Realised PnL</div>
      <div class="card-value" id="pnl">£—</div>
      <div class="card-sub" id="pnl-pct">—</div>
    </div>
    <div class="card blue">
      <div class="card-label">Open Positions</div>
      <div class="card-value" id="open-count">—</div>
      <div class="card-sub" id="unrealised">—</div>
    </div>
    <div class="card blue">
      <div class="card-label">Total Trades</div>
      <div class="card-value" id="trade-count">—</div>
      <div class="card-sub" id="win-rate">—</div>
    </div>
  </div>

  <!-- ── Market ticker ── -->
  <div>
    <div class="section-title">Market <span>// live 1m candles</span></div>
    <div class="market-grid" id="market-grid">
      <div class="ticker-card"><div class="ticker-sym">—</div></div>
    </div>
  </div>

  <!-- ── Positions + History ── -->
  <div class="lower">

    <!-- Open positions -->
    <div class="panel">
      <div class="panel-header">
        Open Positions
        <span class="badge" id="pos-badge">0</span>
      </div>
      <table>
        <thead><tr>
          <th>Symbol</th><th>Entry</th><th>P&amp;L</th>
        </tr></thead>
        <tbody id="positions-body">
          <tr class="empty-row"><td colspan="3">No open positions</td></tr>
        </tbody>
      </table>
    </div>

    <!-- Trade history -->
    <div class="panel">
      <div class="panel-header">
        Trade History
        <span class="badge" id="hist-badge">0</span>
      </div>
      <div class="scroll-body">
        <table>
          <thead><tr>
            <th>Time</th><th>Symbol</th><th>Side</th><th>Price</th><th>Qty</th><th>PnL</th><th>Reason</th>
          </tr></thead>
          <tbody id="history-body">
            <tr class="empty-row"><td colspan="7">Waiting for first trade…</td></tr>
          </tbody>
        </table>
      </div>
    </div>

  </div>
</main>

<footer>
  <div>STRATEGY: <strong>EMA 9/21 + RSI 14</strong></div>
  <div>BUY: <strong>EMA9 &gt; EMA21 &amp; RSI &lt; 35</strong></div>
  <div>SELL: <strong>EMA9 &lt; EMA21 &amp; RSI &gt; 65</strong></div>
  <div>RISK: <strong>5% / trade · SL 3% · TP 6%</strong></div>
  <div>PAIRS: <strong>BTC ETH SOL BNB XRP</strong></div>
</footer>

<script>
const fmt   = (n, d=2) => n == null ? '—' : Number(n).toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtP  = (n)       => n == null ? '—' : (n >= 0 ? '+' : '') + fmt(n) + '%';
const fmtTs = (iso)     => iso ? new Date(iso).toLocaleTimeString('en-GB') : '—';

function colPnl(v) {
  if (v == null) return '—';
  const cls = v >= 0 ? 'up' : 'down';
  return \`<span class="\${cls}">\${v >= 0 ? '+' : ''}£\${fmt(v)}</span>\`;
}

function reasonTag(r) {
  if (!r) return '';
  if (r === 'stop-loss')   return \`<span class="reason-tag sl">SL</span>\`;
  if (r === 'take-profit') return \`<span class="reason-tag tp">TP</span>\`;
  return \`<span class="reason-tag">\${r}</span>\`;
}

async function refresh() {
  let data;
  try {
    const res = await fetch('/api/data');
    data = await res.json();
  } catch { return; }

  const { state, trades } = data;
  const now = new Date().toLocaleTimeString('en-GB');
  document.getElementById('last-update').textContent = now;

  // ── Balance ──
  const balChg = state.balance - state.startBalance;
  document.getElementById('balance').textContent = '£' + fmt(state.balance);
  document.getElementById('balance-chg').innerHTML =
    \`Start £\${fmt(state.startBalance)} · <span class="\${balChg >= 0 ? 'up' : 'down'}">\${balChg >= 0 ? '+' : ''}£\${fmt(balChg)}</span>\`;

  // ── PnL ──
  const pnlPct = state.startBalance ? (state.totalPnl / state.startBalance * 100) : 0;
  document.getElementById('pnl').textContent = (state.totalPnl >= 0 ? '+£' : '-£') + fmt(Math.abs(state.totalPnl));
  document.getElementById('pnl').className    = 'card-value ' + (state.totalPnl >= 0 ? 'up' : 'down');
  document.getElementById('pnl-pct').innerHTML = fmtP(pnlPct) + ' vs start';

  // ── Open positions ──
  const positions = state.positions || {};
  const posKeys   = Object.keys(positions);
  document.getElementById('open-count').textContent = posKeys.length;
  document.getElementById('pos-badge').textContent  = posKeys.length;

  const totalUnreal = posKeys.reduce((s, k) => s + (positions[k].unrealisedPnl || 0), 0);
  document.getElementById('unrealised').innerHTML =
    \`Unrealised: <span class="\${totalUnreal >= 0 ? 'up' : 'down'}">\${totalUnreal >= 0 ? '+' : ''}£\${fmt(totalUnreal)}</span>\`;

  // Positions table
  const pb = document.getElementById('positions-body');
  if (posKeys.length === 0) {
    pb.innerHTML = '<tr class="empty-row"><td colspan="3">No open positions</td></tr>';
  } else {
    pb.innerHTML = posKeys.map(sym => {
      const p = positions[sym];
      const upnl = p.unrealisedPnl;
      const slPct = (((p.currentPrice || p.entryPrice) - p.stopLoss) / p.entryPrice * 100).toFixed(1);
      const tpPct = ((p.takeProfit - p.entryPrice) / p.entryPrice * 100).toFixed(1);
      return \`<tr>
        <td><span style="color:var(--blue);font-weight:600">\${sym.replace('USDT','')}</span></td>
        <td>
          <div style="color:var(--text)">£\${fmt(p.entryPrice, 4)}</div>
          <div style="font-size:10px;color:var(--text-dim)">SL \${p.stopLoss.toFixed(4)} · TP \${p.takeProfit.toFixed(4)}</div>
        </td>
        <td>\${colPnl(upnl)}</td>
      </tr>\`;
    }).join('');
  }

  // ── Trade history ──
  const sells = trades.filter(t => t.side === 'SELL' && t.pnl != null);
  const wins  = sells.filter(t => t.pnl > 0).length;
  const wr    = sells.length ? (wins / sells.length * 100).toFixed(0) : '—';
  document.getElementById('trade-count').textContent = trades.length;
  document.getElementById('hist-badge').textContent  = trades.length;
  document.getElementById('win-rate').innerHTML = sells.length
    ? \`Win rate: <span class="up">\${wr}%</span> (\${wins}/\${sells.length} sells)\`
    : 'No closed trades yet';

  const hb = document.getElementById('history-body');
  if (trades.length === 0) {
    hb.innerHTML = '<tr class="empty-row"><td colspan="7">Waiting for first trade…</td></tr>';
  } else {
    hb.innerHTML = [...trades].reverse().map(t => \`<tr>
      <td style="color:var(--text-dim);font-size:11px">\${fmtTs(t.time)}</td>
      <td style="color:var(--blue);font-weight:600">\${t.symbol.replace('USDT','')}</td>
      <td><span class="side-\${t.side.toLowerCase()}">\${t.side}</span></td>
      <td>\${fmt(t.price, 4)}</td>
      <td style="color:var(--text-dim)">\${t.qty ? Number(t.qty).toFixed(6) : '—'}</td>
      <td>\${t.side === 'SELL' ? colPnl(t.pnl) : '<span style="color:var(--text-dim)">—</span>'}</td>
      <td>\${reasonTag(t.reason)}</td>
    </tr>\`).join('');
  }

  // ── Market ticker ──
  const market = state.market || {};
  const syms   = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT'];
  const mg = document.getElementById('market-grid');
  mg.innerHTML = syms.map(sym => {
    const m = market[sym];
    if (!m) return \`<div class="ticker-card"><div class="ticker-sym">\${sym.replace('USDT','')}</div><div style="color:var(--text-dim);font-size:11px">loading…</div></div>\`;
    const emaCls   = m.ema9 > m.ema21 ? 'ema-bull' : 'ema-bear';
    const emaLabel = m.ema9 > m.ema21 ? '▲ BULL'   : '▼ BEAR';
    const rsiCls   = m.rsi < 35 ? 'rsi-low' : m.rsi > 65 ? 'rsi-high' : '';
    const hasPos   = !!positions[sym];
    return \`<div class="ticker-card" style="\${hasPos ? 'border-color:rgba(0,255,136,.3)' : ''}">
      <div class="ticker-sym">\${sym.replace('USDT','')} \${hasPos ? '<span style="color:var(--green);font-size:9px">● LONG</span>' : ''}</div>
      <div class="ticker-price">\${fmt(m.price, sym.includes('BTC') ? 2 : sym.includes('XRP') ? 4 : 2)}</div>
      <div class="ticker-row"><span>EMA</span><span class="val \${emaCls}">\${emaLabel}</span></div>
      <div class="ticker-row"><span>RSI</span><span class="val \${rsiCls}">\${m.rsi}</span></div>
    </div>\`;
  }).join('');
}

refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Dashboard running at http://localhost:${PORT}`);
});
