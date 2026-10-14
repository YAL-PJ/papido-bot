// tools.js — the actions the model can take. All state changes and all arithmetic happen here.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { SERVICES, norm, canonicalOption } = require('./menu');
const { notifyKitchen } = require('./kitchen');
const tel = require('./telemetry');
const { equivalentLine, alternativesFor } = require('./catalog');

const declarations = [
  {
    name: 'set_service',
    description: 'קובע אם ההזמנה במשלוח או באיסוף עצמי. חובה לפני הוספת מנות — המחירים שונים.',
    parameters: { type: 'object', properties: { service: { type: 'string', enum: ['delivery', 'takeaway'] } }, required: ['service'] },
  },
  {
    name: 'get_item_details',
    description: 'פרטי מנה: גדלים, מחירים, תוספות ושינויים אפשריים. להשתמש כשהלקוח שואל על תוספות או לפני הוספת מנה עם תוספות.',
    parameters: { type: 'object', properties: { product_id: { type: 'string' } }, required: ['product_id'] },
  },
  {
    name: 'add_to_cart',
    description: 'מוסיף מנה לסל. product_id מהתפריט. size רק אם יש כמה גדלים ("אישית"/"L"). add = תוספות, remove = רכיבים להוריד. בפיצה בהרכבה: חובה רוטב (למשל "רוטב קלאסי"), ותוספת לחצי: "חצי ימין: זיתי קלמטה".',
    parameters: {
      type: 'object',
      properties: {
        product_id: { type: 'string' },
        size: { type: 'string' },
        quantity: { type: 'integer' },
        add: { type: 'array', items: { type: 'string' } },
        remove: { type: 'array', items: { type: 'string' } },
        note: { type: 'string', description: 'בקשה מיוחדת שאינה תוספת, למשל "חתוכה ל-8"' },
      },
      required: ['product_id'],
    },
  },
  {
    name: 'modify_cart_item',
    description: 'משנה מנה שכבר בסל: מוסיף/מוריד תוספות, משנה גודל, כמות או הערה. להשתמש כשהלקוח מבקש שינוי למנה שכבר הוזמנה ("עם תוספת גבינה", "בעצם בלי בצל"). לא להוסיף מנה חדשה במקרה כזה.',
    parameters: {
      type: 'object',
      properties: {
        line: { type: 'integer', description: 'מספר השורה בסל (מ-1). אם לא ידוע — השורה האחרונה.' },
        add: { type: 'array', items: { type: 'string' } },
        remove: { type: 'array', items: { type: 'string' }, description: 'רכיב כלול להוריד, או תוספת שהוספה קודם ועכשיו לא רוצים' },
        size: { type: 'string' },
        quantity: { type: 'integer' },
        note: { type: 'string' },
      },
    },
  },
  {
    name: 'send_menu',
    description: 'שולח ללקוח את התפריט כתמונות מסודרות (פיצות + ראשונות/פסטות/סלטים) עם מחירים. להשתמש כשהלקוח שואל "מה יש" / "תפריט" / "אילו פיצות". דורש שסוג ההזמנה ידוע.',
    parameters: {
      type: 'object',
      properties: { section: { type: 'string', enum: ['all', 'pizza', 'other'], description: 'pizza = עמודי הפיצות, other = ראשונות/פסטות/סלטים' } },
    },
  },
  {
    name: 'show_list',
    description: 'מציג ללקוח רשימה לחיצה מהתפריט: בלי category = רשימת קטגוריות; עם category = המנות בקטגוריה (לחיצה על מנה מובילה לבחירת גודל ותוספות). להשתמש כשהלקוח אומר "פיצה" / "מה יש בסלטים" / מתלבט.',
    parameters: { type: 'object', properties: { category: { type: 'string', description: 'למשל "פיצות", "פיצות לבנות", "ראשונות", "פסטות", "סלטים", "מתוק"' } } },
  },
  {
    name: 'offer_choices',
    description: 'מציג ללקוח כפתורי בחירה מתחת להודעה. עד 3 אפשרויות = כפתורים, 4-10 = רשימה. טקסט קצר (עד 20 תווים). הלקוח יכול עדיין לכתוב חופשי.',
    parameters: {
      type: 'object',
      properties: { choices: { type: 'array', items: { type: 'string' } }, list_title: { type: 'string', description: 'כותרת לכפתור הרשימה (4+ אפשרויות), למשל "בחירת פיצה"' } },
      required: ['choices'],
    },
  },
  {
    name: 'update_cart',
    description: 'עדכון הסל: remove = מחיקת שורה, set_quantity = שינוי כמות, clear = ריקון. line = מספר השורה (מ-1).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['remove', 'set_quantity', 'clear'] },
        line: { type: 'integer' },
        quantity: { type: 'integer' },
      },
      required: ['action'],
    },
  },
  {
    name: 'check_delivery_area',
    description: 'בודק אם מגיעים לכתובת/שכונה ומה דמי המשלוח.',
    parameters: { type: 'object', properties: { address: { type: 'string' } }, required: ['address'] },
  },
  {
    name: 'set_details',
    description: 'שומר פרטי לקוח להזמנה. משלוח: name + address (רחוב, מספר, שכונה, קומה/דירה). איסוף: name + pickup_time ("בהקדם" או שעה). payment: "מזומן" או "אשראי".',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        address: { type: 'string' },
        pickup_time: { type: 'string' },
        payment: { type: 'string' },
        notes: { type: 'string' },
      },
    },
  },
  {
    name: 'show_summary',
    description: 'מחזיר סיכום הזמנה מלא עם מחיר סופי. חובה להציג אותו ללקוח מילה במילה ולשאול "לאשר?" לפני confirm_order.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'confirm_order',
    description: 'שולח את ההזמנה למטבח. רק אחרי show_summary ורק אחרי שהלקוח אישר במפורש.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'repeat_last_order',
    description: 'מכניס לסל את ההזמנה הקודמת של לקוח חוזר (אחרי שהוא אמר שהוא רוצה אותה שוב).',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'handoff_to_human',
    description: 'מעביר את השיחה לצוות: תלונה, הזמנה שמאחרת, אירוע/הזמנה גדולה, אלרגיה חמורה, לקוח מבקש בן אדם, או כל דבר שלא יודעים.',
    parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
  },
];

const round = (n) => Math.round(n * 100) / 100;

function totals(session, business) {
  const subtotal = round(session.cart.reduce((s, l) => s + l.total, 0));
  const fee = session.service === 'delivery' ? session.details.deliveryFee || 0 : 0;
  const min = session.service === 'delivery' ? business.data.delivery.minOrder : 0;
  return { subtotal, fee, total: round(subtotal + fee), minOrder: min, belowMin: subtotal < min };
}

function cartView(session, business) {
  const t = totals(session, business);
  return {
    service: session.service ? SERVICES[session.service] : null,
    lines: session.cart.map((l, i) => `${i + 1}. ${describeLine(l)} — ${l.total}₪`),
    subtotal: t.subtotal,
    ...(t.belowMin ? { warning: `מתחת למינימום משלוח (${t.minOrder}₪). חסר ${round(t.minOrder - t.subtotal)}₪.` } : {}),
  };
}

// name + size, without repeating the size when the name already says it
function itemTitle(l) {
  if (!l.size) return l.name;
  const stripped = l.name.replace(/\s*(אישית|גדולה)$/, '');
  return `${stripped} ${l.size}`;
}

function describeLine(l) {
  const parts = [`${l.quantity > 1 ? `${l.quantity} x ` : ''}${itemTitle(l)}`];
  if (l.add.length) parts.push(`+ ${l.add.map((a) => (/חצי/.test(a.group) ? `${a.name} (${a.group})` : a.name)).join(', ')}`);
  if (l.remove.length) parts.push(`בלי ${l.remove.join(', ')}`);
  if (l.note) parts.push(`(${l.note})`);
  return parts.join(' ');
}

const cartHash = (s) => crypto.createHash('sha1').update(JSON.stringify([s.service, s.cart, s.details])).digest('hex');

function makeExecutor({ menu, business, store, options = {} }) {
  const ignoreHours = options.ignoreHours ?? process.env.DEMO_IGNORE_HOURS !== 'false';

  // same dish, size, add-ons and removals — in another price list (or the same one, to re-validate)
  function moveLine(l, from, to) {
    const target = from === to ? { product_id: l.product_id, size: l.size } : equivalentLine(menu, l, from, to);
    if (!target) return { error: 'לא קיימת ב' + SERVICES[to] };
    const r = menu.buildLine(to, {
      product_id: target.product_id, size: target.size, quantity: l.quantity,
      add: l.add.map((a) => `${a.group}: ${a.name}`), remove: l.remove, note: l.note,
    });
    return r.line ? { line: r.line } : { error: r.error };
  }

  const handlers = {
    set_service(s, { service }) {
      if (!SERVICES[service]) return { error: 'service חייב להיות delivery או takeaway' };
      if (s.service === service) return { ok: true, service: SERVICES[service] };
      const moved = [];
      const dropped = [];
      const changes = [];
      const alternatives = [];
      // Re-map every cart line to the same dish + size in the other price list
      for (const l of s.cart) {
        const r = moveLine(l, s.service, service);
        if (r.line) {
          moved.push(r.line);
          if (r.line.total !== l.total) changes.push(`${describeLine(r.line)}: ${l.total}₪ → ${r.line.total}₪`);
        } else {
          dropped.push(describeLine(l));
          for (const alt of alternativesFor(menu, l, s.service, service)) {
            alternatives.push({ id: `item:${alt.catIndex}:${alt.itemIndex}`, title: `➕ ${alt.title}`, description: alt.prices });
          }
        }
      }
      if (dropped.length) tel.log('cart.move_dropped', { from: s.service, to: service, dropped }, 'warn');
      s.service = service;
      s.cart = moved;
      if (service === 'takeaway') Object.assign(s.details, { address: null, zone: null, deliveryFee: 0 });
      return {
        ok: true, service: SERVICES[service],
        note: `${dropped.length ? (moved.length ? 'שאר המנות נשארו בסל' : 'הסל ריק עכשיו') : 'כל המנות נשארו בסל'}${changes.length ? ', המחירים עודכנו לפי סוג ההזמנה' : ''}. ספר ללקוח בקצרה.`,
        ...(changes.length ? { price_changes: changes } : {}),
        ...(dropped.length ? {
          dropped,
          dropped_note: `המנות האלה לא קיימות בתפריט ה${SERVICES[service]} (כך מוגדר בטאביט). ${alternatives.length ? 'הצע את החלופות (מוצגות ככפתורים).' : 'הצע לבחור משהו אחר.'}`,
        } : {}),
        ...(alternatives.length ? { choices: [...alternatives.slice(0, 2), { id: 'cart', title: '🛒 הסל' }] } : {}),
        cart: cartView(s, business),
      };
    },

    get_item_details(s, { product_id }) {
      if (!s.service) return { error: 'קודם צריך לדעת אם משלוח או איסוף (set_service).' };
      return menu.details(s.service, product_id);
    },

    add_to_cart(s, args) {
      if (!s.service) return { error: 'קודם צריך לדעת אם משלוח או איסוף (set_service).' };
      const r = menu.buildLine(s.service, args);
      if (r.error) return r;
      s.cart.push(r.line);
      return { added: `${describeLine(r.line)} — ${r.line.total}₪`, cart: cartView(s, business) };
    },

    modify_cart_item(s, args) {
      if (!s.cart.length) return { error: 'הסל ריק — השתמש ב-add_to_cart.' };
      const i = args.line ? args.line - 1 : s.cart.length - 1;
      const l = s.cart[i];
      if (!l) return { error: `אין שורה ${args.line}. בסל ${s.cart.length} שורות.` };
      const asSpec = (a) => (/חצי/.test(a.group) ? `${a.group}: ${a.name}` : a.name);
      args.remove = (args.remove || []).map(canonicalOption);
      const removeSet = args.remove.map(norm);
      // a "remove" that matches an add-on cancels the add-on; otherwise it removes an included ingredient
      const keptAdds = l.add.filter((a) => !removeSet.some((r) => norm(a.name).includes(r) || r.includes(norm(a.name))));
      const cancelled = l.add.length - keptAdds.length;
      const removeIngredients = (args.remove || []).filter((r) => !l.add.some((a) => norm(a.name).includes(norm(r)) || norm(r).includes(norm(a.name))));
      const r = menu.buildLine(s.service, {
        product_id: l.product_id,
        size: args.size || l.size,
        quantity: args.quantity || l.quantity,
        add: [...keptAdds.map(asSpec), ...(args.add || [])],
        remove: [...new Set([...l.remove, ...removeIngredients])],
        note: args.note ?? l.note,
      });
      if (r.error) return r;
      s.cart[i] = r.line;
      return { updated: `${describeLine(r.line)} — ${r.line.total}₪`, ...(cancelled ? { cancelled_addons: cancelled } : {}), cart: cartView(s, business) };
    },

    send_menu(s, { section = 'all' }) {
      if (!s.service) {
        return { error: 'סוג ההזמנה לא ידוע והמחירים שונים. שאל "משלוח או איסוף?" עם offer_choices ושלח תפריט מיד אחרי התשובה.' };
      }
      const pages = { pizza: [1, 2], other: [3], all: [1, 2, 3] }[section] || [1, 2, 3];
      const images = pages
        .map((n) => `/menu/${s.service}-${n}.png`)
        .filter((p) => fs.existsSync(path.join(__dirname, '..', 'public', p)));
      s.out.images.push(...(images.length ? images : []));
      s.out.links.push(`/menu/${s.service}`); // the full printable document, alongside the images
      return { sent: images.length ? `${images.length} תמונות תפריט` : 'קישור לתפריט', note: 'הלקוח רואה את התפריט. כתוב שורה קצרה אחת ("הנה התפריט 👆 מה להכין?") בלי לפרט את המנות.' };
    },

    offer_choices(s, { choices = [], list_title }) {
      const clean = choices.map((c) => String(c).trim()).filter(Boolean).slice(0, 10);
      if (!clean.length) return { error: 'אין אפשרויות' };
      s.out.choices = clean;
      s.out.listTitle = list_title || null;
      return { ok: true, shown_as: clean.length <= 3 ? 'buttons' : 'list' };
    },

    update_cart(s, { action, line, quantity }) {
      if (action === 'clear') { s.cart = []; return { ok: true, cart: cartView(s, business) }; }
      const i = (line || 0) - 1;
      if (i < 0 || i >= s.cart.length) return { error: `אין שורה ${line}. בסל ${s.cart.length} שורות.` };
      if (action === 'remove') s.cart.splice(i, 1);
      if (action === 'set_quantity') {
        const q = Math.max(1, parseInt(quantity, 10) || 1);
        const l = s.cart[i];
        l.quantity = q;
        l.total = round(l.unitPrice * q);
      }
      return { ok: true, cart: cartView(s, business) };
    },

    check_delivery_area(s, { address }) {
      const z = business.zoneFor(address);
      if (z.error) return { ...z, areas: business.data.delivery.zones.flatMap((x) => x.areas) };
      return { delivers: true, ...z, minOrder: business.data.delivery.minOrder, eta: business.data.delivery.etaMinutes };
    },

    set_details(s, args) {
      const d = s.details;
      for (const k of ['name', 'pickup_time', 'payment', 'notes']) {
        if (args[k]) d[k === 'pickup_time' ? 'pickupTime' : k] = args[k];
      }
      if (args.address) {
        const z = business.zoneFor(args.address);
        if (z.error) return { error: `${z.error} (הכתובת לא נשמרה)` };
        Object.assign(d, { address: args.address, zone: z.zone, deliveryFee: z.fee });
      }
      const missing = [];
      if (!d.name) missing.push('שם');
      if (s.service === 'delivery' && !d.address) missing.push('כתובת מלאה');
      return { ok: true, saved: d, ...(missing.length ? { missing } : { ready_for_summary: true }) };
    },

    show_summary(s) {
      const problems = [];
      if (!s.service) problems.push('לא נבחר משלוח/איסוף');
      if (!s.cart.length) problems.push('הסל ריק');
      if (!s.details.name) problems.push('חסר שם');
      if (s.service === 'delivery' && !s.details.address) problems.push('חסרה כתובת');
      const t = totals(s, business);
      if (t.belowMin) problems.push(`מתחת למינימום משלוח ${t.minOrder}₪ (כרגע ${t.subtotal}₪)`);
      if (problems.length) return { error: problems.join(', ') };

      s.summaryHash = cartHash(s);
      const d = s.details;
      const text = [
        `*סיכום הזמנה — ${SERVICES[s.service]}*`,
        ...s.cart.map((l) => `• ${describeLine(l)} — ${l.total}₪`),
        s.service === 'delivery' ? `• משלוח (${d.zone}) — ${t.fee}₪` : null,
        `*סה"כ: ${t.total}₪*`,
        s.service === 'delivery' ? `📍 ${d.address}` : `🕒 איסוף: ${d.pickupTime || 'בהקדם'}`,
        `👤 ${d.name}${d.payment ? ` | 💳 ${d.payment}` : ''}`,
        d.notes ? `📝 ${d.notes}` : null,
      ].filter(Boolean).join('\n');
      return { summary_text: text, instruction: 'הצג את summary_text כמו שהוא ושאל "לאשר?"' };
    },

    async confirm_order(s) {
      if (!s.summaryHash || s.summaryHash !== cartHash(s)) return { error: 'ההזמנה השתנתה או שלא הוצג סיכום. קרא ל-show_summary והצג ללקוח לפני אישור.' };
      const st = business.status();
      if (!st.acceptingOrders && !ignoreHours) {
        return { error: `סגור כרגע (${st.now}). נפתח ${st.nextOpening || ''}. אפשר לרשום הזמנה מראש בהערות לשעת הפתיחה — לתאם עם הצוות.` };
      }
      const t = totals(s, business);
      const order = {
        number: await store.nextOrderNumber(),
        conversationId: s.conversationId,
        createdAt: new Date().toISOString(),
        customerId: s.customerId,
        service: s.service,
        items: s.cart,
        details: s.details,
        subtotal: t.subtotal,
        deliveryFee: t.fee,
        total: t.total,
        status: 'new',
      };
      store.saveOrder(order);
      const k = await notifyKitchen(order);
      store.saveCustomer(s.customerId, {
        name: s.details.name,
        address: s.details.address || store.customer(s.customerId)?.address || null,
        lastOrder: { service: s.service, items: s.cart, at: order.createdAt },
        ordersCount: (store.customer(s.customerId)?.ordersCount || 0) + 1,
      });
      s.status = 'done';
      const eta = s.service === 'delivery' ? business.data.delivery.etaMinutes : business.data.pickup.readyMinutes;
      return {
        ok: true,
        order_number: order.number,
        eta_minutes: eta,
        kitchen: k.channel,
        ...(ignoreHours && !st.acceptingOrders ? { demo_note: 'מצב דמו: שעות הפתיחה לא נאכפו' } : {}),
      };
    },

    repeat_last_order(s) {
      const c = store.customer(s.customerId);
      if (!c?.lastOrder) return { error: 'אין הזמנה קודמת ללקוח הזה.' };
      if (!s.service) s.service = c.lastOrder.service;
      const failed = [];
      for (const l of c.lastOrder.items) {
        const r = moveLine(l, c.lastOrder.service, s.service);
        if (r.line) s.cart.push(r.line); else failed.push(l.name);
      }
      if (c.name && !s.details.name) s.details.name = c.name;
      if (s.service === 'delivery' && c.address && !s.details.address) handlers.set_details(s, { address: c.address });
      return { ok: true, service: SERVICES[s.service], cart: cartView(s, business), ...(failed.length ? { not_available_anymore: failed } : {}), saved_address: s.details.address };
    },

    handoff_to_human(s, { reason }) {
      s.status = 'handoff';
      tel.count('handoffs');
      tel.log('handoff', { reason, cart: s.cart.length }, 'warn');
      // PLACEHOLDER: notify staff (Telegram / WhatsApp to manager) and pause the bot for this customer.
      return { ok: true, message_for_customer: `מעביר לצוות של פפידו, יחזרו אליך כאן בהקדם. אפשר גם להתקשר: ${business.data.contact.phone}` };
    },
  };

  return async function execute(session, name, args, { source = 'llm' } = {}) {
    const h = handlers[name];
    tel.count(`tool.${name}`);
    if (!h) {
      tel.log('tool.unknown', { name, args, source }, 'warn');
      return { error: `כלי לא מוכר: ${name}` };
    }
    const t0 = Date.now();
    try {
      const result = await h(session, args || {});
      const ms = Date.now() - t0;
      tel.timing('tool', ms);
      // a tool returning {error} is normal flow (e.g. "size missing"), logged at info so it's easy to find
      tel.log('tool.call', { name, source, args, ms, ok: !result?.error, result: tel.truncate(result, 1500) }, result?.error ? 'info' : 'debug');
      return result;
    } catch (e) {
      tel.log('tool.exception', { name, source, args, ms: Date.now() - t0, message: e.message, stack: e.stack?.split('\n').slice(0, 5).join(' | ') }, 'error');
      return { error: 'תקלה פנימית. העבר לצוות.' };
    }
  };
}

module.exports = { declarations, makeExecutor, totals, describeLine, itemTitle };
