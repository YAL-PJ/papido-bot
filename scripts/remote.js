// remote.js — read the logs/conversations of a deployed bot (needs PAPIDO_URL + LOGS_TOKEN, e.g. in .env).
//   node scripts/remote.js chats [n]          recent conversations
//   node scripts/remote.js conv <id>          full transcript of one conversation
//   node scripts/remote.js trace <messageId>  everything that happened behind one message
//   node scripts/remote.js errors             warnings + errors today
//   node scripts/remote.js events [type] [n]  raw events (e.g. events llm 50)
//   node scripts/remote.js metrics            counters, latency, tokens
//   add --date YYYY-MM-DD for another day
require('../src/env').loadEnv();

const base = (process.env.PAPIDO_URL || '').replace(/\/$/, '');
const token = process.env.LOGS_TOKEN;
if (!base || !token) { console.error('set PAPIDO_URL and LOGS_TOKEN'); process.exit(1); }

const args = process.argv.slice(2);
const di = args.indexOf('--date');
const date = di >= 0 ? args.splice(di, 2)[1] : null;
const [cmd = 'chats', a1, a2] = args;

async function get(p, q = {}) {
  const u = new URL(base + p);
  for (const [k, v] of Object.entries({ ...q, ...(date ? { date } : {}) })) if (v != null) u.searchParams.set(k, v);
  const res = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}
const t = (ts) => (ts || '').slice(11, 19);
const brief = (e) => e.message || e.text || e.reply || e.name || e.path || e.model || e.error || '';

(async () => {
  if (cmd === 'chats') {
    for (const c of await get('/api/conversations', { limit: a1 || 20 })) console.log(`${(c.startedAt || '').replace('T', ' ').slice(0, 16)}  ${c.conversationId}  ${c.customerId}`);
  } else if (cmd === 'conv') {
    for (const m of await get(`/api/conversations/${a1}`)) {
      const who = m.from === 'bot' ? '🤖' : '👤';
      const body = m.text || (m.payload ? `👆 ${m.payload}` : '');
      console.log(`${t(m.at)} ${who} ${body.replace(/\n/g, '\n           ')}${m.choices ? `\n           [${m.choices.join(' | ')}]` : ''}${m.tools ? `  {${m.tools.join(', ')}}` : ''}${m.error ? `  ⚠️ ${m.error}` : ''}${m.from === 'bot' ? `  · ${m.path} ${m.ms}ms · ${m.messageId}` : ''}`);
    }
  } else if (cmd === 'trace') {
    for (const e of await get('/api/logs', { trace: a1, limit: 1000 })) {
      const { ts, level, type, traceId, customer, channel, conversationId, ...rest } = e;
      console.log(`${t(ts)} ${level.padEnd(5)} ${type}  ${JSON.stringify(rest).slice(0, 600)}`);
    }
  } else if (cmd === 'errors') {
    for (const e of await get('/api/logs', { problems: 1, limit: a1 || 100 })) console.log(`${t(e.ts)} ${e.level} ${e.type} ${e.traceId || ''}  ${String(brief(e)).slice(0, 300)}`);
  } else if (cmd === 'events') {
    for (const e of await get('/api/logs', { type: a1, limit: a2 || 200 })) console.log(`${t(e.ts)} ${e.level.padEnd(5)} ${e.type} ${e.traceId || ''}  ${String(brief(e)).replace(/\n/g, ' ').slice(0, 200)}${e.ms != null ? ` (${e.ms}ms)` : ''}`);
  } else if (cmd === 'metrics') {
    console.log(JSON.stringify(await get('/api/metrics'), null, 2));
  } else {
    console.error('unknown command'); process.exit(1);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
