// storage.js — where data lives. Two interchangeable backends with the same small interface:
//
//   file  (default)  — JSON/JSONL files under DATA_DIR. Good for a computer / VPS / a server with a persistent disk.
//   redis            — Upstash Redis over HTTPS (free tier). Good for free hosts whose disk is wiped on restart.
//                      Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (STORAGE=redis is then implied).
//
// Interface (all async): get(key) set(key, value, ttlSec) del(key) incr(key) push(list, value, {max, ttlSec}) range(list, start, stop)
// Values are plain JSON. Lists are append-only logs (orders, conversation messages).

const fs = require('fs');
const path = require('path');
const tel = require('./telemetry');

const safe = (key) => String(key).replace(/[^\w.-]+/g, '_');

class FileBackend {
  constructor(dir) {
    this.name = 'file';
    this.dir = dir;
    this.kvDir = path.join(dir, 'kv');
    fs.mkdirSync(this.kvDir, { recursive: true });
    this.shared = false; // only this process writes here, so the in-memory cache is authoritative
  }
  kvFile(key) { return path.join(this.kvDir, `${safe(key)}.json`); }
  listFile(key) {
    // lists with ':' (conv:<id>) go to a sub-folder; top-level lists (orders) keep their old file name
    const [ns, ...rest] = String(key).split(':');
    if (!rest.length) return path.join(this.dir, `${safe(ns)}.jsonl`);
    const d = path.join(this.dir, safe(ns));
    fs.mkdirSync(d, { recursive: true });
    return path.join(d, `${safe(rest.join(':'))}.jsonl`);
  }
  getSync(key) {
    try {
      const { value, expiresAt } = JSON.parse(fs.readFileSync(this.kvFile(key), 'utf8'));
      if (expiresAt && Date.now() > expiresAt) return null;
      return value;
    } catch { return null; }
  }
  async get(key) { return this.getSync(key); }
  async set(key, value, ttlSec) {
    const tmp = this.kvFile(key) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ value, ...(ttlSec ? { expiresAt: Date.now() + ttlSec * 1000 } : {}) }));
    fs.renameSync(tmp, this.kvFile(key)); // atomic: a crash never leaves half a file
  }
  async del(key) { fs.rmSync(this.kvFile(key), { force: true }); }
  async incr(key) { const n = (Number(this.getSync(key)) || 0) + 1; await this.set(key, n); return n; }
  async push(key, value, { max } = {}) {
    fs.appendFileSync(this.listFile(key), JSON.stringify(value) + '\n');
    if (max) {
      const all = this.rangeSync(key, 0, -1);
      if (all.length > max * 1.2) fs.writeFileSync(this.listFile(key), all.slice(-max).map((x) => JSON.stringify(x)).join('\n') + '\n');
    }
  }
  rangeSync(key, start = 0, stop = -1) {
    const f = this.listFile(key);
    if (!fs.existsSync(f)) return [];
    const all = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const s = start < 0 ? Math.max(0, all.length + start) : start;
    const e = stop < 0 ? all.length + stop + 1 : stop + 1;
    return all.slice(s, e);
  }
  async range(key, start, stop) { return this.rangeSync(key, start, stop); }
}

// Upstash Redis REST API — plain fetch, no npm package. https://upstash.com/docs/redis/features/restapi
class RedisBackend {
  constructor({ url, token, fetchImpl = globalThis.fetch }) {
    if (!url || !token) throw new Error('STORAGE=redis needs UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN');
    this.name = 'redis';
    this.url = url.replace(/\/$/, '');
    this.token = token;
    this.fetch = fetchImpl;
    this.shared = true; // several server instances may write — always re-read at the start of a message
  }
  async pipeline(commands) {
    const t0 = Date.now();
    let res;
    try {
      res = await this.fetch(`${this.url}/pipeline`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(commands),
      });
    } catch (e) {
      tel.log('storage.error', { backend: 'redis', message: e.message, cmds: commands.map((c) => c[0]) }, 'error');
      throw e;
    }
    const ms = Date.now() - t0;
    tel.timing('storage.redis', ms);
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      tel.log('storage.error', { backend: 'redis', status: res.status, body, cmds: commands.map((c) => c[0]) }, 'error');
      throw new Error(`Redis ${res.status}: ${body}`);
    }
    const out = await res.json();
    const err = out.find((r) => r.error);
    if (err) {
      tel.log('storage.error', { backend: 'redis', message: err.error, cmds: commands.map((c) => c[0]) }, 'error');
      throw new Error(`Redis: ${err.error}`);
    }
    tel.log('storage.call', { backend: 'redis', cmds: commands.map((c) => `${c[0]} ${c[1]}`), ms }, 'debug');
    return out.map((r) => r.result);
  }
  async get(key) { const [v] = await this.pipeline([['GET', key]]); return v == null ? null : JSON.parse(v); }
  async set(key, value, ttlSec) {
    await this.pipeline([ttlSec ? ['SET', key, JSON.stringify(value), 'EX', String(ttlSec)] : ['SET', key, JSON.stringify(value)]]);
  }
  async del(key) { await this.pipeline([['DEL', key]]); }
  async incr(key) { const [n] = await this.pipeline([['INCR', key]]); return Number(n); }
  async push(key, value, { max, ttlSec } = {}) {
    const cmds = [['RPUSH', key, JSON.stringify(value)]];
    if (max) cmds.push(['LTRIM', key, String(-max), '-1']);
    if (ttlSec) cmds.push(['EXPIRE', key, String(ttlSec)]);
    await this.pipeline(cmds);
  }
  async range(key, start = 0, stop = -1) {
    const [arr] = await this.pipeline([['LRANGE', key, String(start), String(stop)]]);
    return (arr || []).map((x) => JSON.parse(x));
  }
}

function createBackend({ dir, env = process.env, fetchImpl } = {}) {
  const kind = (env.STORAGE || (env.UPSTASH_REDIS_REST_URL ? 'redis' : 'file')).toLowerCase();
  if (kind === 'redis') return new RedisBackend({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN, fetchImpl });
  return new FileBackend(dir);
}

module.exports = { FileBackend, RedisBackend, createBackend };
