// Deterministic tests — no API key needed.  Run: npm test
// tests never write into the real logs/ folder
process.env.LOG_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'papido-logs-'));
process.env.PROOFREAD = 'off'; // the fake models in these tests answer by script; proofreading has its own test
process.env.LOG_CONSOLE = 'silent';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Menu } = require('../src/menu');
const { Business } = require('../src/business');
const { Store } = require('../src/store');
const { makeExecutor } = require('../src/tools');
const { createAgent } = require('../src/agent');

const menu = new Menu();
const business = new Business();
const tmpStore = () => new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'papido-')));
const idOf = (service, name) => menu.products[service].find((p) => p.name === name).id;

test('takeaway prices match the live site (screenshot)', () => {
  const price = (n) => menu.products.takeaway.find((p) => p.name === n).variants[0].price;
  assert.equal(price('אצבעות מוצרלה'), 45);
  assert.equal(price('מיני קלזון פיצה'), 6);
  assert.equal(price('פופקורן כרובית'), 30);
  assert.equal(price('טבעות בצל'), 27);
});

test('delivery pizza needs a size; L price comes from the price list', () => {
  const id = idOf('delivery', 'פיצה מרגריטה אישית');
  assert.match(menu.buildLine('delivery', { product_id: id }).error, /גודל/);
  assert.equal(menu.buildLine('delivery', { product_id: id, size: 'L' }).line.total, 117);
  assert.equal(menu.buildLine('delivery', { product_id: id, size: 'אישית', quantity: 2 }).line.total, 130);
});

test('removing an included ingredient is free', () => {
  const id = idOf('takeaway', 'אצבעות מוצרלה');
  const r = menu.buildLine('takeaway', { product_id: id, remove: ['רוטב מרינרה'] });
  assert.equal(r.line.total, 45);
  assert.deepEqual(r.line.remove, ['רוטב מרינרה']);
});

test('make-your-own pizza: sauce required, half toppings need a side', () => {
  const id = idOf('takeaway', 'פיצה בהרכבה אישית');
  assert.match(menu.buildLine('takeaway', { product_id: id }).error, /חובה/);
  const ambiguous = menu.buildLine('takeaway', { product_id: id, add: ['רוטב קלאסי', 'זיתי קלמטה'] });
  assert.match(ambiguous.error, /לציין איפה/);
  const ok = menu.buildLine('takeaway', { product_id: id, add: ['רוטב קלאסי', 'חצי ימין: זיתי קלמטה'] });
  assert.ok(ok.line, ok.error);
  assert.ok(ok.line.total > 40);
});

test('unknown topping is rejected with the valid list', () => {
  const id = idOf('takeaway', 'פיצה גבינה אישית');
  assert.match(menu.buildLine('takeaway', { product_id: id, add: ['אנשובי'] }).error, /לא אפשרי/);
});

test('delivery zones', () => {
  assert.equal(business.zoneFor('הרב קוק 12, מרכז העיר').fee, 15);
  assert.equal(business.zoneFor('רמות ב').fee, 25);
  assert.ok(business.zoneFor('מבשרת ציון').error);
});

test('full order flow: summary is required before confirm, changes invalidate it', async () => {
  const store = tmpStore();
  const exec = makeExecutor({ menu, business, store, options: { ignoreHours: true } });
  const s = store.session('+972500000009');

  assert.ok((await exec(s, 'add_to_cart', { product_id: 'd1' })).error, 'needs service first');
  await exec(s, 'set_service', { service: 'delivery' });
  await exec(s, 'add_to_cart', { product_id: idOf('delivery', 'פיצה מרגריטה אישית'), size: 'L', quantity: 2 });
  assert.ok((await exec(s, 'show_summary', {})).error, 'missing name/address');

  assert.ok((await exec(s, 'set_details', { name: 'יוסי', address: 'מאדים 5, גלקסיה' })).error, 'unknown area');
  await exec(s, 'set_details', { name: 'יוסי', address: 'הרב קוק 12, מרכז העיר', payment: 'מזומן' });

  assert.ok((await exec(s, 'confirm_order', {})).error, 'no summary yet');
  const sum = await exec(s, 'show_summary', {});
  assert.match(sum.summary_text, /סה"כ: 249₪/); // 2 x 117 + 15 delivery

  await exec(s, 'update_cart', { action: 'set_quantity', line: 1, quantity: 1 });
  assert.ok((await exec(s, 'confirm_order', {})).error, 'cart changed after summary');

  await exec(s, 'show_summary', {});
  const done = await exec(s, 'confirm_order', {});
  assert.equal(done.ok, true);
  assert.equal((await store.orders()).length, 1);
  assert.equal((await store.orders())[0].total, 132);
  assert.equal(store.customer('+972500000009').name, 'יוסי');
});

test('delivery minimum order is enforced', async () => {
  const store = tmpStore();
  const exec = makeExecutor({ menu, business, store, options: { ignoreHours: true } });
  const s = store.session('+972500000010');
  await exec(s, 'set_service', { service: 'delivery' });
  await exec(s, 'add_to_cart', { product_id: idOf('delivery', 'טבעות בצל') });
  await exec(s, 'set_details', { name: 'דנה', address: 'עזה 3 רחביה' });
  assert.match((await exec(s, 'show_summary', {})).error, /מינימום/);
});

test('returning customer: repeat last order', async () => {
  const store = tmpStore();
  const exec = makeExecutor({ menu, business, store, options: { ignoreHours: true } });
  const id = '+972500000011';
  let s = store.session(id);
  await exec(s, 'set_service', { service: 'takeaway' });
  await exec(s, 'add_to_cart', { product_id: idOf('takeaway', 'פיצה גבינה אישית'), quantity: 2 });
  await exec(s, 'set_details', { name: 'מיכל', pickup_time: '20:00' });
  await exec(s, 'show_summary', {});
  await exec(s, 'confirm_order', {});

  s = store.session(id); // done -> new session
  assert.equal(s.cart.length, 0);
  const r = await exec(s, 'repeat_last_order', {});
  assert.equal(r.ok, true);
  assert.equal(s.cart[0].quantity, 2);
  assert.equal(s.details.name, 'מיכל');
});

test('agent loop runs tools and returns the model text (fake LLM)', async () => {
  const store = tmpStore();
  const script = [
    { text: '', toolCalls: [{ name: 'set_service', args: { service: 'takeaway' } }] },
    { text: 'מעולה, איסוף עצמי. מה להכין?', toolCalls: [] },
  ];
  const llm = { name: 'fake', complete: async () => script.shift() };
  const agent = createAgent({ llm, menu, business, store, options: { ignoreHours: true } });
  const r = await agent.answer('+972500000012', 'איסוף בבקשה');
  assert.equal(r.reply, 'מעולה, איסוף עצמי. מה להכין?');
  assert.equal(r.tools[0].name, 'set_service');
  assert.equal(store.session('+972500000012').service, 'takeaway');
});

test('bug fix: extra cheese on an item already in the cart edits that line (no second pizza)', async () => {
  const store = tmpStore();
  const exec = makeExecutor({ menu, business, store, options: { ignoreHours: true } });
  const s = store.session('+972500000020');
  await exec(s, 'set_service', { service: 'takeaway' });
  await exec(s, 'add_to_cart', { product_id: idOf('takeaway', 'פיצת שקשוקה גדולה') });
  const r = await exec(s, 'modify_cart_item', { add: ['Extra Cheese'] });
  assert.ok(!r.error, r.error);
  assert.equal(s.cart.length, 1);
  assert.equal(s.cart[0].total, 115); // 90 + 25
  // cancel the add-on again, and remove an included ingredient
  await exec(s, 'modify_cart_item', { line: 1, remove: ['Extra Cheese', 'פטה'] });
  assert.equal(s.cart[0].total, 90);
  assert.deepEqual(s.cart[0].remove, ['פטה']);
});

test('send_menu: pickup menu when the service is unknown, then the right pages per service', async () => {
  const store = tmpStore();
  const exec = makeExecutor({ menu, business, store, options: { ignoreHours: true } });
  const s = store.session('+972500000021');
  assert.ok(!(await exec(s, 'send_menu', {})).error);
  assert.ok(s.out.images.every((x) => /takeaway/.test(x)));
  s.out.images = [];
  await exec(s, 'set_service', { service: 'delivery' });
  await exec(s, 'send_menu', { section: 'pizza' });
  assert.deepEqual(s.out.images, ['/menu/delivery-1.png', '/menu/delivery-2.png']);
});

test('buttons: size choices, defaults after add/summary, "2" picks the 2nd button', async () => {
  const store = tmpStore();
  const steps = [
    { text: '', toolCalls: [{ name: 'set_service', args: { service: 'delivery' } }, { name: 'add_to_cart', args: { product_id: idOf('delivery', 'פיצה מרגריטה אישית') } }] },
    { text: 'אישית או L?', toolCalls: [] },
    { text: '', toolCalls: [{ name: 'add_to_cart', args: { product_id: idOf('delivery', 'פיצה מרגריטה אישית'), size: 'L 117₪' } }] },
    { text: 'נוספה מרגריטה L. עוד משהו?', toolCalls: [] },
  ];
  const seenUser = [];
  const llm = { name: 'fake', complete: async ({ history }) => { seenUser.push(history.filter((h) => h.role === 'user').pop().text); return steps.shift(); } };
  const agent = createAgent({ llm, menu, business, store, options: { ignoreHours: true } });
  const id = '+972500000022';
  const r1 = await agent.answer(id, 'מרגריטה במשלוח');
  assert.deepEqual(r1.choices.map((x) => x.title), ['אישית 65₪', 'L 117₪']);
  // "2" = the 2nd button → handled by the click flow (no model call), adds the L
  const calls = seenUser.length;
  const r2 = await agent.answer(id, '2');
  assert.equal(seenUser.length, calls);
  assert.equal(store.session(id).cart[0].total, 117);
  assert.ok(r2.choices.some((x) => x.id === 'checkout'));
  assert.ok(r2.choices.some((x) => x.id === 'opts:1:0'), 'extra cheese/remove options offered');
});

test('if the model fails right after confirm_order, the customer still gets the order number', async () => {
  const store = tmpStore();
  const exec = makeExecutor({ menu, business, store, options: { ignoreHours: true } });
  const id = '+972500000023';
  const s = store.session(id);
  await exec(s, 'set_service', { service: 'takeaway' });
  await exec(s, 'add_to_cart', { product_id: idOf('takeaway', 'פיצה גבינה אישית') });
  await exec(s, 'set_details', { name: 'משה', pickup_time: '17:00' });
  await exec(s, 'show_summary', {});
  let n = 0;
  const llm = { name: 'fake', complete: async () => { if (n++ === 0) return { text: '', toolCalls: [{ name: 'confirm_order', args: {} }] }; throw new Error('Gemini 429'); } };
  const agent = createAgent({ llm, menu, business, store, options: { ignoreHours: true } });
  const r = await agent.answer(id, 'כן');
  assert.match(r.reply, /#1001/);
  assert.equal((await store.orders()).length, 1);
});

test('channel rendering: Meta buttons/list/images, Twilio numbered choices', () => {
  process.env.PUBLIC_BASE_URL = 'https://demo.example';
  const { toMetaMessages } = require('../src/channels/meta');
  const { toTwiml } = require('../src/channels/twilio');
  const msgs = toMetaMessages('972500', { reply: 'הנה התפריט', images: ['/menu/takeaway-1.png'], choices: ['🛵 משלוח', '🏃 איסוף עצמי'] });
  assert.equal(msgs[0].image.link, 'https://demo.example/menu/takeaway-1.png');
  assert.equal(msgs[1].interactive.type, 'button');
  const list = toMetaMessages('972500', { reply: 'איזו?', choices: ['א', 'ב', 'ג', 'ד'] });
  assert.equal(list[0].interactive.type, 'list');
  const xml = toTwiml({ reply: 'אישית או L?', choices: ['אישית 55₪', 'L 90₪'] });
  assert.match(xml, /1️⃣ אישית 55₪/);
  delete process.env.PUBLIC_BASE_URL;
});

test('size is shown once: "פיצה גבינה אישית" + size "אישית"', () => {
  const { describeLine } = require('../src/tools');
  const { ticketText } = require('../src/kitchen');
  const line = menu.buildLine('delivery', { product_id: idOf('delivery', 'פיצה גבינה אישית'), size: 'אישית' }).line;
  assert.equal(describeLine(line), 'פיצה גבינה אישית');
  const t = ticketText({ number: 1, service: 'takeaway', customerId: 'x', items: [line], details: { name: 'a' }, total: 59, deliveryFee: 0 });
  assert.match(t, /1 x פיצה גבינה אישית  59₪/);
});

test('gemini client: rate limiter and retry-delay parsing', async () => {
  // load internals through a fresh require with a fake fetch
  const calls = [];
  const realFetch = global.fetch;
  let n = 0;
  global.fetch = async () => {
    calls.push(Date.now());
    if (n++ === 0) return { ok: false, status: 429, text: async () => 'Quota exceeded. Please retry in 0.1s.' };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'שלום' }] } }] }) };
  };
  process.env.GEMINI_RPM = '0';
  const { createGemini } = require('../src/llm/gemini');
  const g = createGemini({ apiKey: 'k', model: 'gemini-3.5-flash-lite' });
  const r = await g.complete({ system: 's', history: [{ role: 'user', text: 'hi' }], tools: [] });
  assert.equal(r.text, 'שלום');
  assert.equal(calls.length, 2);
  assert.ok(calls[1] - calls[0] >= 300, 'waited the server-suggested delay');
  global.fetch = realFetch;
  delete process.env.GEMINI_RPM;
});

// ---------- click-through ordering (no model involved) ----------
const noLLM = { name: 'none', complete: async () => { throw new Error('model must not be called for taps'); } };

test('click order end-to-end: service → category → pizza → size → toppings → checkout → confirm', async () => {
  const store = tmpStore();
  const agent = createAgent({ llm: noLLM, menu, business, store, options: { ignoreHours: true } });
  const id = '+972500000030';
  const tap = async (payload) => agent.answer(id, payload, payload);

  let r = await tap('svc:takeaway');
  assert.ok(r.images.length >= 3, 'menu images sent');
  assert.ok(r.choices.some((x) => x.title.includes('פיצות')));

  r = await tap('cat:0:0');                       // pizzas
  const shak = r.choices.find((x) => x.title.includes('שקשוקה'));
  assert.ok(shak, 'shakshuka in list');
  assert.match(shak.description, /אישית 55₪ · L 90₪/);

  r = await tap(shak.id);                         // size buttons
  const L = r.choices.find((x) => x.title.startsWith('L'));
  r = await tap(L.id);                            // added
  assert.match(r.reply, /נוסף/);
  assert.equal(store.session(id).cart[0].total, 90);

  r = await tap('opts:1:0');                      // toppings list
  const cheese = r.choices.find((x) => /Extra Cheese|גבינה/.test(x.title) && x.title.startsWith('➕'));
  const noFeta = r.choices.find((x) => x.title === '🚫 בלי פטה');
  assert.ok(cheese && noFeta);
  await tap(cheese.id);
  r = await tap(noFeta.id);
  assert.equal(store.session(id).cart.length, 1, 'still one pizza');
  assert.equal(store.session(id).cart[0].total, 115);
  assert.deepEqual(store.session(id).cart[0].remove, ['פטה']);
  assert.ok(r.choices.some((x) => x.title.startsWith('✓')), 'added topping shown as selected');

  r = await tap('checkout');
  assert.match(r.reply, /שם/);                    // details are free text -> model in real life
  const s = store.session(id);
  s.details.name = 'משה'; s.details.pickupTime = '17:00';
  r = await tap('checkout');
  assert.deepEqual(r.choices.map((x) => x.id), ['pay:מזומן', 'pay:אשראי']);
  r = await tap('pay:אשראי');
  assert.match(r.reply, /סה"כ: 115₪/);
  r = await tap('confirm');
  assert.match(r.reply, /✅ הזמנה #1001/);
  assert.equal((await store.orders())[0].total, 115);
});

test('make-your-own pizza asks for the required sauce by buttons', async () => {
  const store = tmpStore();
  const agent = createAgent({ llm: noLLM, menu, business, store, options: { ignoreHours: true } });
  const id = '+972500000031';
  const tap = (p) => agent.answer(id, p, p);
  await tap('svc:takeaway');
  let r = await tap('cat:0:0');
  const myo = r.choices.find((x) => x.title.includes('בהרכבה'));
  r = await tap(myo.id);
  r = await tap(r.choices[0].id);                 // personal
  assert.match(r.reply, /רוטב/);
  r = await tap(r.choices.find((x) => x.title.includes('קלאסי')).id);
  assert.match(r.reply, /נוסף/);
  r = await tap('opts:1:0');                      // all-over toppings available here
  assert.ok(r.choices.some((x) => x.title.includes('פטריות')));
  r = await tap(r.choices.find((x) => x.title.startsWith('עוד')).id);
  assert.ok(r.choices.some((x) => x.title.includes('זיתי קלמטה')), 'second page');
});

test('a tap before choosing delivery/pickup asks for it; "1" picks the first button', async () => {
  const store = tmpStore();
  const agent = createAgent({ llm: noLLM, menu, business, store, options: { ignoreHours: true } });
  const id = '+972500000032';
  let r = await agent.answer(id, '📋 תפריט', 'menu');
  assert.deepEqual(r.choices.map((x) => x.id), ['svc:delivery', 'svc:takeaway']);
  r = await agent.answer(id, '1');
  assert.equal(store.session(id).service, 'delivery');
  assert.ok(r.images.every((p) => p.includes('delivery')));
});

test('the catalog lists every active dish exactly once per service', () => {
  const { buildCatalog } = require('../src/catalog');
  for (const svc of ['delivery', 'takeaway']) {
    const cat = buildCatalog(menu, svc);
    const ids = new Set(cat.flatMap((c) => c.items.flatMap((i) => i.sizes.map((x) => x.product_id))));
    const missing = menu.products[svc].filter((p) => !ids.has(p.id)).map((p) => p.name);
    // delivery has duplicate L listings of pizzas that already appear with an L size — those may be merged away
    assert.ok(missing.every((n) => /פיצ|לבנה|ירקות|גבינות/.test(n)), `${svc} missing: ${missing}`);
  }
});

test('telemetry: one message = one trace with turn.start, tool calls and turn.end', async () => {
  const tel = require('../src/telemetry');
  const store = tmpStore();
  const agent = createAgent({ llm: noLLM, menu, business, store, options: { ignoreHours: true } });
  const r = await agent.answer('+972501234567', '🏃 איסוף עצמי', 'svc:takeaway', { channel: 'test' });
  assert.ok(r.traceId);
  const ev = tel.readEvents({ filter: (e) => e.traceId === r.traceId });
  const types = ev.map((e) => e.type).filter((t) => !/^(conversation|storage)\./.test(t));
  assert.equal(types[0], 'turn.start');
  assert.ok(ev.filter((e) => e.type !== 'storage.ready').every((e) => e.conversationId === r.conversationId), 'every event carries the conversation id');
  assert.equal(types.at(-1), 'turn.end');
  assert.ok(types.includes('tool.call'), 'tool calls logged');
  assert.ok(ev.every((e) => e.channel === 'test'));
  assert.equal(ev[0].customer, '972***567', 'phone masked by default');
  assert.equal(ev.at(-1).path, 'flow');
  assert.ok(tel.snapshot().counters.turns >= 1);
});

test('telemetry: model failures are logged as errors and counted', async () => {
  const tel = require('../src/telemetry');
  const store = tmpStore();
  const failing = { name: 'fail', complete: async () => { throw new Error('Gemini 503: overloaded'); } };
  const agent = createAgent({ llm: failing, menu, business, store, options: { ignoreHours: true } });
  const r = await agent.answer('+972501111111', 'היי', null, { channel: 'test' });
  const ev = tel.readEvents({ filter: (e) => e.traceId === r.traceId });
  assert.ok(ev.some((e) => e.type === 'llm.turn_failed' && e.level === 'error'));
  assert.ok(r.choices.length, 'buttons still offered');
});

test('bug fix: switching delivery → pickup keeps the cart (make-your-own L with sauce + toppings)', async () => {
  const store = tmpStore();
  const agent = createAgent({ llm: noLLM, menu, business, store, options: { ignoreHours: true } });
  const exec = makeExecutor({ menu, business, store, options: { ignoreHours: true } });
  const id = '+972500000040';
  const tap = (p) => agent.answer(id, p, p);
  await tap('svc:delivery');
  let r = await tap('cat:0:0');
  r = await tap(r.choices.find((x) => x.title.includes('בהרכבה')).id);
  r = await tap(r.choices.find((x) => x.title.startsWith('L')).id);
  r = await tap(r.choices.find((x) => x.title.includes('שמנת')).id);
  r = await tap('opts:1:0');
  await tap(r.choices.find((x) => x.title.includes('פלפלים קלויים')).id);
  r = await tap('opts:1:0');
  await tap(r.choices.find((x) => x.title.includes('תירס')).id);
  const s = store.session(id);
  assert.equal(s.cart[0].total, 104); // 87 + 5 + 6 + 6, exactly like the bug report

  const res = await exec(s, 'set_service', { service: 'takeaway' });
  assert.ok(!res.dropped, JSON.stringify(res.dropped));
  assert.equal(s.cart.length, 1);
  const l = s.cart[0];
  assert.equal(l.size, 'L', 'pickup L is its own product, still shown as L');
  assert.deepEqual(l.add.map((a) => a.name).sort(), ['פלפלים קלויים', 'רוטב שמנת', 'תירס'].sort());
  assert.ok(l.total < 104, `pickup is cheaper: ${l.total}`);

  // and back again
  await exec(s, 'set_service', { service: 'delivery' });
  assert.equal(s.cart[0].total, 104);
});

test('switching service keeps every dish in the menu (all pizzas, both sizes)', async () => {
  const store = tmpStore();
  const exec = makeExecutor({ menu, business, store, options: { ignoreHours: true } });
  const { buildCatalog } = require('../src/catalog');
  for (const [from, to] of [['delivery', 'takeaway'], ['takeaway', 'delivery']]) {
    const s = store.session(`+97250000005${from.length}`);
    s.cart = []; s.service = null;
    await exec(s, 'set_service', { service: from });
    for (const cat of buildCatalog(menu, from)) {
      for (const it of cat.items) for (const sz of it.sizes) {
        const r = menu.buildLine(from, { product_id: sz.product_id, size: sz.size, add: /בהרכבה/.test(it.title) ? ['רוטב קלאסי'] : [] });
        if (r.line) s.cart.push(r.line);
      }
    }
    const before = s.cart.length;
    const res = await exec(s, 'set_service', { service: to });
    // only dishes that truly don't exist on the other menu may drop:
    // delivery-only: fries, L grilled-veg white, L French onion · pickup-only: L "ירקות צלוים"
    if ((res.dropped || []).length) assert.match(res.dropped_note, /לא קיימות/);
    assert.ok((res.dropped || []).length <= 4, `${from}→${to}: dropped ${res.dropped}`);
    assert.equal(s.cart.length, before - (res.dropped || []).length);
  }
});

test('model adds a build-your-own pizza → toppings list opens (not just "more/checkout")', async () => {
  const store = tmpStore();
  const byo = menu.products.delivery.find((p) => /בהרכבה/.test(p.name));
  const steps = [
    { text: '', toolCalls: [{ name: 'set_service', args: { service: 'delivery' } }, { name: 'add_to_cart', args: { product_id: byo.id, size: byo.variants[0].label, add: ['רוטב קלאסי'] } }] },
    { text: 'איזה תוספות תרצה על הפיצה?', toolCalls: [] },
  ];
  const llm = { name: 'fake', complete: async () => steps.shift() };
  const agent = createAgent({ llm, menu, business, store, options: { ignoreHours: true } });
  const r = await agent.answer('+972500000061', 'פיצה בהרכבה במשלוח');
  assert.equal(store.session('+972500000061').cart.length, 1);
  assert.ok(r.choices.length > 3, 'a list of toppings');
  assert.ok(r.choices.some((x) => /^opt:1:/.test(x.id)), JSON.stringify(r.choices));
});

test('"בעצם תביא לי תפריט" → menu images + category list, without the model', async () => {
  const store = tmpStore();
  const llm = { name: 'fake', complete: async () => { throw new Error('model should not be called'); } };
  const agent = createAgent({ llm, menu, business, store, options: { ignoreHours: true } });
  const id = '+972500000062';
  await agent.answer(id, '', 'svc:delivery');
  const r = await agent.answer(id, 'בעצם תביא לי תפריט');
  assert.ok(r.images.length >= 1, 'menu images');
  assert.ok(r.choices.some((x) => /^cat:/.test(x.id)), 'category list');
});

test('buttons the model wrote without ids still work when tapped', async () => {
  const store = tmpStore();
  const steps = [
    { text: 'משלוח או איסוף?', toolCalls: [{ name: 'offer_choices', args: { choices: ['🛵 משלוח', '🏃 איסוף עצמי'] } }] },
    { text: 'משלוח או איסוף?', toolCalls: [] },
  ];
  const llm = { name: 'fake', complete: async () => steps.shift() || { text: 'x', toolCalls: [] } };
  const agent = createAgent({ llm, menu, business, store, options: { ignoreHours: true } });
  const id = '+972500000063';
  const r1 = await agent.answer(id, 'היי');
  assert.deepEqual(r1.choices.map((x) => x.id), ['svc:delivery', 'svc:takeaway']);
  await agent.answer(id, '🛵 משלוח', r1.choices[0].id);
  assert.equal(store.session(id).service, 'delivery');
});

test('switching to pickup with a delivery-only dish → alternative offered as a button', async () => {
  const store = tmpStore();
  const exec = makeExecutor({ menu, business, store, options: { ignoreHours: true } });
  const s = store.session('+972500000064');
  await exec(s, 'set_service', { service: 'delivery' });
  const onion = menu.products.delivery.find((p) => /בצל צרפתי גדולה/.test(p.name));
  if (!onion || menu.products.takeaway.some((p) => /בצל צרפתי גדולה/.test(p.name))) return; // owner fixed it in Tabit
  const r0 = menu.buildLine('delivery', { product_id: onion.id });
  s.cart.push(r0.line);
  const res = await exec(s, 'set_service', { service: 'takeaway' });
  assert.equal(res.dropped.length, 1);
  assert.ok(res.choices.some((x) => /^item:/.test(x.id)), JSON.stringify(res.choices));
});

test('ids: customer → conversations → messages; a new conversation after an order; orders link to it', async () => {
  const store = tmpStore();
  const agent = createAgent({ llm: noLLM, menu, business, store, options: { ignoreHours: true } });
  const id = '+972500000071';
  const r1 = await agent.answer(id, '', 'svc:takeaway');
  assert.match(r1.conversationId, /^c-\d{6}-[0-9a-f]{6}$/);
  const r2 = await agent.answer(id, 'תפריט');
  assert.equal(r2.conversationId, r1.conversationId, 'same conversation');
  const msgs = await store.conversation(r1.conversationId);
  assert.deepEqual(msgs.map((m) => m.from), ['customer', 'bot', 'customer', 'bot']);
  assert.equal(msgs[2].text, 'תפריט');
  assert.equal(msgs[2].messageId, r2.traceId, 'message id = trace id (links transcript and logs)');
  // finish an order through the click flow
  const exec = makeExecutor({ menu, business, store, options: { ignoreHours: true } });
  const s = store.session(id);
  await exec(s, 'add_to_cart', { product_id: idOf('takeaway', 'פיצה גבינה אישית') });
  await exec(s, 'set_details', { name: 'דני', pickup_time: '19:00', payment: 'מזומן' });
  await exec(s, 'show_summary', {});
  await agent.answer(id, '', 'confirm');
  const [order] = await store.orders();
  assert.equal(order.conversationId, r1.conversationId);
  const r3 = await agent.answer(id, 'היי שוב', 'menu');
  assert.notEqual(r3.conversationId, r1.conversationId, 'after the order a new conversation starts');
  const list = await store.conversations({ customerId: id });
  assert.deepEqual(list.map((c) => c.conversationId), [r3.conversationId, r1.conversationId]);
});

test('storage survives a restart (file backend): open cart, customer, order counter', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papido-restart-'));
  const a = new Store(dir);
  const exec = makeExecutor({ menu, business, store: a, options: { ignoreHours: true } });
  const s = a.session('+972500000072');
  await exec(s, 'set_service', { service: 'delivery' });
  assert.ok(!(await exec(s, 'add_to_cart', { product_id: idOf('delivery', 'פיצה גבינה אישית'), size: 'אישית' })).error);
  a.saveCustomer('+972500000072', { name: 'רותי' });
  await a.nextOrderNumber();
  await a.persist('+972500000072');
  const b = new Store(dir); // "server restarted"
  await b.load('+972500000072');
  const s2 = b.session('+972500000072');
  assert.equal(s2.conversationId, s.conversationId);
  assert.equal(s2.cart.length, 1);
  assert.equal(b.customer('+972500000072').name, 'רותי');
  assert.equal(await b.nextOrderNumber(), 1002);
});

test('redis backend: speaks the Upstash REST pipeline protocol', async () => {
  const { RedisBackend } = require('../src/storage');
  const db = new Map();
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, auth: opts.headers.Authorization });
    const out = JSON.parse(opts.body).map(([cmd, k, ...a]) => {
      if (cmd === 'GET') return { result: db.has(k) ? db.get(k) : null };
      if (cmd === 'SET') { db.set(k, a[0]); return { result: 'OK' }; }
      if (cmd === 'DEL') { db.delete(k); return { result: 1 }; }
      if (cmd === 'INCR') { const n = Number(db.get(k) || 0) + 1; db.set(k, String(n)); return { result: n }; }
      if (cmd === 'RPUSH') { const l = db.get(k) || []; l.push(a[0]); db.set(k, l); return { result: l.length }; }
      if (cmd === 'LTRIM' || cmd === 'EXPIRE') return { result: 'OK' };
      if (cmd === 'LRANGE') { const l = db.get(k) || []; const s = Number(a[0]); const e = Number(a[1]); return { result: l.slice(s < 0 ? Math.max(0, l.length + s) : s, e < 0 ? l.length + e + 1 : e + 1) }; }
      return { error: 'unknown ' + cmd };
    });
    return { ok: true, json: async () => out };
  };
  const backend = new RedisBackend({ url: 'https://example.upstash.io/', token: 'tkn', fetchImpl });
  const store = new Store(null, { backend });
  const agent = createAgent({ llm: noLLM, menu, business, store, options: { ignoreHours: true } });
  const r = await agent.answer('+972500000073', '', 'svc:delivery');
  assert.equal(calls[0].url, 'https://example.upstash.io/pipeline');
  assert.equal(calls[0].auth, 'Bearer tkn');
  // a different server instance (empty memory) continues the same conversation
  const store2 = new Store(null, { backend });
  await store2.load('+972500000073');
  assert.equal(store2.session('+972500000073').service, 'delivery');
  assert.equal(store2.session('+972500000073').conversationId, r.conversationId);
  assert.equal((await store2.conversation(r.conversationId)).length, 2);
  assert.equal(await store2.nextOrderNumber(), 1001);
});

test('"תפריט" before choosing a service → pickup menu images right away + service buttons; then no repeat images', async () => {
  const store = tmpStore();
  const llm = { name: 'fake', complete: async () => { throw new Error('model should not be called'); } };
  const agent = createAgent({ llm, menu, business, store, options: { ignoreHours: true } });
  const id = '+972500000081';
  const r1 = await agent.answer(id, 'תביא תפריט');
  assert.equal(r1.images.length, 3);
  assert.ok(r1.images.every((x) => /takeaway/.test(x)));
  assert.deepEqual(r1.choices.map((x) => x.id), ['svc:delivery', 'svc:takeaway']);
  const r2 = await agent.answer(id, '', 'svc:delivery');
  assert.equal(r2.images.length, 0, 'menu already shown');
  assert.match(r2.reply, /למשלוח/);
  assert.ok(r2.choices.some((x) => /^cat:/.test(x.id)));
});

test('log shipper: events go to Redis in batches, survive a "restart", and reads are served from memory', async () => {
  const tel = require('../src/telemetry');
  const { RedisBackend } = require('../src/storage');
  const { createLogShipper } = require('../src/log-shipper');
  const lists = new Map();
  let lranges = 0;
  const fetchImpl = async (url, opts) => ({
    ok: true,
    json: async () => JSON.parse(opts.body).map(([cmd, k, ...a]) => {
      const l = lists.get(k) || [];
      if (cmd === 'RPUSH') { l.push(...a); lists.set(k, l); return { result: l.length }; }
      if (cmd === 'LRANGE') { lranges++; const s = Number(a[0]); const e = Number(a[1]); return { result: l.slice(s < 0 ? Math.max(0, l.length + s) : s, e < 0 ? l.length + e + 1 : e + 1) }; }
      return { result: 'OK' };
    }),
  });
  const backend = new RedisBackend({ url: 'https://x.upstash.io', token: 't', fetchImpl });
  const a = createLogShipper(backend, { intervalMs: 60000 });
  tel.withTrace({ customer: '+972509990000', channel: 'test' }, () => tel.log('shipper.test', { n: 1 }));
  await a.flush();
  const key = `logs:${new Date().toISOString().slice(0, 10)}`;
  assert.ok(lists.get(key).some((x) => JSON.parse(x).type === 'shipper.test'), 'event stored in Redis');
  assert.ok(!lists.get(key).some((x) => JSON.parse(x).type === 'storage.call'), 'no feedback loop');
  const before = lranges;
  const got = await a.read({ limit: 50, filter: (e) => e.type === 'shipper.test' });
  assert.equal(got.length, 1);
  assert.equal(lranges, before, 'served from memory');
  // new server instance: preloads today's events from Redis
  const b = createLogShipper(backend, { intervalMs: 60000 });
  const again = await b.read({ limit: 50, filter: (e) => e.type === 'shipper.test' });
  assert.equal(again.length, 1);
});

test('allergy questions get a fixed answer from the knowledge base (never "free of X"), with a team button', async () => {
  const store = tmpStore();
  const llm = { name: 'fake', complete: async () => { throw new Error('model should not be called'); } };
  const agent = createAgent({ llm, menu, business, store, options: { ignoreHours: true } });
  for (const q of ['יש בפיצות ביצים?', 'יש לי אלרגיה לאגוזים, מה בטוח?', 'יש ללא גלוטן?']) {
    const r = await agent.answer(`+97250000009${q.length % 10}`, q);
    assert.equal(r.path, 'flow', q);
    assert.doesNotMatch(r.reply, /ללא ביצ|בלי ביצ|בטוח לך/);
    assert.match(r.reply, /לא יכולים להבטיח/);
    assert.equal(r.choices[0].id, 'handoff:allergy');
  }
  const g = await agent.answer('+972500000099', 'יש ללא גלוטן?');
  assert.match(g.reply, /אין כרגע בצק ללא גלוטן/);
  const h = await agent.answer('+972500000099', '', 'handoff:allergy');
  assert.equal(store.session('+972500000099').status, 'handoff');
  assert.match(h.reply, /צוות/);
});

test('"בלי ביצה" in an order is not treated as an allergy question', async () => {
  const store = tmpStore();
  let called = false;
  const llm = { name: 'fake', complete: async () => { called = true; return { text: 'בסדר', toolCalls: [] }; } };
  const agent = createAgent({ llm, menu, business, store, options: { ignoreHours: true } });
  await agent.answer('+972500000098', 'בלי ביצה בבקשה');
  assert.ok(called);
});

test('model says "אבדוק" without handing off → handed off automatically', async () => {
  const store = tmpStore();
  const llm = { name: 'fake', complete: async () => ({ text: 'אבדוק את זה מול הצוות שלנו 🍕', toolCalls: [] }) };
  const agent = createAgent({ llm, menu, business, store, options: { ignoreHours: true } });
  const r = await agent.answer('+972500000097', 'מקבלים סיבוס?');
  assert.equal(store.session('+972500000097').status, 'handoff');
  assert.ok(r.tools.some((t) => t.name === 'handoff_to_human (auto)'));
  assert.match(r.reply, /יחזרו אליך/);
});

test('proofread: fixes a typo, keeps numbers; rejects a "fix" that changes a price; never blocks on failure', async () => {
  const { proofread } = require('../src/proofread');
  process.env.PROOFREAD = 'on';
  try {
    const fixer = { complete: async () => ({ text: 'על איזה שם לכתוב את ההזמנה, ומזומן או אשראי?', toolCalls: [] }) };
    assert.equal(await proofread(fixer, 'על איזה ששום לכתוב את ההזמנה, ומזומן או אשראי?'), 'על איזה שם לכתוב את ההזמנה, ומזומן או אשראי?');
    const liar = { complete: async () => ({ text: 'פיצה מרגריטה L — 99₪', toolCalls: [] }) };
    assert.equal(await proofread(liar, 'פיצה מרגריטה L — 117₪'), 'פיצה מרגריטה L — 117₪');
    const down = { complete: async () => { throw new Error('Gemini 503'); } };
    assert.equal(await proofread(down, 'הנה התפריט שלנו'), 'הנה התפריט שלנו');
  } finally { process.env.PROOFREAD = 'off'; }
});

test('model adds a pizza → the reply shows dish, size and price from code (not the model wording)', async () => {
  const store = tmpStore();
  const steps = [
    { text: '', toolCalls: [{ name: 'set_service', args: { service: 'delivery' } }, { name: 'add_to_cart', args: { product_id: 'd26', size: 'L' } }, { name: 'add_to_cart', args: { product_id: 'd14', size: 'L' } }] },
    { text: 'הוספתי את שתיהן 🍕 לאן לשלוח?', toolCalls: [] },
  ];
  const llm = { name: 'fake', complete: async () => steps.shift() };
  const agent = createAgent({ llm, menu, business, store, options: { ignoreHours: true } });
  const r = await agent.answer('+972500000101', 'תזמין ארבע גבינות ותרד וגאודה L משלוח');
  assert.match(r.reply, /ארבע גבינות לבנה L — 117₪/);
  assert.match(r.reply, /תרד וגאודה L — 117₪/);
  assert.match(r.reply, /בסל: 234₪/);
  assert.doesNotMatch(r.reply, /לאן לשלוח/);
});

test('the model sees one clean menu line per dish, only for the chosen service', () => {
  const { menuPrompt } = require('../src/prompt');
  const d = menuPrompt(menu, 'delivery');
  assert.equal((d.match(/ארבע גבינות לבנה/g) || []).length, 1, 'no Tabit duplicate');
  assert.match(d, /\nארבע גבינות לבנה \| אישית 72₪ \/ L 117₪/);
  assert.doesNotMatch(d, /\b[dt]\d+\b/, 'no ids at all — the model names dishes, the code finds them');
  assert.match(menuPrompt(menu, null), /פיצה מרגריטה \| אישית 50₪ \/ 65₪ · L 85₪ \/ 117₪/);
});

test('a button from a closed conversation does not act on an empty cart', async () => {
  const store = tmpStore();
  const agent = createAgent({ llm: noLLM, menu, business, store, options: { ignoreHours: true } });
  const id = '+972500000102';
  store.saveCustomer(id, { name: 'קרל', lastOrder: { service: 'delivery', items: [menu.buildLine('delivery', { product_id: 'd51' }).line], at: new Date().toISOString() } });
  const r = await agent.answer(id, '⚙️ תוספות / שינויים', 'opts:2:0');
  assert.match(r.reply, /ההזמנה הקודמת כבר נסגרה/);
  assert.deepEqual(r.choices.map((x) => x.id), ['repeat', 'menu']);
  const r2 = await agent.answer(id, '', 'repeat');
  assert.equal(store.session(id).cart.length, 1);
  assert.match(r2.reply, /זפולי/);
});

test('dish by name: exact words win, ambiguous names become buttons, missing size becomes buttons', async () => {
  const store = tmpStore();
  const exec = makeExecutor({ menu, business, store, options: { ignoreHours: true } });
  const s = store.session('+972500000111');
  await exec(s, 'set_service', { service: 'delivery' });
  // the live bug: "תרד וגאודה L" must not become "תרד לבנה"
  let r = await exec(s, 'add_to_cart', { name: 'תרד וגאודה', size: 'L' });
  assert.equal(r.added, 'פיצה תרד וגאודה L — 117₪');
  r = await exec(s, 'add_to_cart', { name: 'ארבע גבינות', size: 'גדולה' });
  assert.match(r.added, /ארבע גבינות לבנה L — 117₪/);
  r = await exec(s, 'add_to_cart', { name: 'תרד', size: 'L' });
  assert.ok(r.error && r.choices.length >= 2, 'two dishes have תרד → customer picks');
  assert.ok(r.choices.every((c) => /^item:\d+:\d+$/.test(c.id)));
  r = await exec(s, 'add_to_cart', { name: 'פיצה מרגריטה' });
  assert.ok(r.error && r.choices.map((c) => c.title).join() === 'אישית 65₪,L 117₪', 'no size given → size buttons');
  r = await exec(s, 'add_to_cart', { name: 'פיצה פפרוני', size: 'L' });
  assert.match(r.error, /לא מצאתי/);
  r = await exec(s, 'add_to_cart', { name: 'זפולי' });
  assert.equal(r.added, 'זפולי — 8₪');
  assert.equal(s.cart.length, 3);
});

test('after the model adds a dish it does not jump to address/payment before the customer is done', async () => {
  const store = tmpStore();
  const steps = [
    { text: '', toolCalls: [{ name: 'set_service', args: { service: 'delivery' } }, { name: 'add_to_cart', args: { name: 'מרגריטה', size: 'L' } }] },
    { text: 'לאן לשלוח (רחוב, מספר)? על איזה שם? מזומן או אשראי?', toolCalls: [] },
  ];
  const agent = createAgent({ llm: { name: 'fake', complete: async () => steps.shift() }, menu, business, store, options: { ignoreHours: true } });
  const r = await agent.answer('+972500000112', 'מרגריטה L משלוח');
  assert.equal(r.reply, '✓ נוסף: פיצה מרגריטה L — 117₪');
  assert.ok(r.choices.some((c) => c.id === 'checkout'));
});

test('timeline: one readable line per action — customer, routing, model request, model decision, tool, reply', async () => {
  const tel = require('../src/telemetry');
  const { timeline } = require('../src/timeline');
  const store = tmpStore();
  const script = [
    { text: '', toolCalls: [{ name: 'set_service', args: { service: 'takeaway' } }] },
    { text: 'מעולה, איסוף עצמי. מה להכין?', toolCalls: [] },
  ];
  const llm = { name: 'fake', complete: async () => script.shift() };
  const agent = createAgent({ llm, menu, business, store, options: { ignoreHours: true } });
  const r = await agent.answer('+972500000077', 'איסוף בבקשה');
  const rows = timeline(tel.readEvents({ filter: (e) => e.traceId === r.traceId }));
  const types = rows.map((x) => x.type);
  for (const t of ['turn.start', 'agent.route', 'llm.request', 'tool.call', 'reply.compose', 'turn.end']) assert.ok(types.includes(t), `missing ${t}: ${types}`);
  assert.match(rows.find((x) => x.type === 'turn.start').text, /איסוף בבקשה/);
  assert.match(rows.find((x) => x.type === 'tool.call').text, /set_service\(service=takeaway\)/);
  assert.match(rows.find((x) => x.type === 'llm.request').text, /סוג הזמנה/);
  assert.match(rows.find((x) => x.type === 'turn.end').text, /מה להכין/);
  assert.ok(rows.every((x) => x.icon && x.who && x.text));
  // a real model call line shows the tools it chose, with arguments
  const { describe } = require('../src/timeline');
  assert.match(describe({ type: 'llm.call', purpose: 'turn', ms: 4200, calls: [{ name: 'add_to_cart', args: { name: 'מרגריטה', size: 'L' } }] }).text, /add_to_cart\(name=מרגריטה, size=L\)/);
});

test('timeline: background noise (health checks) hidden unless asked', () => {
  const { timeline } = require('../src/timeline');
  const ev = [{ ts: 'x', level: 'debug', type: 'http.request', method: 'GET', path: '/healthz', status: 200, ms: 1 }];
  assert.equal(timeline(ev).length, 0);
  assert.equal(timeline(ev, { noise: true }).length, 1);
});
