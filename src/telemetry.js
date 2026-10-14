// telemetry.js — structured logs (JSON lines) + live metrics.
//
// Files (one per day, kept LOG_RETENTION_DAYS):
//   logs/app-YYYY-MM-DD.jsonl     every event: turns, model calls, tools, taps, orders, http, errors
//   logs/errors-YYYY-MM-DD.jsonl  warnings and errors only (quick to scan)
// Every event inside one customer message shares a traceId, so you can follow a message end to end:
//   node scripts/logs.js trace <traceId>
//
// Env: LOG_DIR (default ./logs) · LOG_CONSOLE=info|warn|error|silent (default info)
//      LOG_PII=masked|full (default masked: phone numbers shortened) · LOG_RETENTION_DAYS (default 14)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, '..', 'logs');
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const consoleLevel = () => LEVELS[process.env.LOG_CONSOLE || 'info'] ?? 20;
const piiMasked = () => (process.env.LOG_PII || 'masked') !== 'full';
const ctx = new AsyncLocalStorage();

// ---------- PII ----------
function maskPhone(s) {
  return String(s).replace(/\+?\d[\d\s-]{7,}\d/g, (m) => {
    const d = m.replace(/\D/g, '');
    return `${d.slice(0, 3)}***${d.slice(-3)}`;
  });
}
const pii = (v) => (piiMasked() && v != null ? maskPhone(v) : v);

// ---------- files ----------
let dirReady = false;
function ensureDir() {
  if (dirReady) return;
  fs.mkdirSync(LOG_DIR, { recursive: true });
  dirReady = true;
  cleanup();
}
const day = (d = new Date()) => d.toISOString().slice(0, 10);
const fileFor = (kind, d) => path.join(LOG_DIR, `${kind}-${day(d)}.jsonl`);

function cleanup() {
  const keepDays = Number(process.env.LOG_RETENTION_DAYS || 14);
  const cutoff = Date.now() - keepDays * 86400000;
  for (const f of fs.readdirSync(LOG_DIR)) {
    const m = f.match(/^(app|errors)-(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (m && new Date(m[2]).getTime() < cutoff) fs.rmSync(path.join(LOG_DIR, f), { force: true });
  }
}

function truncate(value, max = 2000) {
  if (value == null) return value;
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (s.length <= max) return value;
  return `${s.slice(0, max)}…[+${s.length - max} chars]`;
}

// ---------- metrics (in memory, since server start) ----------
const metrics = {
  startedAt: new Date().toISOString(),
  counters: {},
  timings: {}, // name -> [ms, ...] (last 500)
  tokens: { prompt: 0, output: 0, thoughts: 0 },
  recentErrors: [],
};
function count(name, by = 1) { metrics.counters[name] = (metrics.counters[name] || 0) + by; }
function timing(name, ms) {
  const arr = (metrics.timings[name] ||= []);
  arr.push(ms);
  if (arr.length > 500) arr.shift();
}
function stats(arr) {
  if (!arr || !arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const pct = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  return { n: s.length, avg: Math.round(s.reduce((x, y) => x + y, 0) / s.length), p50: pct(50), p95: pct(95), max: s[s.length - 1] };
}
function snapshot() {
  return {
    startedAt: metrics.startedAt,
    uptimeSec: Math.round((Date.now() - new Date(metrics.startedAt).getTime()) / 1000),
    counters: metrics.counters,
    tokens: metrics.tokens,
    latencyMs: Object.fromEntries(Object.entries(metrics.timings).map(([k, v]) => [k, stats(v)])),
    recentErrors: metrics.recentErrors.slice(-20).reverse(),
  };
}

// ---------- core ----------
function log(type, data = {}, level = 'info') {
  const c = ctx.getStore() || {};
  const event = {
    ts: new Date().toISOString(),
    level,
    type,
    ...(c.traceId ? { traceId: c.traceId } : {}),
    ...(c.customer ? { customer: c.customer } : {}),
    ...(c.channel ? { channel: c.channel } : {}),
    ...(c.conversation ? { conversationId: c.conversation } : {}),
    ...data,
  };
  const line = JSON.stringify(event) + '\n';
  try {
    ensureDir();
    fs.appendFileSync(fileFor('app'), line);
    if (LEVELS[level] >= LEVELS.warn) fs.appendFileSync(fileFor('errors'), line);
  } catch (e) {
    // never let logging break the bot
    process.stderr.write(`[telemetry] cannot write log: ${e.message}\n`);
  }
  if (LEVELS[level] >= LEVELS.warn) {
    count(`${level}s`);
    metrics.recentErrors.push({ ts: event.ts, type, traceId: event.traceId, message: data.message || data.error || '' });
    if (metrics.recentErrors.length > 100) metrics.recentErrors.shift();
  }
  if (LEVELS[level] >= consoleLevel()) printConsole(event);
  return event;
}

const ICON = { debug: '·', info: '•', warn: '⚠️', error: '❌' };
function printConsole(e) {
  const t = e.ts.slice(11, 19);
  const short = e.traceId ? ` ${e.traceId.slice(0, 6)}` : '';
  const brief = e.message || e.text || e.reply || e.name || e.path || e.model || '';
  const extra = e.ms != null ? ` (${e.ms}ms)` : '';
  const line = `${t}${short} ${ICON[e.level] || ''} ${e.type}${brief ? `: ${String(brief).replace(/\n/g, ' ').slice(0, 120)}` : ''}${extra}`;
  (e.level === 'error' ? console.error : e.level === 'warn' ? console.warn : console.log)(line);
}

// Run fn inside a trace (one customer message). All logs inside share the traceId.
function withTrace({ customer, channel, conversation }, fn) {
  const traceId = crypto.randomBytes(6).toString('hex');
  return ctx.run({ traceId, customer: pii(customer), channel, conversation }, fn);
}
// the conversation is known only after the session is loaded — attach it to the running trace
function setConversation(conversationId) { const c = ctx.getStore(); if (c) c.conversation = conversationId; }
const currentTrace = () => ctx.getStore()?.traceId || null;

// Time an async step and log it.
async function timed(type, data, fn, { timingName } = {}) {
  const t0 = Date.now();
  try {
    const out = await fn();
    const ms = Date.now() - t0;
    timing(timingName || type, ms);
    return { out, ms };
  } catch (e) {
    const ms = Date.now() - t0;
    log(`${type}.error`, { ...data, ms, message: e.message, stack: e.stack?.split('\n').slice(0, 4).join(' | ') }, 'error');
    throw e;
  }
}

// read back today's (or a given day's) events — for /monitor and scripts/logs.js
function readEvents({ date, limit = 2000, filter } = {}) {
  const f = fileFor('app', date ? new Date(date) : new Date());
  if (!fs.existsSync(f)) return [];
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (!filter || filter(e)) out.push(e);
    } catch { /* skip partial line */ }
  }
  return out.reverse();
}

function installProcessHandlers() {
  process.on('uncaughtException', (e) => log('process.uncaught', { message: e.message, stack: e.stack }, 'error'));
  process.on('unhandledRejection', (e) => log('process.unhandled_rejection', { message: e?.message || String(e), stack: e?.stack }, 'error'));
}

module.exports = {
  log, count, timing, timed, withTrace, setConversation, currentTrace, snapshot, readEvents, truncate, pii, metrics,
  installProcessHandlers, LOG_DIR,
};
