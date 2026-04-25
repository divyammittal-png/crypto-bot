'use strict';
const fs   = require('fs');
const path = require('path');

const LOCAL_DIR  = __dirname;
const VOLUME_DIR = '/data';

// Detect Railway persistent volume
let DATA_DIR;
try {
  fs.accessSync(VOLUME_DIR, fs.constants.W_OK);
  DATA_DIR = VOLUME_DIR;
} catch {
  DATA_DIR = LOCAL_DIR;
}

// Files that must survive redeployments
const PERSISTENT = [
  'state.json',
  'trades.json',
  'learning.json',
  'strategy-weights.json',
  'analyst-reports.json',
  'reports.json',
  'config.json',
  'config-log.json',
  'backtest-results.json',
  'sentiment.json',
  'av-cache.json',
];

function dataPath(filename) {
  return path.join(DATA_DIR, filename);
}

// On first volume mount: copy any existing local files into the volume.
// Safe to call from multiple processes — checks existence before copying.
function migrate() {
  if (DATA_DIR === LOCAL_DIR) {
    console.log('[STORAGE] No persistent volume detected — using local directory');
    return;
  }
  console.log(`[STORAGE] Persistent volume mounted at ${DATA_DIR}`);
  let migrated = 0;
  for (const file of PERSISTENT) {
    const src  = path.join(LOCAL_DIR, file);
    const dest = path.join(DATA_DIR, file);
    if (!fs.existsSync(dest) && fs.existsSync(src)) {
      try {
        fs.copyFileSync(src, dest);
        console.log(`[STORAGE]   Migrated ${file}`);
        migrated++;
      } catch(e) {
        console.error(`[STORAGE]   Migration failed for ${file}: ${e.message}`);
      }
    }
  }
  if (migrated === 0) console.log('[STORAGE] Volume up to date — no migration needed');
  else console.log(`[STORAGE] Migrated ${migrated} file(s) to volume`);
}

module.exports = { DATA_DIR, LOCAL_DIR, dataPath, migrate, PERSISTENT };
