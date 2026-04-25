'use strict';
// ══════════════════════════════════════════════════════════════════════════════
// APEX BOT — Dashboard Server
// ══════════════════════════════════════════════════════════════════════════════
const express = require('express');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const { dataPath } = require('./storage');

const F = {
  state:         dataPath('state.json'),
  trades:        dataPath('trades.json'),
  learning:      dataPath('learning.json'),
  sentiment:     dataPath('sentiment.json'),
  weights:       dataPath('strategy-weights.json'),
  reports:       dataPath('reports.json'),
  analystReports:dataPath('analyst-reports.json'),
  config:        dataPath('config.json'),
  configLog:     dataPath('config-log.json'),
  backtest:      dataPath('backtest-results.json'),
};

const ALL_ASSETS = ['BTC','ETH','SOL','BNB','XRP','AAPL','TSLA','NVDA','SPY','AMZN','MSFT','GOOGL','META','NFLX','JPM','QQQ','GC=F','SI=F','CL=F','NG=F'];

const DEFAULT_CONFIG = {
  strategyWeights: { ptj:1, statArb:1, multiFactor:1, allWeather:1 },
  rsiPeriod:14, rsiOversold:35, rsiOverbought:65,
  emaFast:9, emaSlow:21, bbPeriod:20, bbStdDev:2.0,
  macdFast:12, macdSlow:26, riskReward:3,
  maxTradeRisk:1.0, kellyFraction:50,
  killSwitchThreshold:-20, maxPortfolioHeat:60, cashBuffer:20,
  cryptoMax:40, equitiesMax:50, commoditiesMax:30,
  enabledAssets: Object.fromEntries(ALL_ASSETS.map(a=>[a,true])),
};

const PRESETS = {
  SAFE:       { maxTradeRisk:0.5, kellyFraction:25, killSwitchThreshold:-10, maxPortfolioHeat:30, strategyWeights:{ptj:0,statArb:0,multiFactor:0,allWeather:1} },
  BALANCED:   DEFAULT_CONFIG,
  AGGRESSIVE: { maxTradeRisk:2.0, kellyFraction:75, killSwitchThreshold:-25, maxPortfolioHeat:70, strategyWeights:{ptj:1,statArb:1,multiFactor:1,allWeather:1} },
  YOLO:       { maxTradeRisk:5.0, kellyFraction:100,killSwitchThreshold:-30, maxPortfolioHeat:90, strategyWeights:{ptj:2,statArb:2,multiFactor:2,allWeather:2} },
  HOLIDAY:    { maxTradeRisk:0.2, kellyFraction:20, killSwitchThreshold:-10, maxPortfolioHeat:20, strategyWeights:{ptj:0,statArb:0,multiFactor:0,allWeather:1} },
};

function loadJSON(f) { try { return JSON.parse(fs.readFileSync(f,'utf8')); } catch { return null; } }
function saveJSON(f,d) { try { fs.writeFileSync(f,JSON.stringify(d,null,2)); } catch(e) { console.error(e); } }

app.use(express.json());

// ─── API ENDPOINTS ────────────────────────────────────────────────────────────
app.get('/api/data', (req, res) => {
  const state   = loadJSON(F.state) || {};
  const trades  = loadJSON(F.trades) || [];
  const weights = loadJSON(F.weights) || {};
  res.json({ state, trades: trades.slice(-50), weights });
});

app.get('/api/learning', (req, res) => res.json(loadJSON(F.learning) || []));
app.get('/api/report',   (req, res) => res.json((loadJSON(F.reports) || [])[0] || null));
app.get('/api/backtest', (req, res) => res.json(loadJSON(F.backtest) || { error:'No results yet' }));
app.get('/api/sentiment',(req, res) => res.json(loadJSON(F.sentiment) || {}));
app.get('/api/config',   (req, res) => res.json(loadJSON(F.config) || DEFAULT_CONFIG));
app.get('/api/regime',   (req, res) => {
  const s = loadJSON(F.state) || {};
  res.json({ regime: s.regime||'UNKNOWN', reason:s.regimeReason||'', changedAt:s.regimeChangedAt||'' });
});

app.post('/api/config', (req, res) => {
  const current = loadJSON(F.config) || { ...DEFAULT_CONFIG };
  const updated = { ...current, ...req.body };
  saveJSON(F.config, updated);

  // Log the change
  const logEntry = { timestamp:new Date().toISOString(), changes: req.body };
  const configLog = loadJSON(F.configLog) || [];
  configLog.unshift(logEntry);
  saveJSON(F.configLog, configLog.slice(0,10));

  res.json({ ok:true, config:updated });
});

app.post('/api/preset', (req, res) => {
  const { preset } = req.body;
  const presetConfig = PRESETS[preset];
  if (!presetConfig) return res.status(400).json({ error:'Unknown preset' });
  const current = loadJSON(F.config) || { ...DEFAULT_CONFIG };
  const updated = { ...current, ...presetConfig, preset };
  saveJSON(F.config, updated);
  const logEntry = { timestamp:new Date().toISOString(), changes:{ preset } };
  const configLog = loadJSON(F.configLog) || [];
  configLog.unshift(logEntry);
  saveJSON(F.configLog, configLog.slice(0,10));
  res.json({ ok:true, config:updated });
});

app.get('/api/analyst-report', (req, res) => {
  const reports = loadJSON(F.analystReports) || [];
  res.json(reports[0] || null);
});

let reportGenerating = false;
app.post('/api/generate-report', async (req, res) => {
  if (reportGenerating) return res.status(409).json({ error: 'Report generation already in progress' });
  reportGenerating = true;
  res.json({ ok: true, message: 'Report generation started' });
  try {
    const { generateDailyReport } = require('./analyst');
    await generateDailyReport();
  } catch(e) {
    console.error('[SERVER] generate-report error:', e.message);
  } finally {
    reportGenerating = false;
  }
});

app.post('/api/killswitch/reset', (req, res) => {
  const state = loadJSON(F.state) || {};
  if (state.killSwitch) { state.killSwitch.triggered = false; state.killSwitch.reason = null; }
  saveJSON(F.state, state);
  res.json({ ok:true });
});

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send(DASHBOARD_HTML));

// ──────────────────────────────────────────────────────────────────────────────
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>APEX BOT — Hedge Fund Grade Trading System</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
:root {
  --bg:#ffffff; --bg2:#f8f9fa; --bg3:#f0f2f5;
  --border:#e2e8f0; --text:#1a202c; --muted:#718096;
  --green:#00b341; --red:#e53e3e; --yellow:#d69e2e; --blue:#3182ce;
  --green-light:#e6f7ee; --red-light:#fff5f5; --yellow-light:#fffff0;
  --shadow: 0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04);
  --shadow-md: 0 4px 6px rgba(0,0,0,0.05), 0 1px 3px rgba(0,0,0,0.08);
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',sans-serif;font-size:13px;line-height:1.5}
h2{font-size:14px;font-weight:600;color:var(--text);margin-bottom:12px;text-transform:uppercase;letter-spacing:.05em}
h3{font-size:13px;font-weight:600;color:var(--muted);margin-bottom:8px}

/* LAYOUT */
.header{background:#fff;border-bottom:1px solid var(--border);padding:0 20px;height:56px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;box-shadow:var(--shadow)}
.logo{font-size:18px;font-weight:800;letter-spacing:-.5px;color:var(--text)}
.logo span{color:var(--blue)}
.regime-badge{padding:6px 14px;border-radius:20px;font-weight:600;font-size:12px;display:flex;align-items:center;gap:6px}
.regime-RISK_ON{background:#e6f7ee;color:#00b341;border:1px solid #b7ebc7}
.regime-RISK_OFF{background:#fff5f5;color:#e53e3e;border:1px solid #fed7d7}
.regime-STAGFLATION{background:#fffff0;color:#d69e2e;border:1px solid #fef08a}
.header-right{display:flex;align-items:center;gap:12px;font-size:12px;color:var(--muted)}
.kill-status{padding:4px 10px;border-radius:12px;font-weight:600;font-size:11px}
.kill-armed{background:#e6f7ee;color:#00b341}
.kill-triggered{background:#fff5f5;color:#e53e3e;animation:pulse 1s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.6}}

.main{padding:16px 20px;max-width:1600px;margin:0 auto}
.section{background:#fff;border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:16px;box-shadow:var(--shadow)}

/* STAT CARDS */
.stats-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:12px;margin-bottom:16px}
@media(max-width:1400px){.stats-grid{grid-template-columns:repeat(4,1fr)}}
@media(max-width:768px){.stats-grid{grid-template-columns:repeat(2,1fr)}}
.stat-card{background:#fff;border:1px solid var(--border);border-radius:10px;padding:14px;box-shadow:var(--shadow);position:relative;overflow:hidden}
.stat-card::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;border-radius:3px 0 0 3px}
.stat-card.blue::before{background:var(--blue)}
.stat-card.green::before{background:var(--green)}
.stat-card.red::before{background:var(--red)}
.stat-card.yellow::before{background:var(--yellow)}
.stat-card.purple::before{background:#805ad5}
.stat-card.teal::before{background:#319795}
.stat-label{font-size:11px;color:var(--muted);font-weight:500;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px}
.stat-value{font-size:22px;font-weight:700;color:var(--text);line-height:1.1}
.stat-sub{font-size:11px;color:var(--muted);margin-top:3px}
.up{color:var(--green)} .dn{color:var(--red)}

/* CHART */
.chart-wrap{position:relative;height:250px}
.chart-row{display:grid;grid-template-columns:2fr 1fr;gap:16px;margin-bottom:16px}
@media(max-width:900px){.chart-row{grid-template-columns:1fr}}

/* HEATMAP */
.heatmap-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:6px}
.heat-cell{border-radius:6px;padding:8px 6px;text-align:center;cursor:pointer;transition:transform .1s}
.heat-cell:hover{transform:scale(1.04)}
.heat-name{font-weight:700;font-size:12px}
.heat-price{font-size:10px;opacity:.85;margin:2px 0}
.heat-chg{font-size:10px;font-weight:600}
.heat-score{font-size:9px;opacity:.7;margin-top:2px}

/* TABLES */
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:12px}
th{background:var(--bg2);font-weight:600;color:var(--muted);text-align:left;padding:8px 10px;white-space:nowrap;border-bottom:2px solid var(--border);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
td{padding:7px 10px;border-bottom:1px solid var(--border);white-space:nowrap}
tr:last-child td{border-bottom:none}
tr.win td{background:#f0fff4}
tr.loss td{background:#fff5f5}
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600}
.badge-long{background:#e6f7ee;color:var(--green)}
.badge-short{background:#fff5f5;color:var(--red)}
.badge-hold{background:var(--bg3);color:var(--muted)}
.sharpe-green{color:var(--green);font-weight:700}
.sharpe-yellow{color:var(--yellow);font-weight:700}
.sharpe-red{color:var(--red);font-weight:700}
.pnl-label{font-size:10px;font-weight:700;letter-spacing:.03em;vertical-align:middle}
.pnl-label-profit{color:var(--green)}
.pnl-label-loss{color:var(--red)}
.badge-win{background:#e6f7ee;color:var(--green)}
.badge-loss-result{background:#fff5f5;color:var(--red)}

/* RISK MONITOR */
.risk-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
@media(max-width:768px){.risk-grid{grid-template-columns:repeat(2,1fr)}}
.risk-card{background:var(--bg2);border-radius:8px;padding:12px;text-align:center}
.risk-label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
.risk-val{font-size:20px;font-weight:700}
.gauge-bar{height:8px;border-radius:4px;background:var(--border);margin-top:6px;overflow:hidden}
.gauge-fill{height:100%;border-radius:4px;transition:width .5s}

/* SENTIMENT */
.sentiment-list{display:flex;flex-direction:column;gap:4px}
.sent-row{display:grid;grid-template-columns:60px 1fr 50px;align-items:center;gap:8px}
.sent-bar-wrap{height:6px;background:var(--border);border-radius:3px;overflow:hidden}
.sent-bar{height:100%;border-radius:3px;transition:width .5s}
.sent-score{font-size:11px;font-weight:600;text-align:right}
.sent-name{font-size:11px;font-weight:600;color:var(--muted)}

/* DJ CONSOLE */
.dj-header{display:flex;align-items:center;justify-content:space-between;cursor:pointer;user-select:none;padding:4px 0}
.dj-header svg{transition:transform .2s}
.dj-header.open svg{transform:rotate(180deg)}
.dj-body{display:none;padding-top:16px}
.dj-body.open{display:block}
.dj-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:20px}
.dj-section{margin-bottom:20px}
.dj-section-title{font-size:11px;font-weight:700;color:var(--blue);text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px;padding-bottom:4px;border-bottom:2px solid var(--blue);display:inline-block}
.slider-row{margin-bottom:10px}
.slider-label{display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-bottom:3px}
.slider-label span:last-child{font-weight:700;color:var(--text)}
input[type=range]{width:100%;height:4px;border-radius:2px;-webkit-appearance:none;appearance:none;background:linear-gradient(to right,var(--blue) 0%,var(--border) 0%);outline:none;cursor:pointer}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:var(--blue);cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.2)}
.toggle-row{display:flex;align-items:center;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border)}
.toggle-label{font-size:12px;color:var(--text)}
.toggle{position:relative;width:34px;height:18px;display:inline-block}
.toggle input{opacity:0;width:0;height:0}
.slider-toggle{position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:var(--border);border-radius:18px;transition:.2s}
.slider-toggle:before{position:absolute;content:'';height:14px;width:14px;left:2px;bottom:2px;background:#fff;border-radius:50%;transition:.2s}
.toggle input:checked + .slider-toggle{background:var(--green)}
.toggle input:checked + .slider-toggle:before{transform:translateX(16px)}
.preset-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px}
.preset-btn{padding:8px 4px;border:1px solid var(--border);border-radius:8px;background:#fff;cursor:pointer;font-size:12px;font-weight:600;transition:all .15s;text-align:center}
.preset-btn:hover{background:var(--bg2);transform:translateY(-1px);box-shadow:var(--shadow)}
.btn-primary{background:var(--blue);color:#fff;border:none;border-radius:8px;padding:10px 20px;font-size:13px;font-weight:600;cursor:pointer;transition:all .15s}
.btn-primary:hover{background:#2c6cbf;box-shadow:var(--shadow-md)}
.btn-danger{background:var(--red);color:#fff;border:none;border-radius:8px;padding:10px 20px;font-size:13px;font-weight:600;cursor:pointer}
.btn-secondary{background:var(--bg2);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:10px 20px;font-size:13px;font-weight:600;cursor:pointer}
.btn-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:16px}
.change-log{font-size:11px;color:var(--muted);margin-top:12px;background:var(--bg2);border-radius:6px;padding:8px 10px}
.change-log-title{font-weight:600;color:var(--text);margin-bottom:6px}
.change-entry{padding:3px 0;border-bottom:1px solid var(--border)}
.change-entry:last-child{border-bottom:none}
.tabs{display:flex;gap:0;border-bottom:2px solid var(--border);margin-bottom:16px}
.tab{padding:8px 16px;font-size:12px;font-weight:600;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-2px;transition:all .15s}
.tab.active{color:var(--blue);border-bottom-color:var(--blue)}
.tab-content{display:none} .tab-content.active{display:block}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:768px){.two-col{grid-template-columns:1fr}}
.scorecard table th,.scorecard table td{text-align:center}
.scorecard table th:first-child,.scorecard table td:first-child{text-align:left}

/* ANALYST REPORT */
.report-meta{font-size:11px;color:var(--muted);margin-bottom:16px;display:flex;gap:16px;flex-wrap:wrap}
.report-meta span{display:flex;align-items:center;gap:4px}
.report-body h2{font-size:14px;font-weight:700;color:var(--text);margin:16px 0 6px;padding-bottom:4px;border-bottom:1px solid var(--border);text-transform:none;letter-spacing:0}
.report-body ul{margin:4px 0 10px 18px;padding:0}
.report-body li{margin:2px 0;color:var(--text)}
.report-body p{margin:0 0 8px;color:var(--text);line-height:1.7}
.report-body strong{font-weight:700}
.config-applied{background:#fffff0;border:1px solid #fef08a;border-radius:8px;padding:12px 16px;margin-top:16px}
.config-applied-title{font-size:11px;font-weight:700;color:#d69e2e;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px}
.config-applied pre{font-size:12px;color:var(--text);margin:0;white-space:pre-wrap}
</style>
</head>
<body>

<!-- HEADER -->
<div class="header">
  <div style="display:flex;align-items:center;gap:10px">
    <div class="logo">APEX<span>BOT</span></div>
    <div style="font-size:10px;color:var(--muted);font-weight:500;margin-top:2px">Hedge Fund Grade · Paper Trading</div>
  </div>
  <div id="regime-badge" class="regime-badge regime-RISK_ON">🟢 RISK-ON</div>
  <div class="header-right">
    <span id="last-update">Loading...</span>
    <div id="kill-status" class="kill-status kill-armed">⚡ ARMED</div>
  </div>
</div>

<div class="main">

<!-- STAT CARDS -->
<div class="stats-grid">
  <div class="stat-card blue">
    <div class="stat-label">Total NAV</div>
    <div class="stat-value" id="s-nav">£—</div>
    <div class="stat-sub" id="s-nav-sub">from £1,000</div>
  </div>
  <div class="stat-card green">
    <div class="stat-label">Today P&amp;L</div>
    <div class="stat-value" id="s-today">£—</div>
    <div class="stat-sub" id="s-today-pct">0.00%</div>
  </div>
  <div class="stat-card" id="realised-pnl-card">
    <div class="stat-label">Realised P&amp;L</div>
    <div class="stat-value" id="s-realised-pnl">£—</div>
    <div class="stat-sub" id="s-realised-sub">closed trades</div>
  </div>
  <div class="stat-card" id="unrealised-pnl-card">
    <div class="stat-label">Unrealised P&amp;L</div>
    <div class="stat-value" id="s-unrealised-pnl">£—</div>
    <div class="stat-sub" id="s-unrealised-sub">open positions</div>
  </div>
  <div class="stat-card yellow">
    <div class="stat-label">Open Positions</div>
    <div class="stat-value" id="s-open">0</div>
    <div class="stat-sub" id="s-open-sub">across all profiles</div>
  </div>
  <div class="stat-card purple">
    <div class="stat-label">Portfolio Heat</div>
    <div class="stat-value" id="s-heat">0%</div>
    <div class="stat-sub" id="s-heat-sub">max 60%</div>
  </div>
  <div class="stat-card teal">
    <div class="stat-label">Best Strategy</div>
    <div class="stat-value" id="s-best" style="font-size:14px">—</div>
    <div class="stat-sub" id="s-best-sub">today</div>
  </div>
</div>

<!-- CHARTS ROW -->
<div class="chart-row">
  <div class="section">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <h2>Equity Curve</h2>
      <div style="display:flex;gap:8px;font-size:11px">
        <label style="cursor:pointer;display:flex;align-items:center;gap:4px"><input type="checkbox" id="toggle-ptj" checked> Aggressive</label>
        <label style="cursor:pointer;display:flex;align-items:center;gap:4px"><input type="checkbox" id="toggle-stat" checked> Balanced</label>
        <label style="cursor:pointer;display:flex;align-items:center;gap:4px"><input type="checkbox" id="toggle-mf" checked> Conservative</label>
      </div>
    </div>
    <div class="chart-wrap"><canvas id="equity-chart"></canvas></div>
  </div>
  <div class="section">
    <h2>VaR &amp; Risk Gauges</h2>
    <div class="risk-grid">
      <div class="risk-card">
        <div class="risk-label">Portfolio Heat</div>
        <div class="risk-val" id="g-heat">—</div>
        <div class="gauge-bar"><div class="gauge-fill" id="g-heat-bar" style="background:var(--yellow);width:0%"></div></div>
      </div>
      <div class="risk-card">
        <div class="risk-label">Drawdown</div>
        <div class="risk-val" id="g-dd">—</div>
        <div class="gauge-bar"><div class="gauge-fill" id="g-dd-bar" style="background:var(--red);width:0%"></div></div>
      </div>
      <div class="risk-card">
        <div class="risk-label">Daily VaR 95%</div>
        <div class="risk-val" id="g-var">—</div>
        <div class="gauge-bar"><div class="gauge-fill" id="g-var-bar" style="background:var(--blue);width:0%"></div></div>
      </div>
      <div class="risk-card">
        <div class="risk-label">Corr. Risk</div>
        <div class="risk-val" id="g-corr">—</div>
        <div class="gauge-bar"><div class="gauge-fill" id="g-corr-bar" style="background:var(--purple,#805ad5);width:0%"></div></div>
      </div>
    </div>
  </div>
</div>

<!-- ASSET HEATMAP -->
<div class="section">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
    <h2>Asset Heatmap</h2>
    <span style="font-size:11px;color:var(--muted)">Cell colour = signal strength · Size = position size</span>
  </div>
  <div class="heatmap-grid" id="heatmap"></div>
</div>

<!-- TABS: Scorecard / Positions / Trades / Macro & Sentiment -->
<div class="section">
  <div class="tabs">
    <div class="tab active" onclick="switchTab('scorecard',this)">Strategy Scorecard</div>
    <div class="tab" onclick="switchTab('positions',this)">Open Positions</div>
    <div class="tab" onclick="switchTab('trades',this)">Trade History</div>
    <div class="tab" onclick="switchTab('macro',this)">Macro &amp; Sentiment</div>
  </div>

  <!-- SCORECARD -->
  <div id="tab-scorecard" class="tab-content active scorecard">
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th rowspan="2">Strategy</th>
            <th colspan="6" style="text-align:center;border-left:2px solid var(--border)">AGGRESSIVE</th>
            <th colspan="6" style="text-align:center;border-left:2px solid var(--border)">BALANCED</th>
            <th colspan="6" style="text-align:center;border-left:2px solid var(--border)">CONSERVATIVE</th>
          </tr>
          <tr>
            <th style="border-left:2px solid var(--border)">WR%</th><th>Sharpe</th><th>MaxDD</th><th>Trades</th><th>P&amp;L</th><th>Wt</th>
            <th style="border-left:2px solid var(--border)">WR%</th><th>Sharpe</th><th>MaxDD</th><th>Trades</th><th>P&amp;L</th><th>Wt</th>
            <th style="border-left:2px solid var(--border)">WR%</th><th>Sharpe</th><th>MaxDD</th><th>Trades</th><th>P&amp;L</th><th>Wt</th>
          </tr>
        </thead>
        <tbody id="scorecard-body"></tbody>
      </table>
    </div>
  </div>

  <!-- POSITIONS -->
  <div id="tab-positions" class="tab-content">
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Asset</th><th>Strategy</th><th>Profile</th><th>Side</th><th>Entry</th><th>Current</th><th>Unrealised P&amp;L</th><th>Stop Loss</th><th>Take Profit</th><th>Duration</th>
          </tr>
        </thead>
        <tbody id="positions-body"></tbody>
      </table>
    </div>
  </div>

  <!-- TRADES -->
  <div id="tab-trades" class="tab-content">
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Time</th><th>Asset</th><th>Strategy</th><th>Profile</th><th>Side</th><th>Entry</th><th>Exit</th><th>P&amp;L</th><th>Result</th><th>Reason</th>
          </tr>
        </thead>
        <tbody id="trades-body"></tbody>
      </table>
    </div>
  </div>

  <!-- MACRO & SENTIMENT -->
  <div id="tab-macro" class="tab-content">
    <div class="two-col">
      <div>
        <h3>Current Macro Regime</h3>
        <div id="regime-detail" style="padding:12px;background:var(--bg2);border-radius:8px;margin-bottom:16px;font-size:13px"></div>
        <h3>Backtest Summary</h3>
        <div id="backtest-summary" style="padding:12px;background:var(--bg2);border-radius:8px;font-size:12px"></div>
      </div>
      <div>
        <h3>Sentiment Scores (−1 bearish → +1 bullish)</h3>
        <div class="sentiment-list" id="sentiment-list"></div>
      </div>
    </div>
  </div>
</div>

<!-- DJ TRADING CONSOLE -->
<div class="section">
  <div class="dj-header" onclick="toggleDJ(this)">
    <h2 style="margin:0">🎛️ DJ Trading Console</h2>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
  </div>
  <div class="dj-body" id="dj-body">

    <!-- PRESETS -->
    <div class="preset-grid">
      <button class="preset-btn" onclick="applyPreset('SAFE')">🔴 SAFE MODE</button>
      <button class="preset-btn" onclick="applyPreset('BALANCED')">🟡 BALANCED</button>
      <button class="preset-btn" onclick="applyPreset('AGGRESSIVE')">🟢 AGGRESSIVE</button>
      <button class="preset-btn" onclick="applyPreset('YOLO')">🚀 YOLO</button>
      <button class="preset-btn" onclick="applyPreset('HOLIDAY')">🏖️ HOLIDAY MODE</button>
      <button class="preset-btn" onclick="toggleBacktestMode()">🧪 BACKTEST MODE</button>
    </div>

    <div class="dj-grid">

      <!-- STRATEGY MIX -->
      <div class="dj-section">
        <div class="dj-section-title">Strategy Mix</div>
        ${['ptj','statArb','multiFactor','allWeather'].map(s => `
        <div class="slider-row">
          <div class="slider-label"><span>${s==='ptj'?'PTJ Trend':s==='statArb'?'Stat-Arb':s==='multiFactor'?'Multi-Factor':'All-Weather'}</span><span id="lbl-sw-${s}">1</span></div>
          <input type="range" id="sw-${s}" min="0" max="4" step="0.1" value="1" oninput="updateLabel('lbl-sw-${s}',this.value)">
        </div>`).join('')}
      </div>

      <!-- SIGNAL SENSITIVITY -->
      <div class="dj-section">
        <div class="dj-section-title">Signal Sensitivity</div>
        <div class="slider-row"><div class="slider-label"><span>RSI Period</span><span id="lbl-rsiPeriod">14</span></div><input type="range" id="rsiPeriod" min="5" max="30" value="14" oninput="updateLabel('lbl-rsiPeriod',this.value)"></div>
        <div class="slider-row"><div class="slider-label"><span>RSI Oversold</span><span id="lbl-rsiOversold">35</span></div><input type="range" id="rsiOversold" min="20" max="50" value="35" oninput="updateLabel('lbl-rsiOversold',this.value)"></div>
        <div class="slider-row"><div class="slider-label"><span>RSI Overbought</span><span id="lbl-rsiOverbought">65</span></div><input type="range" id="rsiOverbought" min="50" max="80" value="65" oninput="updateLabel('lbl-rsiOverbought',this.value)"></div>
        <div class="slider-row"><div class="slider-label"><span>EMA Fast</span><span id="lbl-emaFast">9</span></div><input type="range" id="emaFast" min="5" max="20" value="9" oninput="updateLabel('lbl-emaFast',this.value)"></div>
        <div class="slider-row"><div class="slider-label"><span>EMA Slow</span><span id="lbl-emaSlow">21</span></div><input type="range" id="emaSlow" min="15" max="50" value="21" oninput="updateLabel('lbl-emaSlow',this.value)"></div>
        <div class="slider-row"><div class="slider-label"><span>BB Period</span><span id="lbl-bbPeriod">20</span></div><input type="range" id="bbPeriod" min="10" max="50" value="20" oninput="updateLabel('lbl-bbPeriod',this.value)"></div>
        <div class="slider-row"><div class="slider-label"><span>BB Std Dev</span><span id="lbl-bbStdDev">2.0</span></div><input type="range" id="bbStdDev" min="1.0" max="3.0" step="0.1" value="2.0" oninput="updateLabel('lbl-bbStdDev',parseFloat(this.value).toFixed(1))"></div>
        <div class="slider-row"><div class="slider-label"><span>MACD Fast</span><span id="lbl-macdFast">12</span></div><input type="range" id="macdFast" min="8" max="20" value="12" oninput="updateLabel('lbl-macdFast',this.value)"></div>
        <div class="slider-row"><div class="slider-label"><span>MACD Slow</span><span id="lbl-macdSlow">26</span></div><input type="range" id="macdSlow" min="20" max="40" value="26" oninput="updateLabel('lbl-macdSlow',this.value)"></div>
      </div>

      <!-- RISK & CAPITAL -->
      <div class="dj-section">
        <div class="dj-section-title">Risk &amp; Capital</div>
        <div class="slider-row"><div class="slider-label"><span>Risk:Reward</span><span id="lbl-riskReward">1:3</span></div><input type="range" id="riskReward" min="1" max="10" value="3" oninput="updateLabel('lbl-riskReward','1:'+this.value)"></div>
        <div class="slider-row"><div class="slider-label"><span>Max Trade Risk %</span><span id="lbl-maxTradeRisk">1.0%</span></div><input type="range" id="maxTradeRisk" min="0.1" max="5" step="0.1" value="1.0" oninput="updateLabel('lbl-maxTradeRisk',parseFloat(this.value).toFixed(1)+'%')"></div>
        <div class="slider-row"><div class="slider-label"><span>Kelly Fraction %</span><span id="lbl-kellyFraction">50%</span></div><input type="range" id="kellyFraction" min="25" max="100" value="50" oninput="updateLabel('lbl-kellyFraction',this.value+'%')"></div>
        <div class="slider-row"><div class="slider-label"><span>Kill Switch %</span><span id="lbl-killSwitchThreshold">-20%</span></div><input type="range" id="killSwitchThreshold" min="-30" max="-10" value="-20" oninput="updateLabel('lbl-killSwitchThreshold',this.value+'%')"></div>
        <div class="slider-row"><div class="slider-label"><span>Max Heat %</span><span id="lbl-maxPortfolioHeat">60%</span></div><input type="range" id="maxPortfolioHeat" min="30" max="90" value="60" oninput="updateLabel('lbl-maxPortfolioHeat',this.value+'%')"></div>
        <div class="slider-row"><div class="slider-label"><span>Cash Buffer %</span><span id="lbl-cashBuffer">20%</span></div><input type="range" id="cashBuffer" min="5" max="30" value="20" oninput="updateLabel('lbl-cashBuffer',this.value+'%')"></div>
      </div>

      <!-- ASSET CLASS LIMITS -->
      <div class="dj-section">
        <div class="dj-section-title">Asset Class Limits</div>
        <div class="slider-row"><div class="slider-label"><span>Crypto Max %</span><span id="lbl-cryptoMax">40%</span></div><input type="range" id="cryptoMax" min="0" max="60" value="40" oninput="updateLabel('lbl-cryptoMax',this.value+'%')"></div>
        <div class="slider-row"><div class="slider-label"><span>Equities Max %</span><span id="lbl-equitiesMax">50%</span></div><input type="range" id="equitiesMax" min="0" max="70" value="50" oninput="updateLabel('lbl-equitiesMax',this.value+'%')"></div>
        <div class="slider-row"><div class="slider-label"><span>Commodities Max %</span><span id="lbl-commoditiesMax">30%</span></div><input type="range" id="commoditiesMax" min="0" max="50" value="30" oninput="updateLabel('lbl-commoditiesMax',this.value+'%')"></div>
      </div>

      <!-- ASSET TOGGLES -->
      <div class="dj-section">
        <div class="dj-section-title">Asset Toggles</div>
        <div id="asset-toggles">
          ${ALL_ASSETS.map(a => `
          <div class="toggle-row">
            <span class="toggle-label">${a}</span>
            <label class="toggle"><input type="checkbox" id="asset-${a.replace('=','_')}" checked><span class="slider-toggle"></span></label>
          </div>`).join('')}
        </div>
      </div>

    </div><!-- /dj-grid -->

    <!-- BUTTONS & LOG -->
    <div class="btn-row">
      <button class="btn-primary" onclick="applyChanges()">✅ Apply Changes</button>
      <button class="btn-secondary" onclick="resetDefaults()">↺ Reset to Defaults</button>
      <button class="btn-danger" onclick="resetKillSwitch()">⚡ Reset Kill Switch</button>
    </div>

    <div class="change-log">
      <div class="change-log-title">Console Change Log (last 10)</div>
      <div id="change-log-entries">No changes yet.</div>
    </div>

  </div><!-- /dj-body -->
</div><!-- /section -->

<!-- DAILY INTELLIGENCE REPORT -->
<div class="section" id="analyst-section">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
    <div>
      <h2 style="margin:0">Daily Intelligence Report</h2>
      <div style="font-size:11px;color:var(--muted);margin-top:3px">Generated by Claude Haiku · runs at 08:00 UTC</div>
    </div>
    <button class="btn-primary" id="gen-report-btn" onclick="generateReport()" style="font-size:12px;padding:8px 16px">Generate Report Now</button>
  </div>
  <div id="analyst-report-content">
    <div style="color:var(--muted);text-align:center;padding:24px">Loading report...</div>
  </div>
</div>

</div><!-- /main -->

<script>
const ASSETS = ${JSON.stringify(ALL_ASSETS)};
let equityChart = null;
let chartData = { labels:[], datasets:[] };

// ─── CHART INIT ──────────────────────────────────────────────────────────────
function initChart() {
  const ctx = document.getElementById('equity-chart').getContext('2d');
  equityChart = new Chart(ctx, {
    type:'line',
    data:{ labels:[], datasets:[
      { label:'Total',        data:[], borderColor:'#1a202c', backgroundColor:'rgba(26,32,44,.05)', fill:true,  tension:.3, borderWidth:2.5, pointRadius:0 },
      { label:'Aggressive',   data:[], borderColor:'#e53e3e', fill:false, tension:.3, borderWidth:1.5, pointRadius:0 },
      { label:'Balanced',     data:[], borderColor:'#3182ce', fill:false, tension:.3, borderWidth:1.5, pointRadius:0 },
      { label:'Conservative', data:[], borderColor:'#00b341', fill:false, tension:.3, borderWidth:1.5, pointRadius:0 },
    ]},
    options:{
      responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{ position:'bottom', labels:{ boxWidth:10, font:{size:11} } } },
      scales:{
        x:{ display:true, ticks:{ maxTicksLimit:6, font:{size:10} }, grid:{display:false} },
        y:{ display:true, ticks:{ font:{size:10}, callback:v=>'£'+v.toFixed(0) }, grid:{ color:'#f0f2f5' } },
      },
      interaction:{ mode:'index', intersect:false },
    },
  });

  ['ptj','stat','mf'].forEach((k,i) => {
    document.getElementById('toggle-'+k).addEventListener('change', e => {
      equityChart.data.datasets[i+1].hidden = !e.target.checked;
      equityChart.update();
    });
  });
}

// ─── DATA REFRESH ────────────────────────────────────────────────────────────
async function refresh() {
  try {
    const [dataResp, sentResp, btResp] = await Promise.all([
      fetch('/api/data').then(r=>r.json()),
      fetch('/api/sentiment').then(r=>r.json()),
      fetch('/api/backtest').then(r=>r.json()),
    ]);

    const { state, trades, weights } = dataResp;
    if (!state) return;

    updateHeader(state);
    updateStatCards(state, trades);
    updateEquityCurve(state);
    updateHeatmap(state, trades);
    updateScorecard(trades, weights);
    updatePositions(state);
    updateTrades(trades);
    updateMacro(state, sentResp, btResp);
    updateRiskGauges(state, trades);
    updateChangeLog();

  } catch(e) { console.error('Refresh error:', e); }
}

function updateHeader(state) {
  const r = state.regime || 'RISK_ON';
  const badge = document.getElementById('regime-badge');
  badge.className = 'regime-badge regime-' + r;
  badge.innerHTML = r === 'RISK_ON' ? '🟢 RISK-ON' : r === 'RISK_OFF' ? '🔴 RISK-OFF' : '🟡 STAGFLATION';

  const lu = state.lastUpdate ? new Date(state.lastUpdate).toLocaleTimeString() : 'Never';
  document.getElementById('last-update').textContent = 'Updated ' + lu;

  const ks = state.killSwitch;
  const el = document.getElementById('kill-status');
  if (ks?.triggered) { el.className='kill-status kill-triggered'; el.textContent='🔴 KILL SWITCH'; }
  else { el.className='kill-status kill-armed'; el.textContent='⚡ ARMED'; }
}

function updateStatCards(state, trades) {
  const ports = state.portfolios || {};
  const total = Object.values(ports).reduce((s,p)=>s+(p.nav||0),0);
  const totalPnl = total - 1000;
  const totalPct = totalPnl / 1000 * 100;

  document.getElementById('s-nav').textContent = '£' + total.toFixed(2);
  document.getElementById('s-nav-sub').textContent = (totalPnl>=0?'+':'') + totalPnl.toFixed(2) + ' from £1,000';
  document.getElementById('s-nav-sub').className = 'stat-sub ' + (totalPnl>=0?'up':'dn');

  // Today P&L — approximate from equity curve last point vs 24h ago
  const ec = state.equityCurve || [];
  const now24ago = ec.length > 24 ? ec[ec.length-25] : null;
  const todayPnl = now24ago ? total - now24ago.total : 0;
  const todayPct = now24ago && now24ago.total > 0 ? todayPnl/now24ago.total*100 : 0;
  const todaySign = todayPnl >= 0 ? '+' : '−';
  document.getElementById('s-today').innerHTML = todaySign + '£' + Math.abs(todayPnl).toFixed(2) + ' <span class="pnl-label ' + (todayPnl>=0?'pnl-label-profit':'pnl-label-loss') + '">' + (todayPnl>=0?'▲ PROFIT':'▼ LOSS') + '</span>';
  document.getElementById('s-today').className = 'stat-value ' + (todayPnl>=0?'up':'dn');
  document.getElementById('s-today-pct').textContent = (todayPct>=0?'+':'−') + Math.abs(todayPct).toFixed(2) + '%';

  // Realised P&L — sum of all closed trades
  const realisedPnl = (trades||[]).reduce((s,t)=>s+(t.pnl||0),0);
  const realisedPct = realisedPnl / 1000 * 100;
  const rSign = realisedPnl >= 0 ? '+' : '−';
  document.getElementById('s-realised-pnl').innerHTML = rSign + '£' + Math.abs(realisedPnl).toFixed(2) + ' <span class="pnl-label ' + (realisedPnl>=0?'pnl-label-profit':'pnl-label-loss') + '">' + (realisedPnl>=0?'▲ PROFIT':'▼ LOSS') + '</span>';
  document.getElementById('s-realised-pnl').className = 'stat-value ' + (realisedPnl>=0?'up':'dn');
  document.getElementById('s-realised-sub').textContent = (realisedPct>=0?'+':'−') + Math.abs(realisedPct).toFixed(2) + '% of capital · ' + (trades||[]).length + ' trades';
  document.getElementById('realised-pnl-card').className = 'stat-card ' + (realisedPnl>=0?'green':'red');

  const openCount = Object.values(ports).reduce((s,p)=>(s+(p.positions||[]).length),0);
  document.getElementById('s-open').textContent = openCount;

  // Unrealised P&L — open positions marked to market
  const livePrices = state.livePrices || {};
  let unrealisedPnl = 0;
  for (const port of Object.values(ports)) {
    for (const pos of (port.positions||[])) {
      const cur = livePrices[pos.asset]?.price || pos.entryPrice;
      unrealisedPnl += pos.side==='LONG' ? (cur-pos.entryPrice)*pos.qty : (pos.entryPrice-cur)*pos.qty;
    }
  }
  const uSign = unrealisedPnl >= 0 ? '+' : '−';
  document.getElementById('s-unrealised-pnl').innerHTML = uSign + '£' + Math.abs(unrealisedPnl).toFixed(2) + ' <span class="pnl-label ' + (unrealisedPnl>=0?'pnl-label-profit':'pnl-label-loss') + '">' + (unrealisedPnl>=0?'▲ PROFIT':'▼ LOSS') + '</span>';
  document.getElementById('s-unrealised-pnl').className = 'stat-value ' + (unrealisedPnl>=0?'up':'dn');
  document.getElementById('s-unrealised-sub').textContent = openCount + (openCount===1?' position':' positions') + ' open';
  document.getElementById('unrealised-pnl-card').className = 'stat-card ' + (unrealisedPnl>=0?'green':'red');

  // Portfolio heat (simplified)
  const heat = Object.values(ports).reduce((s,p)=>{
    if (!p.nav || p.nav===0) return s;
    const h = (p.positions||[]).reduce((hs,pos)=>{
      const slPct = pos.entryPrice > 0 ? Math.abs(pos.entryPrice - pos.stopLoss)/pos.entryPrice : 0;
      return hs + pos.qty * pos.entryPrice * slPct;
    },0) / p.nav;
    return s + h;
  },0) / 3;
  document.getElementById('s-heat').textContent = (heat*100).toFixed(1)+'%';
  document.getElementById('s-heat').className = 'stat-value ' + (heat>0.5?'dn':heat>0.3?'':' up');

  // Best strategy today
  const stratPnls = {};
  for (const t of (trades||[])) {
    if (!stratPnls[t.strategy]) stratPnls[t.strategy]=0;
    stratPnls[t.strategy]+=t.pnl;
  }
  const bestStrat = Object.entries(stratPnls).sort((a,b)=>b[1]-a[1])[0];
  document.getElementById('s-best').textContent = bestStrat ? stratLabel(bestStrat[0]) : '—';
  document.getElementById('s-best-sub').textContent = bestStrat ? '£'+bestStrat[1].toFixed(2) : 'no trades';
}

function updateEquityCurve(state) {
  const ec = state.equityCurve || [];
  if (!ec.length) return;
  const labels = ec.map(p => new Date(p.timestamp).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}));
  equityChart.data.labels = labels;
  equityChart.data.datasets[0].data = ec.map(p=>p.total||1000);
  equityChart.data.datasets[1].data = ec.map(p=>p.aggressive||333);
  equityChart.data.datasets[2].data = ec.map(p=>p.balanced||334);
  equityChart.data.datasets[3].data = ec.map(p=>p.conservative||333);
  equityChart.update('none');
}

function updateHeatmap(state, trades) {
  const hm = document.getElementById('heatmap');
  const prices = state.livePrices || {};
  const ports  = state.portfolios || {};

  const allPositions = Object.values(ports).flatMap(p=>p.positions||[]);
  const posMap = {};
  for (const pos of allPositions) {
    if (!posMap[pos.asset]) posMap[pos.asset] = { notional:0, side:'LONG', count:0 };
    posMap[pos.asset].notional += pos.notional || 0;
    posMap[pos.asset].count++;
    posMap[pos.asset].side = pos.side;
  }

  // Score for colour (use from multi-factor if available, else price change)
  hm.innerHTML = ASSETS.map(asset => {
    const p = prices[asset] || {};
    const chg = p.change24h || 0;
    const price = p.price || 0;
    const pos = posMap[asset] || {};

    // Hue: -10% = deep red, 0 = white, +10% = deep green
    const intensity = Math.min(Math.abs(chg)/10, 1);
    const r = chg < 0 ? Math.round(255) : Math.round(255*(1-intensity));
    const g = chg > 0 ? Math.round(255) : Math.round(255*(1-intensity));
    const b = Math.round(255*(1-intensity));
    const bg = \`rgb(\${r},\${g},\${b})\`;
    const textColor = intensity > 0.5 ? '#fff' : '#1a202c';

    const sizeStyle = pos.notional > 0 ? \`box-shadow:0 0 0 2px \${pos.side==='LONG'?'#00b341':'#e53e3e'}\` : '';
    const priceStr = price > 1000 ? '£'+price.toFixed(0) : price > 1 ? '£'+price.toFixed(2) : '£'+price.toFixed(4);

    return \`<div class="heat-cell" style="background:\${bg};color:\${textColor};\${sizeStyle}" title="\${asset}: \${priceStr} \${chg>=0?'+':''}\${chg.toFixed(2)}% \${pos.count?' | '+pos.count+' pos':''} ">
      <div class="heat-name">\${asset}</div>
      <div class="heat-price">\${priceStr}</div>
      <div class="heat-chg">\${chg>=0?'+':''}\${chg.toFixed(2)}%</div>
      \${pos.count ? \`<div class="heat-score">\${pos.side} ×\${pos.count}</div>\` : ''}
    </div>\`;
  }).join('');
}

function updateScorecard(trades, weights) {
  const strats = ['ptj','statArb','multiFactor','allWeather'];
  const profiles = ['aggressive','balanced','conservative'];
  const tbody = document.getElementById('scorecard-body');

  tbody.innerHTML = strats.map(strat => {
    const cols = profiles.map(prof => {
      const t = (trades||[]).filter(x=>x.strategy===strat&&x.profile===prof);
      const wins = t.filter(x=>x.win); const wr = t.length ? wins.length/t.length : 0;
      const pnl = t.reduce((s,x)=>s+x.pnl,0);
      const returns = t.map(x=>x.pnlPct); const mn = returns.length ? returns.reduce((a,b)=>a+b)/returns.length : 0;
      const sd = returns.length>1 ? Math.sqrt(returns.reduce((a,b)=>a+(b-mn)**2)/returns.length) : 0;
      const sharpe = sd>0 ? mn/sd*Math.sqrt(252) : 0;
      const wt = weights[\`\${strat}_\${prof}\`] || 0.25;
      let peak=0,maxDD=0,run=0; for(const x of t){run+=x.pnl;if(run>peak)peak=run;maxDD=Math.max(maxDD,peak-run);}
      const sharpeClass = sharpe>1?'sharpe-green':sharpe>0?'sharpe-yellow':'sharpe-red';
      return \`<td style="border-left:2px solid var(--border)">\${(wr*100).toFixed(0)}%</td>
        <td class="\${sharpeClass}">\${sharpe.toFixed(2)}</td>
        <td>\${maxDD>0?'-£'+maxDD.toFixed(2):'—'}</td>
        <td>\${t.length}</td>
        <td class="\${pnl>=0?'up':'dn'}">\${pnl>=0?'+':'−'}£\${Math.abs(pnl).toFixed(2)} <span class="pnl-label \${pnl>=0?'pnl-label-profit':'pnl-label-loss'}">\${pnl>=0?'▲':'▼'}</span></td>
        <td>\${(wt*100).toFixed(0)}%</td>\`;
    }).join('');
    return \`<tr><td><strong>\${stratLabel(strat)}</strong></td>\${cols}</tr>\`;
  }).join('');
}

function updatePositions(state) {
  const tbody = document.getElementById('positions-body');
  const allPositions = [];
  for (const [prof, port] of Object.entries(state.portfolios||{})) {
    for (const pos of (port.positions||[])) allPositions.push({...pos, profileLabel:prof});
  }
  if (!allPositions.length) { tbody.innerHTML='<tr><td colspan="10" style="text-align:center;color:var(--muted);padding:20px">No open positions</td></tr>'; return; }
  const prices = state.livePrices||{};
  tbody.innerHTML = allPositions.map(pos => {
    const cur = prices[pos.asset]?.price || pos.entryPrice;
    const upnl = pos.side==='LONG' ? (cur-pos.entryPrice)*pos.qty : (pos.entryPrice-cur)*pos.qty;
    const openedMs = new Date(pos.openedAt).getTime();
    const dur = Math.floor((Date.now()-openedMs)/60000);
    const durStr = dur > 60 ? Math.floor(dur/60)+'h '+dur%60+'m' : dur+'m';
    return \`<tr>
      <td><strong>\${pos.asset}</strong></td>
      <td>\${stratLabel(pos.strategy)}</td>
      <td>\${pos.profile||pos.profileLabel}</td>
      <td><span class="badge badge-\${pos.side.toLowerCase()}">\${pos.side}</span></td>
      <td>£\${fmtPrice(pos.entryPrice)}</td>
      <td>£\${fmtPrice(cur)}</td>
      <td class="\${upnl>=0?'up':'dn'}">\${upnl>=0?'+':'−'}£\${Math.abs(upnl).toFixed(2)} <span class="pnl-label \${upnl>=0?'pnl-label-profit':'pnl-label-loss'}">\${upnl>=0?'▲ PROFIT':'▼ LOSS'}</span></td>
      <td>£\${fmtPrice(pos.stopLoss)}</td>
      <td>£\${fmtPrice(pos.takeProfit)}</td>
      <td>\${durStr}</td>
    </tr>\`;
  }).join('');
}

function updateTrades(trades) {
  const tbody = document.getElementById('trades-body');
  const last50 = (trades||[]).slice(-50).reverse();
  if (!last50.length) { tbody.innerHTML='<tr><td colspan="10" style="text-align:center;color:var(--muted);padding:20px">No trades yet</td></tr>'; return; }
  tbody.innerHTML = last50.map(t => \`<tr class="\${t.win?'win':'loss'}">
    <td>\${new Date(t.closedAt||t.openedAt).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</td>
    <td><strong>\${t.asset}</strong></td>
    <td>\${stratLabel(t.strategy)}</td>
    <td>\${t.profile}</td>
    <td><span class="badge badge-\${t.side?.toLowerCase()}">\${t.side}</span></td>
    <td>£\${fmtPrice(t.entryPrice)}</td>
    <td>£\${fmtPrice(t.exitPrice)}</td>
    <td class="\${t.pnl>=0?'up':'dn'}">\${t.pnl>=0?'+':'−'}£\${Math.abs(t.pnl||0).toFixed(2)} <span class="pnl-label \${t.pnl>=0?'pnl-label-profit':'pnl-label-loss'}">\${t.pnl>=0?'▲ PROFIT':'▼ LOSS'}</span></td>
    <td><span class="badge \${t.win?'badge-win':'badge-loss-result'}">\${t.win?'WIN':'LOSS'}</span></td>
    <td>\${t.exitReason||'—'}</td>
  </tr>\`).join('');
}

function updateMacro(state, sentData, bt) {
  const el = document.getElementById('regime-detail');
  const r  = state.regime || 'UNKNOWN';
  const emoji = r==='RISK_ON'?'🟢':r==='RISK_OFF'?'🔴':'🟡';
  el.innerHTML = \`<div style="font-size:16px;font-weight:700;margin-bottom:6px">\${emoji} \${r.replace('_',' ')}</div>
    <div style="color:var(--muted)">\${state.regimeReason||''}</div>
    <div style="color:var(--muted);font-size:11px;margin-top:4px">Changed: \${state.regimeChangedAt ? new Date(state.regimeChangedAt).toLocaleString() : 'N/A'}</div>\`;

  // Sentiment
  const sl = document.getElementById('sentiment-list');
  sl.innerHTML = ASSETS.map(asset => {
    const s = sentData[asset];
    const score = s?.score ?? 0;
    const pct = ((score + 1) / 2 * 100);
    const color = score > 0.3 ? '#00b341' : score < -0.3 ? '#e53e3e' : '#d69e2e';
    return \`<div class="sent-row">
      <span class="sent-name">\${asset}</span>
      <div class="sent-bar-wrap"><div class="sent-bar" style="width:\${pct}%;background:\${color}"></div></div>
      <span class="sent-score" style="color:\${color}">\${score.toFixed(2)}</span>
    </div>\`;
  }).join('');

  // Backtest summary
  const btel = document.getElementById('backtest-summary');
  if (bt?.results) {
    const rows = [];
    for (const [prof, strats] of Object.entries(bt.results)) {
      for (const [strat, m] of Object.entries(strats)) {
        rows.push(\`<div style="display:flex;justify-content:space-between;border-bottom:1px solid var(--border);padding:3px 0">
          <span>\${stratLabel(strat)} / \${prof}</span>
          <span>\${m.winRate?(m.winRate*100).toFixed(0)+'% WR':'—'} · Sharpe \${m.sharpe?.toFixed(2)||'—'} · \${m.trades} trades</span>
        </div>\`);
      }
    }
    btel.innerHTML = rows.join('') || 'No results yet.';
    btel.innerHTML += \`<div style="color:var(--muted);font-size:11px;margin-top:4px">Run: \${bt.runAt ? new Date(bt.runAt).toLocaleString() : 'N/A'} · Assets: \${bt.assetsLoaded||0}</div>\`;
  } else {
    btel.textContent = bt?.error || 'No backtest results yet. Will run on startup.';
  }
}

function updateRiskGauges(state, trades) {
  const ports = state.portfolios||{};
  const total = Object.values(ports).reduce((s,p)=>s+(p.nav||0),0);
  const ath   = state.allTimeHigh || 1000;
  const dd    = ath > 0 ? Math.max(0,(ath-total)/ath*100) : 0;

  const heat = Object.values(ports).reduce((s,p)=>{
    if (!p.nav||p.nav===0) return s;
    const h = (p.positions||[]).reduce((hs,pos)=>{
      const slPct = pos.entryPrice>0 ? Math.abs(pos.entryPrice-pos.stopLoss)/pos.entryPrice : 0;
      return hs + pos.qty*pos.entryPrice*slPct;
    },0) / p.nav;
    return s + h;
  },0) / 3;

  setGauge('g-heat',   (heat*100).toFixed(1)+'%',   'g-heat-bar',  heat*100, 60);
  setGauge('g-dd',     dd.toFixed(1)+'%',             'g-dd-bar',    dd,       20);
  setGauge('g-var',    '£'+(total*0.02).toFixed(0),   'g-var-bar',   (total*0.02/total*100), 10);

  const openCount = Object.values(ports).reduce((s,p)=>s+(p.positions||[]).length,0);
  const corrRisk  = openCount >= 5;
  document.getElementById('g-corr').textContent = corrRisk ? 'HIGH' : 'LOW';
  document.getElementById('g-corr').style.color = corrRisk ? 'var(--red)' : 'var(--green)';
  document.getElementById('g-corr-bar').style.width = corrRisk ? '80%' : '20%';
  document.getElementById('g-corr-bar').style.background = corrRisk ? 'var(--red)' : 'var(--green)';
}

function setGauge(valId, val, barId, pct, maxPct) {
  document.getElementById(valId).textContent = val;
  const ratio = Math.min(pct / maxPct, 1);
  document.getElementById(barId).style.width = (ratio*100)+'%';
  const color = ratio > 0.8 ? 'var(--red)' : ratio > 0.5 ? 'var(--yellow)' : 'var(--green)';
  document.getElementById(barId).style.background = color;
}

// ─── DJ CONSOLE ──────────────────────────────────────────────────────────────
function toggleDJ(header) {
  header.classList.toggle('open');
  document.getElementById('dj-body').classList.toggle('open');
}

function updateLabel(id, val) {
  document.getElementById(id).textContent = val;
  updateSliderGradient(document.querySelector('[oninput*="'+id+'"]'));
}

function updateSliderGradient(input) {
  if (!input) return;
  const min=parseFloat(input.min), max=parseFloat(input.max), val=parseFloat(input.value);
  const pct = (val-min)/(max-min)*100;
  input.style.background = \`linear-gradient(to right, var(--blue) \${pct}%, var(--border) \${pct}%)\`;
}

document.querySelectorAll('input[type=range]').forEach(updateSliderGradient);

async function loadConfigIntoConsole() {
  try {
    const cfg = await fetch('/api/config').then(r=>r.json());
    const setSlider = (id, val) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.value = val;
      updateSliderGradient(el);
    };
    setSlider('rsiPeriod', cfg.rsiPeriod||14);    document.getElementById('lbl-rsiPeriod').textContent = cfg.rsiPeriod||14;
    setSlider('rsiOversold', cfg.rsiOversold||35); document.getElementById('lbl-rsiOversold').textContent = cfg.rsiOversold||35;
    setSlider('rsiOverbought', cfg.rsiOverbought||65); document.getElementById('lbl-rsiOverbought').textContent = cfg.rsiOverbought||65;
    setSlider('emaFast', cfg.emaFast||9);          document.getElementById('lbl-emaFast').textContent = cfg.emaFast||9;
    setSlider('emaSlow', cfg.emaSlow||21);         document.getElementById('lbl-emaSlow').textContent = cfg.emaSlow||21;
    setSlider('bbPeriod', cfg.bbPeriod||20);       document.getElementById('lbl-bbPeriod').textContent = cfg.bbPeriod||20;
    setSlider('bbStdDev', cfg.bbStdDev||2.0);      document.getElementById('lbl-bbStdDev').textContent = parseFloat(cfg.bbStdDev||2.0).toFixed(1);
    setSlider('macdFast', cfg.macdFast||12);       document.getElementById('lbl-macdFast').textContent = cfg.macdFast||12;
    setSlider('macdSlow', cfg.macdSlow||26);       document.getElementById('lbl-macdSlow').textContent = cfg.macdSlow||26;
    setSlider('riskReward', cfg.riskReward||3);    document.getElementById('lbl-riskReward').textContent = '1:'+(cfg.riskReward||3);
    setSlider('maxTradeRisk', cfg.maxTradeRisk||1.0); document.getElementById('lbl-maxTradeRisk').textContent = parseFloat(cfg.maxTradeRisk||1.0).toFixed(1)+'%';
    setSlider('kellyFraction', cfg.kellyFraction||50); document.getElementById('lbl-kellyFraction').textContent = (cfg.kellyFraction||50)+'%';
    setSlider('killSwitchThreshold', cfg.killSwitchThreshold||-20); document.getElementById('lbl-killSwitchThreshold').textContent = (cfg.killSwitchThreshold||-20)+'%';
    setSlider('maxPortfolioHeat', cfg.maxPortfolioHeat||60); document.getElementById('lbl-maxPortfolioHeat').textContent = (cfg.maxPortfolioHeat||60)+'%';
    setSlider('cashBuffer', cfg.cashBuffer||20);   document.getElementById('lbl-cashBuffer').textContent = (cfg.cashBuffer||20)+'%';
    setSlider('cryptoMax', cfg.cryptoMax||40);     document.getElementById('lbl-cryptoMax').textContent = (cfg.cryptoMax||40)+'%';
    setSlider('equitiesMax', cfg.equitiesMax||50); document.getElementById('lbl-equitiesMax').textContent = (cfg.equitiesMax||50)+'%';
    setSlider('commoditiesMax', cfg.commoditiesMax||30); document.getElementById('lbl-commoditiesMax').textContent = (cfg.commoditiesMax||30)+'%';

    const sw = cfg.strategyWeights||{};
    ['ptj','statArb','multiFactor','allWeather'].forEach(s => {
      setSlider('sw-'+s, sw[s]||1);
      document.getElementById('lbl-sw-'+s).textContent = parseFloat(sw[s]||1).toFixed(1);
    });

    ASSETS.forEach(a => {
      const el = document.getElementById('asset-'+a.replace('=','_'));
      if (el) el.checked = cfg.enabledAssets ? cfg.enabledAssets[a] !== false : true;
    });
  } catch(e) { console.error('Config load error:', e); }
}

async function applyChanges() {
  const sw = {};
  ['ptj','statArb','multiFactor','allWeather'].forEach(s => {
    sw[s] = parseFloat(document.getElementById('sw-'+s)?.value||1);
  });
  const enabledAssets = {};
  ASSETS.forEach(a => {
    const el = document.getElementById('asset-'+a.replace('=','_'));
    enabledAssets[a] = el ? el.checked : true;
  });

  const cfg = {
    strategyWeights:    sw,
    rsiPeriod:         parseInt(document.getElementById('rsiPeriod').value),
    rsiOversold:       parseInt(document.getElementById('rsiOversold').value),
    rsiOverbought:     parseInt(document.getElementById('rsiOverbought').value),
    emaFast:           parseInt(document.getElementById('emaFast').value),
    emaSlow:           parseInt(document.getElementById('emaSlow').value),
    bbPeriod:          parseInt(document.getElementById('bbPeriod').value),
    bbStdDev:          parseFloat(document.getElementById('bbStdDev').value),
    macdFast:          parseInt(document.getElementById('macdFast').value),
    macdSlow:          parseInt(document.getElementById('macdSlow').value),
    riskReward:        parseInt(document.getElementById('riskReward').value),
    maxTradeRisk:      parseFloat(document.getElementById('maxTradeRisk').value),
    kellyFraction:     parseInt(document.getElementById('kellyFraction').value),
    killSwitchThreshold: parseInt(document.getElementById('killSwitchThreshold').value),
    maxPortfolioHeat:  parseInt(document.getElementById('maxPortfolioHeat').value),
    cashBuffer:        parseInt(document.getElementById('cashBuffer').value),
    cryptoMax:         parseInt(document.getElementById('cryptoMax').value),
    equitiesMax:       parseInt(document.getElementById('equitiesMax').value),
    commoditiesMax:    parseInt(document.getElementById('commoditiesMax').value),
    enabledAssets,
  };

  const resp = await fetch('/api/config', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(cfg) });
  if (resp.ok) {
    showToast('✅ Config saved — bot picks up on next tick');
    updateChangeLog();
  }
}

async function resetDefaults() {
  await fetch('/api/config', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(${JSON.stringify(DEFAULT_CONFIG)}) });
  await loadConfigIntoConsole();
  showToast('↺ Reset to defaults');
}

async function applyPreset(preset) {
  await fetch('/api/preset', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ preset }) });
  await loadConfigIntoConsole();
  showToast('Preset applied: ' + preset);
}

async function toggleBacktestMode() {
  const cfg = await fetch('/api/config').then(r=>r.json());
  await fetch('/api/config', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ ...cfg, backtestMode: !cfg.backtestMode })
  });
  showToast(cfg.backtestMode ? 'Live trading resumed' : '🧪 Backtest mode — live trading paused');
}

async function resetKillSwitch() {
  if (!confirm('Reset kill switch and resume trading?')) return;
  await fetch('/api/killswitch/reset', { method:'POST' });
  showToast('⚡ Kill switch reset — trading resumed');
}

async function updateChangeLog() {
  try {
    const cfg = await fetch('/api/config').then(r=>r.json());
    const resp = await fetch('/api/data').then(r=>r.json());
    const log = await (await fetch('/api/config')).json();
  } catch {}
  // Get log from localStorage as fallback
  const el = document.getElementById('change-log-entries');
  try {
    const r = await fetch('/api/data').then(r=>r.json());
    // Try to get configLog
    const logResp = await fetch('/api/config').then(r=>r.json());
  } catch {}
}

function showToast(msg) {
  const t = document.createElement('div');
  t.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#1a202c;color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;font-weight:500;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,.2);animation:fadeIn .2s';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ─── UTILS ──────────────────────────────────────────────────────────────────
function switchTab(id, el) {
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t=>t.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('tab-'+id).classList.add('active');
}

function stratLabel(s) {
  return { ptj:'PTJ Trend', statArb:'Stat-Arb', multiFactor:'Multi-Factor', allWeather:'All-Weather' }[s] || s;
}

function fmtPrice(p) {
  if (!p) return '—';
  return p > 1000 ? p.toFixed(0) : p > 1 ? p.toFixed(2) : p.toFixed(4);
}

// ─── ANALYST REPORT ──────────────────────────────────────────────────────────
async function loadAnalystReport() {
  const el = document.getElementById('analyst-report-content');
  try {
    const report = await fetch('/api/analyst-report').then(r => r.json());
    if (!report) {
      el.innerHTML = '<div style="color:var(--muted);text-align:center;padding:24px">No report yet — click "Generate Report Now" to create one.</div>';
      return;
    }
    const pnlSign  = report.todayPnl >= 0 ? '+' : '−';
    const pnlColor = report.todayPnl >= 0 ? 'var(--green)' : 'var(--red)';
    const pnlLabel = report.todayPnl >= 0 ? '▲ PROFIT' : '▼ LOSS';
    const genTime  = new Date(report.generatedAt).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});

    const bodyHtml = (report.text || '')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>[\s\S]*?<\/li>)+/g, m => \`<ul>\${m}</ul>\`)
      .replace(/\n{2,}/g, '</p><p>')
      .replace(/\n/g, '<br>');

    const cfgBlock = report.configChangesApplied ? \`
      <div class="config-applied">
        <div class="config-applied-title">Config Changes Applied Automatically</div>
        <pre>\${JSON.stringify(report.configChangesApplied, null, 2)}</pre>
      </div>\` : '';

    el.innerHTML = \`
      <div class="report-meta">
        <span>📅 <strong>\${report.date}</strong></span>
        <span>⏱ Generated \${genTime}</span>
        <span>💼 NAV: <strong>£\${(report.nav||0).toFixed(2)}</strong></span>
        <span style="color:\${pnlColor}">Today P&L: <strong>\${pnlSign}£\${Math.abs(report.todayPnl||0).toFixed(2)} \${pnlLabel}</strong></span>
      </div>
      <div class="report-body"><p>\${bodyHtml}</p></div>
      \${cfgBlock}\`;
  } catch(e) {
    el.innerHTML = '<div style="color:var(--red);padding:12px">Failed to load report: ' + e.message + '</div>';
  }
}

async function generateReport() {
  const btn = document.getElementById('gen-report-btn');
  btn.disabled = true;
  btn.textContent = 'Generating...';
  try {
    const r = await fetch('/api/generate-report', { method: 'POST' });
    if (!r.ok) { const e = await r.json(); throw new Error(e.error || 'Unknown error'); }
    showToast('Report generation started — refresh in 10 seconds');
    setTimeout(() => loadAnalystReport(), 12000);
  } catch(e) {
    showToast('Error: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate Report Now';
  }
}

// ─── INIT ────────────────────────────────────────────────────────────────────
initChart();
loadConfigIntoConsole();
refresh();
loadAnalystReport();
setInterval(refresh, 10000); // refresh every 10 seconds
setInterval(loadAnalystReport, 120000); // refresh report every 2 minutes
</script>
</body>
</html>`;

app.listen(PORT, () => {
  console.log(`[APEX Server] Dashboard running at http://localhost:${PORT}`);
});
