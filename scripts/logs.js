// Read the bot's logs from the terminal.
//   npm run logs                      last 40 events of today
//   npm run logs -- errors            today's warnings + errors
//   npm run logs -- trace <traceId>   everything that happened for one customer message
//   npm run logs -- chats             today's conversations, message by message
//   npm run logs -- stats             counts, latency, tokens and costs for today
//   add --date 2026-10-14 to look at another day

require('../src/env').loadEnv();
const fs = require('fs');
const path = require('path');
const { LOG_DIR } = require('../src/telemetry');

const args = process.argv.slice(2);
const dateIdx = args.indexOf('--date');
const date = dateIdx >= 0 ? args.splice(dateIdx, 2)[1] : new Date().toISOString().slice(0, 10);
const [cmd = 'tail', arg] = args;

const file = path.join(LOG_DIR, `app-${date}.jsonl`);
if (!fs.existsSync(file)) { console.log(`אין לוג ליום ${date} (${file})`); process.exit(0); }
const events = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const t = (e) => e.ts.slice(11, 19);
const brief = (e) => String(e.message || e.reply || e.text || e.name || e.path || (e.toolCalls ? `→ ${e.toolCalls.join(', ') || 'text'}` : '') || '').replace(/\n/g, ' ⏎ ');
const line = (e) => `${t(e)} ${e.traceId ? e.traceId.slice(0, 8) : '        '} ${e.level.padEnd(5)} ${e.type.padEnd(22)} ${brief(e).slice(0, 110)}${e.ms != null ? ` (${e.ms}ms)` : ''}`;

if (cmd === 'tail') {
  events.slice(-Number(arg || 40)).forEach((e) => console.log(line(e)));
} else if (cmd === 'errors') {
  events.filter((e) => e.level === 'warn' || e.level === 'error').forEach((e) => console.log(line(e)));
} else if (cmd === 'trace') {
  const ev = events.filter((e) => e.traceId && e.traceId.startsWith(arg || ''));
  if (!ev.length) console.log('לא נמצא trace כזה');
  for (const e of ev) {
    const { ts, level, type, traceId, ...rest } = e;
    console.log(`\n${t(e)} ${level} ${type}`);
    console.log(JSON.stringify(rest, null, 2));
  }
} else if (cmd === 'chats') {
  let last = null;
  for (const e of events.filter((x) => x.type === 'turn.start' || x.type === 'turn.end')) {
    if (e.customer !== last) { console.log(`\n── ${e.customer} (${e.channel}) ──`); last = e.customer; }
    if (e.type === 'turn.start') console.log(`${t(e)} 👤 ${e.payload ? `[לחיצה] ${e.text}` : e.text}`);
    else console.log(`${t(e)} 🤖 ${String(e.reply || '').replace(/\n/g, '\n           ')}   [${e.path}, ${e.ms}ms, ${e.traceId.slice(0, 8)}]`);
  }
} else if (cmd === 'stats') {
  const by = (type) => events.filter((e) => e.type === type);
  const ms = (arr) => { const s = arr.map((e) => e.ms).filter((x) => x != null).sort((a, b) => a - b); return s.length ? `avg ${Math.round(s.reduce((a, b) => a + b, 0) / s.length)} · p95 ${s[Math.floor(s.length * 0.95)] ?? s[s.length - 1]} ms` : '—'; };
  const llm = by('llm.call');
  const llmFailed = by('llm.http_error').length + by('llm.network_error').length;
  const tok = llm.reduce((a, e) => ({ p: a.p + (e.tokens?.prompt || 0), o: a.o + (e.tokens?.output || 0), th: a.th + (e.tokens?.thoughts || 0) }), { p: 0, o: 0, th: 0 });
  const turns = by('turn.end');
  const counts = {};
  events.forEach((e) => { counts[e.type] = (counts[e.type] || 0) + 1; });
  console.log(`יום ${date}`);
  console.log(`הודעות: ${turns.length} (לחיצות ${turns.filter((e) => e.path === 'flow').length}, טקסט ${turns.filter((e) => e.path === 'llm').length})`);
  console.log(`  זמן לחיצה: ${ms(turns.filter((e) => e.path === 'flow'))} | זמן טקסט: ${ms(turns.filter((e) => e.path === 'llm'))}`);
  console.log(`קריאות למודל: ${llm.length} הצליחו, ${llmFailed} נכשלו | ${ms(llm)} | טוקנים: קלט ${tok.p}, פלט ${tok.o}, חשיבה ${tok.th}`);
  console.log(`  ממוצע קריאות למודל להודעת טקסט: ${(llm.length / Math.max(1, turns.filter((e) => e.path === 'llm').length)).toFixed(1)}`);
  console.log(`הזמנות: ${by('order.created').length} | סכום: ${by('order.created').reduce((a, e) => a + e.total, 0)}₪ | העברות לצוות: ${by('handoff').length}`);
  console.log(`שגיאות: ${events.filter((e) => e.level === 'error').length} | אזהרות: ${events.filter((e) => e.level === 'warn').length}`);
  const tools = {};
  by('tool.call').forEach((e) => { tools[e.name] = (tools[e.name] || 0) + 1; });
  console.log(`כלים: ${Object.entries(tools).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(', ') || '—'}`);
  console.log(`\nכל סוגי האירועים:\n${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${k.padEnd(24)} ${v}`).join('\n')}`);
} else {
  console.log('פקודות: tail [n] | errors | trace <id> | chats | stats   (+ --date YYYY-MM-DD)');
}
