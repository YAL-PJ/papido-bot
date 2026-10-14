// env.js — tiny .env loader (no dependencies). Handles Windows line endings and "# comments".
const fs = require('fs');
const path = require('path');

const ENV_FILE = path.join(__dirname, '..', '.env');

function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return { loaded: false, file: ENV_FILE };
  for (const rawLine of fs.readFileSync(ENV_FILE, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const value = m[2].replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
    if (value && !process.env[m[1]]) process.env[m[1]] = value;
  }
  return { loaded: true, file: ENV_FILE };
}

module.exports = { loadEnv, ENV_FILE };
