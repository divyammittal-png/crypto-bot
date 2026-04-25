'use strict';
const https = require('https');
const fs    = require('fs');
const path  = require('path');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { /* optional */ }

const F = {
  state:   path.join(__dirname, 'state.json'),
  trades:  path.join(__dirname, 'trades.json'),
  learning:path.join(__dirname, 'learning.json'),
  weights: path.join(__dirname, 'strategy-weights.json'),
  config:  path.join(__dirname, 'config.json'),
  reports: path.join(__dirname, 'analyst-reports.json'),
};

function loadJSON(f) { try { return JSON.parse(fs.readFileSync(f,'utf8')); } catch { return null; } }
function saveJSON(f,d) { try { fs.writeFileSync(f,JSON.stringify(d,null,2)); } catch(e) { console.error('[ANALYST] saveJSON error:', e.message); } }

function todayHasReport() {
  const reports = loadJSON(F.reports) || [];
  if (!reports.length) return false;
  const today = new Date().toISOString().slice(0,10);
  return reports[0].date === today;
}

const SYSTEM_PROMPT = `You are a senior quantitative analyst at a hedge fund reviewing the performance of an autonomous algorithmic trading bot called APEX BOT. The bot trades crypto, equities, and commodities using four strategies: PTJ Trend, Stat-Arb, Multi-Factor, and All-Weather — across three risk profiles: Aggressive, Balanced, and Conservative.

Your job is to produce a concise daily intelligence report. Structure it exactly as follows:

## Performance Summary
2-3 sentences on NAV, total P&L, and today's performance.

## Strategy Analysis
Which strategies are working or struggling. Be specific about patterns in the trade data.

## Risk Assessment
Current risk posture, portfolio heat, open positions, and any concerns.

## Market Regime
How the current regime (RISK_ON / RISK_OFF / STAGFLATION) is affecting the bot's behaviour and whether it is appropriate.

## Key Observations
3-5 bullet points of the most important actionable insights from the data.

## Recommendations
Specific changes you recommend. If you want to adjust config parameters, include a JSON block at the very end:
\`\`\`config-changes
{
  "paramName": value
}
\`\`\`
Only include config-changes if you have specific, justified numerical changes. Omit it if the current config is appropriate.

Write like a senior analyst briefing a portfolio manager — direct, data-driven, no fluff. 300-500 words.`;

async function generateDailyReport() {
  const ai = (Anthropic && process.env.ANTHROPIC_API_KEY)
    ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

  const state    = loadJSON(F.state)    || {};
  const trades   = loadJSON(F.trades)   || [];
  const learning = loadJSON(F.learning) || [];
  const weights  = loadJSON(F.weights)  || {};

  const today = new Date().toISOString().slice(0, 10);
  const nav   = Object.values(state.portfolios || {}).reduce((s, p) => s + (p.nav || 0), 0) || state.nav || 1000;

  const todayTrades  = trades.filter(t => (t.closedAt || t.openedAt || '').slice(0, 10) === today);
  const todayPnl     = todayTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const totalPnl     = trades.reduce((s, t) => s + (t.pnl || 0), 0);
  const openPositions= Object.values(state.portfolios || {}).flatMap(p => p.positions || []);

  const dataContext = JSON.stringify({
    date: today,
    nav: nav.toFixed(2),
    totalPnlGBP: totalPnl.toFixed(2),
    todayPnlGBP: todayPnl.toFixed(2),
    todayTradeCount: todayTrades.length,
    totalTradeCount: trades.length,
    regime: state.regime || 'UNKNOWN',
    portfolioHeat: state.heat,
    killSwitch: state.killSwitch || { triggered: false },
    recentTrades: trades.slice(-30).reverse().map(t => ({
      asset: t.asset, strategy: t.strategy, profile: t.profile,
      side: t.side, pnl: t.pnl, win: t.win, reason: t.exitReason || t.reason,
    })),
    openPositions: openPositions.map(p => ({
      asset: p.asset, side: p.side, profile: p.profile,
      entryPrice: p.entryPrice, qty: p.qty,
    })),
    strategyWeights: weights,
    recentLearningInsights: (learning || []).slice(0, 5),
  }, null, 2);

  let reportText = '[Claude API unavailable — no ANTHROPIC_API_KEY set]';
  let configChanges = null;

  if (ai) {
    try {
      const resp = await ai.messages.create({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{
          role:    'user',
          content: `Here is the bot's performance data. Please generate today's intelligence report:\n\n${dataContext}`,
        }],
      });

      reportText = resp.content[0]?.text || reportText;

      const cfgMatch = reportText.match(/```config-changes\s*([\s\S]*?)```/);
      if (cfgMatch) {
        try { configChanges = JSON.parse(cfgMatch[1].trim()); } catch { /* bad JSON */ }
        reportText = reportText.replace(/```config-changes[\s\S]*?```/, '').trim();
      }
    } catch(e) {
      console.error('[ANALYST] Claude API error:', e.message);
      reportText = `[Report generation failed: ${e.message}]`;
    }
  }

  if (configChanges) {
    try {
      const currentCfg = loadJSON(F.config) || {};
      saveJSON(F.config, { ...currentCfg, ...configChanges });
      console.log('[ANALYST] Applied config changes:', JSON.stringify(configChanges));
    } catch(e) {
      console.error('[ANALYST] Failed to apply config:', e.message);
    }
  }

  const report = {
    date: today,
    generatedAt: new Date().toISOString(),
    nav,
    todayPnl,
    totalPnl,
    text: reportText,
    configChangesApplied: configChanges || null,
  };

  const existing = loadJSON(F.reports) || [];
  existing.unshift(report);
  saveJSON(F.reports, existing.slice(0, 30));

  await sendReportEmail(report);

  console.log(`[ANALYST] Daily report generated for ${today}`);
  return report;
}

async function sendReportEmail(report) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { console.log('[ANALYST] RESEND_API_KEY not set — skipping email'); return; }

  const pnlSign  = report.todayPnl >= 0 ? '+' : '−';
  const pnlColor = report.todayPnl >= 0 ? '#00b341' : '#e53e3e';
  const pnlLabel = report.todayPnl >= 0 ? '▲ PROFIT' : '▼ LOSS';
  const navStr   = '£' + (report.nav || 0).toFixed(2);
  const subject  = `APEX BOT Daily Report — ${report.date} — NAV: ${navStr}`;

  const bodyHtml = (report.text || '')
    .replace(/^## (.+)$/gm, '<h2 style="color:#1a202c;font-size:15px;font-weight:700;margin:20px 0 6px;padding-bottom:4px;border-bottom:1px solid #e2e8f0">$1</h2>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/^- (.+)$/gm, '<li style="margin:2px 0">$1</li>')
    .replace(/(<li[^>]*>[\s\S]*?<\/li>)+/g, m => `<ul style="margin:4px 0 10px 18px;padding:0">${m}</ul>`)
    .replace(/\n{2,}/g, '</p><p style="margin:0 0 10px">')
    .replace(/\n/g, '<br>');

  const configBlock = report.configChangesApplied ? `
  <div style="margin:0 32px 24px;background:#fffff0;border:1px solid #fef08a;border-radius:8px;padding:12px 16px">
    <div style="font-size:11px;font-weight:700;color:#d69e2e;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Config Changes Applied Automatically</div>
    <pre style="font-size:12px;color:#1a202c;margin:0;white-space:pre-wrap;overflow-x:auto">${JSON.stringify(report.configChangesApplied, null, 2)}</pre>
  </div>` : '';

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8f9fa;margin:0;padding:20px">
<div style="max-width:680px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1)">
  <div style="background:#1a202c;padding:24px 32px">
    <div style="font-size:22px;font-weight:800;color:#fff;letter-spacing:-.5px">APEX<span style="color:#3182ce">BOT</span></div>
    <div style="color:#a0aec0;font-size:13px;margin-top:4px">Daily Intelligence Report · ${report.date}</div>
  </div>
  <div style="padding:20px 32px;background:#fff;border-bottom:1px solid #e2e8f0;display:flex;gap:32px;flex-wrap:wrap">
    <div>
      <div style="font-size:11px;color:#718096;text-transform:uppercase;font-weight:600;letter-spacing:.06em;margin-bottom:4px">NAV</div>
      <div style="font-size:26px;font-weight:700;color:#1a202c">${navStr}</div>
    </div>
    <div>
      <div style="font-size:11px;color:#718096;text-transform:uppercase;font-weight:600;letter-spacing:.06em;margin-bottom:4px">Today P&amp;L</div>
      <div style="font-size:26px;font-weight:700;color:${pnlColor}">${pnlSign}£${Math.abs(report.todayPnl || 0).toFixed(2)} <span style="font-size:13px">${pnlLabel}</span></div>
    </div>
  </div>
  <div style="padding:24px 32px;font-size:14px;color:#2d3748;line-height:1.75">
    <p style="margin:0 0 10px">${bodyHtml}</p>
  </div>
  ${configBlock}
  <div style="padding:16px 32px;background:#f8f9fa;border-top:1px solid #e2e8f0;text-align:center">
    <a href="https://apex-bot.onrender.com" style="display:inline-block;background:#3182ce;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px">View Dashboard →</a>
    <div style="margin-top:8px;font-size:11px;color:#a0aec0">Generated ${new Date(report.generatedAt).toUTCString()}</div>
  </div>
</div>
</body></html>`;

  return new Promise(resolve => {
    const payload = JSON.stringify({ from:'apex-bot@resend.dev', to:['divya.m.mittal@gmail.com'], subject, html });
    const opts = {
      hostname: 'api.resend.com',
      path:     '/emails',
      method:   'POST',
      headers:  {
        'Authorization':  `Bearer ${apiKey}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log('[ANALYST] Report email sent');
        } else {
          console.error('[ANALYST] Email failed:', res.statusCode, data);
        }
        resolve();
      });
    });
    req.on('error', e => { console.error('[ANALYST] Email request error:', e.message); resolve(); });
    req.write(payload);
    req.end();
  });
}

module.exports = { generateDailyReport, todayHasReport };
