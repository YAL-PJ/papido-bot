// timeline.js — turns raw log events into one readable Hebrew line per action:
// who acted (customer / code / Gemini / system) and what exactly happened.
// Used by GET /api/timeline, the /timeline page and `npm run remote -- timeline <id>`.

const short = (v, n = 300) => {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};
const q = (s, n) => `"${short(String(s ?? '').replace(/\n/g, ' ⏎ '), n)}"`;
const args = (a) => (a && Object.keys(a).length ? Object.entries(a).map(([k, v]) => `${k}=${short(v, 80)}`).join(', ') : '');
const sec = (ms) => (ms == null ? '' : ms >= 1000 ? `${(ms / 1000).toFixed(1)} שנ'` : `${ms}ms`);

// actor → icon + label shown in the "who" column
const ACTORS = {
  customer: ['👤', 'לקוח'],
  code: ['⚙️', 'קוד'],
  model: ['🤖', "ג'מיני"],
  bot: ['💬', 'בוט→לקוח'],
  system: ['🖥️', 'מערכת'],
};

function describe(e) {
  const d = (actor, text) => ({ actor, icon: ACTORS[actor][0], who: ACTORS[actor][1], text });
  switch (e.type) {
    case 'conversation.start': return d('system', `שיחה חדשה נפתחה ${e.conversationId || ''}`);
    case 'turn.start': return d('customer', e.payload ? `לחץ על כפתור [${e.payload}]${e.text ? ` (${q(e.text, 80)})` : ''}` : `כתב: ${q(e.text, 500)}`);
    case 'input.number_choice': return d('code', `המספר ${e.number} = הכפתור ה-${e.number}: "${e.choice}" → ${e.payload || 'טקסט'}`);
    case 'input.intent_shortcut': return d('code', `זיהה בקשה קצרה ${q(e.text, 60)} → מטפל כמו לחיצה [${e.payload}] בלי מודל`);
    case 'input.allergy_question': return d('code', 'זיהה שאלת אלרגיה → תשובה קבועה מהמאגר (לא נשלח למודל)');
    case 'agent.route': return d('code', `ניתוב: ${e.reason}`);
    case 'flow.tap': return d('code', e.handled ? `טיפל בלחיצה [${e.payload}] בקוד (flow.js)` : `לחיצה לא מוכרת [${e.payload}] → עובר למודל`);
    case 'flow.stale_button': return d('code', `כפתור ישן [${e.payload}] (מהזמנה שנסגרה) — לא בוצע`);
    case 'llm.request': return d('code', `שולח לג'מיני (סבב ${e.round}) · ${e.historyMessages} הודעות בהיסטוריה · מצב: ${q(e.state, 400)}`);
    case 'llm.call': {
      const what = e.purpose === 'proofread' ? 'הגהה' : 'החליט';
      const calls = (e.calls || (e.toolCalls || []).map((name) => ({ name }))).map((c) => `${c.name}(${args(c.args)})`);
      const parts = [];
      if (calls.length) parts.push(`לקרוא לכלים: ${calls.join(' ; ')}`);
      if (e.text) parts.push(`טקסט: ${q(e.text, 400)}`);
      if (e.thoughts) parts.push(`מחשבות: ${q(e.thoughts, 300)}`);
      const tok = e.tokens ? ` · ${e.tokens.prompt ?? '?'}→${e.tokens.output ?? '?'} טוקנים` : '';
      return d('model', `${what}${parts.length ? ' ' + parts.join(' | ') : ' (ריק)'} · ${sec(e.ms)}${tok}${e.finishReason && e.finishReason !== 'STOP' ? ` · ${e.finishReason}` : ''}`);
    }
    case 'llm.throttled': return d('system', `המתנה למגבלת קצב של ג'מיני ${sec(e.waitedMs)}`);
    case 'llm.http_error': return d('system', `ג'מיני החזיר שגיאה ${e.status} (ניסיון ${(e.attempt ?? 0) + 1})${e.retrying ? ` — מנסה שוב בעוד ${sec(e.retryInMs)}` : ' — מוותר'}`);
    case 'llm.network_error': return d('system', `תקלת רשת מול ג'מיני: ${short(e.message, 150)}`);
    case 'llm.fallback_model': return d('system', `ג'מיני עמוס → עובר למודל גיבוי ${e.to}`);
    case 'llm.empty': return d('model', 'החזיר תשובה ריקה');
    case 'llm.unusual_finish': return d('model', `סיים בצורה חריגה: ${e.finishReason}`);
    case 'llm.too_many_rounds': return d('code', `יותר מדי סבבי כלים (${e.rounds}) — עוצר ומעביר לצוות`);
    case 'llm.turn_failed': return d('code', `הסבב מול המודל נכשל: ${short(e.message, 200)} → תשובת גיבוי עם כפתורים`);
    case 'tool.call': {
      const by = e.source === 'llm' ? "לבקשת ג'מיני" : e.source === 'flow' ? 'מלחיצה' : e.source === 'safety-net' ? 'רשת ביטחון' : e.source;
      return d('code', `הריץ ${e.name}(${args(e.args)}) [${by}] → ${e.ok ? '✓' : '✗'} ${short(e.result, 300)}`);
    }
    case 'tool.unknown': return d('code', `ג'מיני ביקש כלי שלא קיים: ${e.name}`);
    case 'tool.exception': return d('code', `קריסה בכלי ${e.name}: ${short(e.message, 200)}`);
    case 'dish.ambiguous': return d('code', `${q(e.name, 60)} לא חד-משמעי → מציג כפתורים: ${(e.options || []).join(' / ')}`);
    case 'cart.move_dropped': return d('code', `במעבר ל${e.to === 'delivery' ? 'משלוח' : 'איסוף'} הוסרו מנות שלא קיימות שם: ${short(e.dropped, 200)}`);
    case 'reply.compose': return d('code', `הרכיב תשובה: ${e.codePart ? `חלק מהקוד ${q(e.codePart, 200)}` : ''}${e.codePart && e.modelPart ? ' + ' : ''}${e.modelPart ? `חלק מהמודל ${q(e.modelPart, 200)}` : ''}${e.droppedModel ? ` (טקסט המודל הושמט: ${e.droppedModel})` : ''}`);
    case 'reply.dropped_early_details': return d('code', `השמיט את שאלת הפרטים של המודל (מוקדם מדי): ${q(e.text, 150)}`);
    case 'proofread.ok': return d('code', `הגהה: אין תיקונים (${sec(e.ms)})`);
    case 'proofread.fixed': return d('code', `הגהה תיקנה: ${q(e.before, 150)} → ${q(e.after, 150)}`);
    case 'proofread.rejected': return d('code', `הגהה נדחתה (${e.why}) — נשלח המקור`);
    case 'proofread.skipped': return d('code', `הגהה דולגה: ${short(e.message, 100)}`);
    case 'safety_net.menu': return d('code', 'רשת ביטחון: המודל אמר "הנה התפריט" בלי לשלוח — נשלח אוטומטית');
    case 'safety_net.handoff': return d('code', 'רשת ביטחון: המודל הבטיח לבדוק בלי להעביר לצוות — הועבר אוטומטית');
    case 'handoff': return d('code', `הועבר לצוות: ${short(e.reason, 200)}`);
    case 'order.created': return d('code', `📦 הזמנה #${e.number} נוצרה · ${e.total}₪ · ${e.items} פריטים`);
    case 'turn.end': return d('bot', `${q(e.reply, 800)}${(e.buttons || e.choices) ? ` · כפתורים: [${(e.buttons || e.choices).join(' | ')}]` : ''}${e.images ? ` · ${e.images} תמונות` : ''} · ${e.path === 'flow' ? 'בלי מודל' : 'דרך מודל'} · סה"כ ${sec(e.ms)} · סל: ${e.cart}${e.error ? ` · ⚠️ ${e.error}` : ''}`);
    case 'turn.exception': return d('system', `קריסה בטיפול בהודעה: ${short(e.message, 200)}`);
    case 'http.request': return d('system', `${e.method} ${e.path} → ${e.status} (${sec(e.ms)})`);
    case 'http.exception': return d('system', `שגיאה בשרת ${e.path}: ${short(e.message, 200)}`);
    case 'server.start': return d('system', `השרת עלה · ${e.llm} · אחסון ${e.storage}`);
    case 'server.stop': return d('system', `השרת נכבה (${e.signal})`);
    case 'prompt.loaded': return d('system', `הנחיית מערכת נטענה · ${e.chars} תווים · ${e.hash}`);
    case 'storage.error': return d('system', `שגיאת אחסון Redis: ${short(e.message || e.body, 200)}`);
    case 'meta.sent': return d('system', `נשלח ל-WhatsApp (${e.type})`);
    case 'meta.send_failed': return d('system', `שליחה ל-WhatsApp נכשלה ${e.status}: ${short(e.message, 150)}`);
    default: {
      const { ts, level, type, traceId, customer, channel, conversationId, ...rest } = e;
      return d('system', `${type} ${short(rest, 300)}`);
    }
  }
}

// events -> rows; `noise: false` drops background requests (health checks, page polling)
function timeline(events, { noise = false } = {}) {
  return events
    .filter((e) => noise || !(e.type === 'http.request' && e.status < 400) && e.type !== 'llm.throttled')
    .map((e) => ({ ts: e.ts, level: e.level, type: e.type, traceId: e.traceId || null, conversationId: e.conversationId || null, ...describe(e), raw: e }));
}

module.exports = { describe, timeline };
