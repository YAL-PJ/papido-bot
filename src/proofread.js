// proofread.js — a last look at every model-written reply before it is sent: fixes spelling/typos only.
// Guarded: if the "fix" changes numbers/prices, emojis, line structure or too much text, the original is sent.
// Never blocks a reply for long: one attempt with a short timeout; on any failure the original goes out.
// Env: PROOFREAD=off to disable · PROOFREAD_TIMEOUT_MS (default 5000)

const tel = require('./telemetry');

const SYSTEM = `אתה מגיה. מקבל הודעת וואטסאפ קצרה של נציג פיצרייה ומחזיר אותה מתוקנת.
תקן רק: שגיאות כתיב, אותיות כפולות או חסרות, מילים שנדבקו, דקדוק שבור בבירור.
אסור: לשנות תוכן, מספרים, מחירים, שמות מנות, אימוג'י, סימני *, שורות, סגנון או אורך. לא להוסיף ולא להוריד מידע.
אם אין מה לתקן — החזר את ההודעה בדיוק כמו שהיא. החזר רק את ההודעה, בלי הסברים ובלי מרכאות.`;

const digits = (s) => (s.match(/\d+/g) || []).join(',');
const emojis = (s) => (s.match(/\p{Extended_Pictographic}/gu) || []).join('');
const lines = (s) => s.split('\n').length;

function acceptable(before, after) {
  if (!after) return 'empty';
  if (digits(before) !== digits(after)) return 'numbers changed';
  if (emojis(before) !== emojis(after)) return 'emojis changed';
  if (Math.abs(lines(before) - lines(after)) > 0) return 'lines changed';
  const ratio = after.length / before.length;
  if (ratio < 0.9 || ratio > 1.1) return 'length changed too much';
  return null;
}

async function proofread(llm, text) {
  if ((process.env.PROOFREAD || 'on') === 'off' || !text || text.length < 8 || !/[א-ת]/.test(text)) return text;
  const t0 = Date.now();
  try {
    const res = await llm.complete({
      system: SYSTEM,
      history: [{ role: 'user', text }],
      tools: [],
      maxAttempts: 1,
      timeoutMs: Number(process.env.PROOFREAD_TIMEOUT_MS || 5000),
      purpose: 'proofread',
    });
    const after = (res.text || '').trim().replace(/^["“”']|["“”']$/g, '');
    const ms = Date.now() - t0;
    tel.timing('proofread', ms);
    if (after === text.trim()) { tel.log('proofread.ok', { ms }, 'debug'); return text; }
    const why = acceptable(text, after);
    if (why) { tel.log('proofread.rejected', { ms, why, before: text, after }, 'warn'); return text; }
    tel.count('proofread.fixed');
    tel.log('proofread.fixed', { ms, before: text, after }, 'info');
    return after;
  } catch (e) {
    tel.log('proofread.skipped', { ms: Date.now() - t0, message: e.message }, 'warn');
    return text;
  }
}

module.exports = { proofread, acceptable };
