// log-shipper.js — copies every log event to Redis (one list per day), so logs survive restarts of a free
// server whose disk is wiped, and can be read remotely (/api/logs) by anyone holding ADMIN_PASSWORD or LOGS_TOKEN.
// Batched: one RPUSH with many events every couple of seconds (cheap on Upstash's free quota).

const tel = require('./telemetry');

const MAX_PER_DAY = 60000;
const SKIP = new Set(['storage.call']); // the shipper's own Redis calls — would feed back into itself

function createLogShipper(backend, { intervalMs = 2000, retentionDays = Number(process.env.LOG_RETENTION_DAYS || 14) } = {}) {
  let buffer = [];
  let flushing = null;
  const keyFor = (date) => `logs:${date}`;
  const today = () => new Date().toISOString().slice(0, 10);

  // recent events in memory: /monitor polls every few seconds, and reading Redis each time would burn the free quota.
  // On startup it is filled from Redis, so a restart doesn't hide the day's earlier events.
  const RING = 10000;
  let ring = [];
  let complete = false; // ring holds ALL of today's events (so a miss in memory is a real miss)
  const preload = backend.pipeline([['LRANGE', keyFor(today()), String(-RING), '-1']])
    .then(([arr]) => {
      const old = (arr || []).map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
      ring = old.concat(ring).slice(-RING);
      complete = (arr || []).length < RING;
    })
    .catch(() => {});

  tel.addSink((e) => {
    if (SKIP.has(e.type)) return;
    ring.push(e);
    if (ring.length > RING * 1.1) { ring = ring.slice(-RING); complete = false; }
    buffer.push(e);
    if (buffer.length > 5000) buffer = buffer.slice(-5000); // Redis unreachable for a long time: keep the newest
    if (buffer.length >= 200) flush();
  });

  async function flush() {
    if (flushing) return flushing;
    if (!buffer.length) return;
    const batch = buffer;
    buffer = [];
    const byDay = {};
    for (const e of batch) (byDay[e.ts.slice(0, 10)] ||= []).push(JSON.stringify(e));
    const cmds = [];
    for (const [d, vals] of Object.entries(byDay)) {
      cmds.push(['RPUSH', keyFor(d), ...vals], ['LTRIM', keyFor(d), String(-MAX_PER_DAY), '-1'], ['EXPIRE', keyFor(d), String(retentionDays * 86400)]);
    }
    flushing = backend.pipeline(cmds)
      .catch(() => { buffer = batch.concat(buffer).slice(-5000); }) // retry next round (the failure itself is logged by storage)
      .finally(() => { flushing = null; });
    return flushing;
  }

  const timer = setInterval(flush, intervalMs);
  timer.unref();

  // newest-last, like telemetry.readEvents. Reads backwards in chunks until `limit` matches.
  async function read({ date, limit = 300, filter } = {}) {
    await preload;
    const d = date || today();
    if (d === today()) {
      const out = [];
      for (let i = ring.length - 1; i >= 0 && out.length < limit; i--) {
        const e = ring[i];
        if (e.ts.slice(0, 10) === d && (!filter || filter(e))) out.push(e);
      }
      if (out.length >= limit || complete) return out.reverse();
    }
    await flush();
    const key = keyFor(d);
    const out = [];
    const CHUNK = 2000;
    for (let end = -1, scanned = 0; out.length < limit && scanned < MAX_PER_DAY; end -= CHUNK, scanned += CHUNK) {
      const [arr] = await backend.pipeline([['LRANGE', key, String(end - CHUNK + 1), String(end)]]);
      if (!arr || !arr.length) break;
      for (let i = arr.length - 1; i >= 0 && out.length < limit; i--) {
        try { const e = JSON.parse(arr[i]); if (!filter || filter(e)) out.push(e); } catch { /* skip */ }
      }
      if (arr.length < CHUNK || scanned >= 10000) break; // keep remote reads cheap
    }
    return out.reverse();
  }

  return { flush, read };
}

module.exports = { createLogShipper };
