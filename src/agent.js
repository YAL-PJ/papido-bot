// agent.js — the core: answer(customerId, text, payload?) -> { reply, images, choices, ... }.
// Channel-agnostic: web chat, Twilio and Meta WhatsApp all call this same function.
//  • Button / list taps (payload)  -> flow.js, deterministic, no model call.
//  • Free text                     -> language model + tools.

const { declarations, makeExecutor } = require('./tools');
const { staticPrompt, statePrompt, menuPrompt } = require('./prompt');
const { proofread } = require('./proofread');
const { createFlow } = require('./flow');
const tel = require('./telemetry');

const MAX_TOOL_ROUNDS = 8;
const MAX_HISTORY = 40;

function trimHistory(history) {
  if (history.length <= MAX_HISTORY) return history;
  // cut only at a user text message so tool calls/results stay paired
  let start = history.length - MAX_HISTORY;
  while (start < history.length && history[start].role !== 'user') start++;
  return history.slice(start);
}

const asChoice = (x) => (typeof x === 'string' ? { id: null, title: x } : x);

function createAgent({ llm, menu, business, store, options = {} }) {
  const execute = makeExecutor({ menu, business, store, options });
  const flow = createFlow({ menu, business, store, execute });
  const system = staticPrompt({ business, menu });
  const queues = new Map(); // one message at a time per customer
  let callId = 0;

  // Buttons after a free-text turn, when the model didn't choose any: based on what happened.
  function defaultChoices(session, toolLog, reply) {
    const ok = (name) => toolLog.some((t) => t.name === name && !t.result?.error);
    const withChoices = [...toolLog].reverse().find((t) => t.result?.choices);
    if (session.status === 'done' || session.status === 'handoff') return null;
    if (withChoices) return withChoices.result.choices;
    if (ok('show_summary')) return [{ id: 'confirm', title: '✅ מאשר' }, { id: 'edit', title: '✏️ לשנות משהו' }];
    if (ok('send_menu') && session.service) return null;
    if (ok('send_menu') && !session.service) return flow.serviceChoices(); // categories are added in finish()
    const lastAdd = [...toolLog].reverse().find((t) => t.name === 'add_to_cart' && !t.result?.error);
    if (lastAdd && session.cart.length) {
      // same next step as a tap would give: toppings list for build-your-own, or the add-ons/next buttons
      const a = flow.afterAdd(session, session.cart.length);
      session.out.listTitle = session.out.listTitle || a.listTitle || null;
      return a.choices;
    }
    if (ok('modify_cart_item') || ok('repeat_last_order')) {
      return [{ id: 'cats', title: '➕ עוד מנה' }, { id: 'checkout', title: '✔️ לסיום ההזמנה' }, { id: 'cart', title: '🛒 הסל' }];
    }
    if (!session.service && /משלוח/.test(reply) && /איסוף/.test(reply)) return flow.serviceChoices();
    // nothing started yet (greeting, a question): a tap is the quickest way in
    if (!session.service && !session.cart.length && session.status === 'open') return [{ id: 'menu', title: '📋 תפריט' }, ...flow.serviceChoices()];
    return null;
  }

  // model-triggered clickable list (categories, or dishes in one category)
  function showList(session, { category }) {
    if (!session.service) return { error: 'קודם משלוח או איסוף (שאל עם כפתורים).' };
    const cats = flow.catalogs[session.service];
    let r;
    if (category) {
      const norm = (x) => String(x).replace(/[^א-תa-zA-Z ]/g, '').trim();
      const i = cats.findIndex((c) => norm(c.title) === norm(category)) >= 0
        ? cats.findIndex((c) => norm(c.title) === norm(category))
        : cats.findIndex((c) => norm(c.title).includes(norm(category)) || norm(category).includes(norm(c.title)));
      if (i < 0) return { error: `אין קטגוריה כזו. יש: ${cats.map((c) => c.title).join(', ')}` };
      r = { choices: cats[i].items.slice(0, 9).map((it, k) => ({ id: `item:${i}:${k}`, title: it.title })), listTitle: cats[i].title };
      if (cats[i].items.length > 9) r.choices.push({ id: `cat:${i}:1`, title: 'עוד ›' });
    } else {
      r = { choices: cats.map((c, i) => ({ id: `cat:${i}:0`, title: `${c.emoji} ${c.title}` })), listTitle: 'תפריט' };
    }
    session.out.choices = r.choices;
    session.out.listTitle = r.listTitle;
    return { ok: true, shown: r.choices.map((x) => x.title), note: 'הלקוח רואה רשימה לחיצה. כתוב שורה קצרה אחת בלבד.' };
  }

  // buttons the model wrote as plain text still get the deterministic action when tapped
  function knownPayload(title, session) {
    const t = String(title);
    if (/משלוח/.test(t) && !/איסוף/.test(t)) return 'svc:delivery';
    if (/איסוף/.test(t) && !/משלוח/.test(t)) return 'svc:takeaway';
    if (!session.service) return null;
    if (/^✅|^מאשר|^כן,? מאשר/.test(t)) return 'confirm';
    if (/תפריט/.test(t)) return 'menu';
    if (/לסיום|לסיים/.test(t)) return 'checkout';
    if (/עוד מנה|להוסיף עוד/.test(t)) return 'cats';
    if (/הסל/.test(t)) return 'cart';
    if (/^(💵 )?מזומן$/.test(t)) return 'pay:מזומן';
    if (/^(💳 )?אשראי$/.test(t)) return 'pay:אשראי';
    if (/תוספות/.test(t) && session.cart.length) return `opts:${session.cart.length}:0`;
    return null;
  }

  function finish(session, reply, toolLog, extra = {}) {
    const out = session.out;
    let choices = extra.choices || out.choices || defaultChoices(session, toolLog, reply);
    let listTitle = extra.listTitle || out.listTitle;
    // menu was sent -> show the category list right under it
    if (!choices && out.images.length && session.service) {
      const cats = flow.catalogs[session.service].map((cat, i) => ({ id: `cat:${i}:0`, title: `${cat.emoji} ${cat.title}`, description: (cat.items.length === 1 ? "מנה אחת" : `${cat.items.length} מנות`) }));
      choices = cats;
      listTitle = 'תפריט';
    }
    choices = choices ? choices.map(asChoice).map((ch) => (ch.id ? ch : { ...ch, id: knownPayload(ch.title, session) })) : null;
    listTitle = listTitle || out.listTitle;
    session.lastChoices = choices;
    const result = { reply, images: out.images, links: out.links, choices, listTitle, tools: toolLog, session };
    session.out = { images: [], links: [], choices: null, listTitle: null };
    return result;
  }

  // "יש ביצים בפיצה?", "אלרגיה לאגוזים", "יש ללא גלוטן?" — but not an order line like "בלי ביצה"
  const ALLERGEN = /אלרג|רגישות ל|ביצ(ה|ים)|אגוז|בוטנ|שומשום|גלוטן|צליאק|לקטוז|סויה|allerg|gluten|nuts?\b|eggs?\b/i;
  function isAllergyQuestion(text) {
    if (!ALLERGEN.test(text)) return false;
    if (/^(בלי|עם|תוריד|תוסיף|להוריד|להוסיף|without|no )/i.test(text.trim())) return false;
    return /\?|אלרג|רגיש|צליאק|מכיל|בטוח|מתאים|allerg/i.test(text);
  }
  function allergyReply(text) {
    const a = business.data.allergens || {};
    const lines = [`מה שידוע לנו: ${a.known || '[לעדכן]'}`];
    if (/גלוטן|צליאק|gluten/i.test(text) && a.gluten) lines.push(a.gluten);
    lines.push('אין לנו פירוט מלא של רכיבי הבצק והרטבים, ולכן אנחנו לא יכולים להבטיח שמנה כלשהי ללא אלרגן מסוים.');
    lines.push('באלרגיה — הכי בטוח לבדוק עם הצוות לפני ההזמנה 👇');
    return lines.join('\n');
  }

  function cartConfirmation(session, toolLog) {
    const lines = [];
    for (const t of toolLog) {
      if (t.name === 'add_to_cart' && t.result?.added) lines.push(`✓ נוסף: ${t.result.added}`);
      if (t.name === 'modify_cart_item' && t.result?.updated) lines.push(`✓ עודכן: ${t.result.updated}`);
      if (t.name === 'set_service' && t.result?.price_changes) lines.push(`מחירים מעודכנים: ${t.result.price_changes.join(' · ')}`);
    }
    if (!lines.length) return null;
    const subtotal = session.cart.reduce((n, l) => n + l.total, 0);
    if (session.cart.length > 1) lines.push(`🛒 בסל: ${Math.round(subtotal * 100) / 100}₪`);
    return lines.join('\n');
  }

  async function handle(customerId, rawText, rawPayload) {
    const session = store.session(customerId);
    let text = String(rawText || '').trim().slice(0, 2000);
    let payload = rawPayload || null;

    // "2" right after buttons = the 2nd button (Twilio / typed answers)
    if (!payload && /^\d{1,2}$/.test(text) && session.lastChoices && session.lastChoices[Number(text) - 1]) {
      const ch = session.lastChoices[Number(text) - 1];
      tel.log('input.number_choice', { number: Number(text), choice: ch.title, payload: ch.id || null }, 'debug');
      text = ch.title;
      payload = ch.id || null;
    }

    // ---- short, unambiguous requests go straight to the flow (fast, no model): "תפריט", "מה יש?", "הסל" ----
    if (!payload && text.length <= 40 && !/\d/.test(text)) {
      if (/תפריט|^menu\b/i.test(text) || /^מה (יש|יש לכם|אפשר להזמין)\??$/.test(text)) payload = 'menu';
      else if (/^(מה )?(ב|יש ב)?סל( שלי)?\??$|^הסל( שלי)?\??$/.test(text)) payload = 'cart';
      else if (/^(🛵 )?(ב?משלוח|delivery)[.!]?$/i.test(text)) payload = 'svc:delivery';
      else if (/^(🏃 )?(ב?איסוף( עצמי)?|pickup|takeaway)[.!]?$/i.test(text)) payload = 'svc:takeaway';
      if (payload) tel.log('input.intent_shortcut', { text, payload }, 'debug');
    }

    // ---- allergy questions: a fixed answer from the knowledge base, never the model's guess ----
    if (!payload && isAllergyQuestion(text)) {
      tel.log('input.allergy_question', { text: tel.truncate(text, 200) }, 'info');
      const reply = allergyReply(text);
      session.history.push({ role: 'user', text }, { role: 'assistant', text: reply });
      session.history = trimHistory(session.history);
      return { ...finish(session, reply, [{ name: 'fixed:allergy', args: {}, result: { ok: true } }], {
        choices: [{ id: 'handoff:allergy', title: '👤 לבדוק עם הצוות' }, { id: 'menu', title: '📋 תפריט' }],
      }), path: 'flow' };
    }

    // ---- taps: deterministic flow ----
    if (payload) {
      const r = await flow.handle(session, payload);
      tel.count(r ? 'flow.taps' : 'flow.unknown_payload');
      tel.log('flow.tap', { payload, handled: !!r }, r ? 'debug' : 'warn');
      if (r) {
        session.history.push({ role: 'user', text: text || payload });
        session.history.push({ role: 'assistant', text: r.reply });
        session.history = trimHistory(session.history);
        return { ...finish(session, r.reply, [{ name: `flow:${payload}`, args: {}, result: { ok: true } }], r), path: 'flow' };
      }
    }

    // ---- free text: language model ----
    session.history.push({ role: 'user', text });
    const toolLog = [];
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const res = await llm.complete({
          system: `${system}\n${menuPrompt(menu, session.service)}\n\n${statePrompt({ session, business, store, ignoreHours: options.ignoreHours ?? process.env.DEMO_IGNORE_HOURS !== 'false' })}`,
          history: session.history,
          tools: declarations,
        });

        if (!res.toolCalls.length) {
          let reply = res.text || 'סליחה, לא הבנתי. אפשר לנסח שוב?';
          // what was added/changed + its price comes from code, never from the model's wording
          const confirm = cartConfirmation(session, toolLog);
          if (confirm) {
            const restated = /^(הוספתי|נוסף|נוספ|הוסף|עדכנתי|עודכ|שיניתי|מעולה|סגור|אחלה|בשמחה|רשמתי|added|done)/i.test(reply.trim());
            reply = restated || !res.text ? confirm : `${confirm}\n\n${reply}`;
          }
          // safety net: the model says "here is the menu" but never called send_menu
          if (/התפריט\s*👆|הנה התפריט|here.{0,10}menu/i.test(reply) && !session.out.images.length && session.service) {
            const r = await execute(session, 'send_menu', { section: 'all' }, { source: 'safety-net' });
            toolLog.push({ name: 'send_menu (auto)', args: {}, result: r });
            tel.log('safety_net.menu', { message: 'model said "here is the menu" without sending it — sent automatically' }, 'warn');
          }
          // safety net: the model promised to check with the team but never handed off — nobody would check
          let finalReply = reply;
          const handedOff = toolLog.some((t) => t.name === 'handoff_to_human' && !t.result?.error);
          if (!handedOff && /(אבדוק|נבדוק|אברר|נברר|אבדוק את זה|אעביר (את )?(זה|השאלה)|הצוות (יחזור|יחזרו|יבדוק|יבדקו))/.test(reply) && !/\?\s*$/.test(reply)) {
            const r = await execute(session, 'handoff_to_human', { reason: `auto (model said it would check): ${text.slice(0, 200)}` }, { source: 'safety-net' });
            toolLog.push({ name: 'handoff_to_human (auto)', args: {}, result: r });
            tel.log('safety_net.handoff', { message: 'model promised to check without handing off — handed off automatically' }, 'warn');
            finalReply = `${reply}\n${r.message_for_customer}`;
          }
          // the model's own words get a spelling check before they go out (the code-built confirmation lines don't need it)
          if (!confirm || finalReply !== confirm) finalReply = await proofread(llm, finalReply);
          session.history.push({ role: 'assistant', text: finalReply, raw: res.raw });
          session.history = trimHistory(session.history);
          return { ...finish(session, finalReply, toolLog), path: 'llm', rounds: round + 1 };
        }

        const calls = res.toolCalls.map((c) => ({ ...c, id: c.id || `call_${++callId}` }));
        session.history.push({ role: 'assistant', text: res.text, toolCalls: calls, raw: res.raw });
        const results = [];
        for (const c of calls) {
          const result = c.name === 'show_list' ? showList(session, c.args || {}) : await execute(session, c.name, c.args);
          toolLog.push({ name: c.name, args: c.args, result });
          results.push({ id: c.id, name: c.name, result });
        }
        session.history.push({ role: 'tool', results });
      }
      tel.log('llm.too_many_rounds', { rounds: MAX_TOOL_ROUNDS, tools: toolLog.map((t) => t.name) }, 'error');
      return { ...finish(session, 'משהו השתבש אצלי — מעביר לצוות שיחזרו אליך.', toolLog), path: 'llm' };
    } catch (e) {
      tel.log('llm.turn_failed', { message: e.message, toolsBeforeFailure: toolLog.map((t) => t.name) }, 'error');
      // The model failed mid-turn. If the order was already confirmed, never leave the customer guessing.
      const confirmed = toolLog.find((t) => t.name === 'confirm_order' && t.result?.ok);
      if (confirmed) {
        const r = confirmed.result;
        const reply = `✅ הזמנה #${r.order_number} התקבלה! ${session.service === 'delivery' ? 'תגיע' : 'תהיה מוכנה'} תוך ${r.eta_minutes} דק'. בתיאבון 🍕`;
        session.history.push({ role: 'assistant', text: reply });
        return { ...finish(session, reply, toolLog), error: e.message, path: 'llm' };
      }
      // drop the unanswered turn so the history stays valid for the next attempt
      while (session.history.length && session.history[session.history.length - 1].role !== 'user') session.history.pop();
      session.history.pop();
      // the buttons still work without the model
      const fallback = session.service
        ? [{ id: 'cats', title: '📋 תפריט' }, { id: 'cart', title: '🛒 הסל' }, { id: 'checkout', title: '✔️ לסיום' }]
        : flow.serviceChoices();
      return { ...finish(session, 'יש לי תקלה רגעית בהבנת טקסט 🙏 אפשר לנסות שוב, או להמשיך עם הכפתורים:', toolLog, { choices: fallback }), error: e.message, path: 'llm' };
    }
  }

  // one customer message = one trace: turn.start … (llm.call / tool.call / flow.tap) … turn.end
  async function traced(customerId, text, payload, meta) {
    return tel.withTrace({ customer: customerId, channel: meta.channel || 'api' }, async () => {
      const t0 = Date.now();
      tel.count('turns');
      try {
        await store.load(customerId);
        const conv = store.session(customerId);
        tel.setConversation(conv.conversationId);
        tel.log('turn.start', { text: tel.truncate(text, 500), payload: payload || undefined });
        const messageId = tel.currentTrace();
        store.record(conv, { messageId, from: 'customer', channel: meta.channel || 'api', text, ...(payload ? { payload } : {}) });
        const r = await handle(customerId, text, payload);
        const ms = Date.now() - t0;
        tel.timing(r.path === 'flow' ? 'turn.flow' : 'turn.llm', ms);
        tel.log('turn.end', {
          ms, path: r.path, reply: tel.truncate(r.reply, 800),
          choices: r.choices ? r.choices.map((c) => c.id || c.title) : undefined,
          images: r.images?.length || undefined,
          tools: r.tools.map((t) => t.name),
          cart: r.session.cart.length, status: r.session.status,
          ...(r.error ? { error: r.error } : {}),
        }, r.error ? 'warn' : 'info');
        // the order may have closed the conversation: the reply still belongs to the one the message came in on
        store.record(conv, {
          messageId, from: 'bot', text: r.reply,
          ...(r.choices ? { choices: r.choices.map((c) => c.title) } : {}),
          ...(r.images?.length ? { images: r.images.length } : {}),
          ...(r.tools.length ? { tools: r.tools.map((t) => t.name) } : {}),
          ...(r.error ? { error: r.error } : {}),
          path: r.path, ms,
        });
        await store.persist(customerId);
        return { ...r, traceId: messageId, conversationId: conv.conversationId };
      } catch (e) {
        tel.log('turn.exception', { ms: Date.now() - t0, message: e.message, stack: e.stack?.split('\n').slice(0, 5).join(' | ') }, 'error');
        throw e;
      }
    });
  }

  return {
    answer(customerId, text, payload, meta = {}) {
      const prev = queues.get(customerId) || Promise.resolve();
      const next = prev.then(() => traced(customerId, text, payload, meta));
      queues.set(customerId, next.catch(() => {}));
      return next;
    },
    systemPrompt: system,
  };
}

module.exports = { createAgent };
