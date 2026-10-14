// flow.js — click-through ordering. Button/list taps arrive as a payload (e.g. "item:0:3") and are
// handled here deterministically, without the language model: fast, free, and always correct.
// Free text still goes to the model (agent.js), which sees the same session state.

const { SERVICES } = require('./menu');
const { priceText, catalogsFor } = require('./catalog');
const { describeLine, itemTitle } = require('./tools');

const PAGE = 8; // list rows per page (WhatsApp lists allow 10: 8 + "more" + "done/back")
const c = (id, title, description) => ({ id, title, ...(description ? { description } : {}) });

function createFlow({ menu, business, store, execute: rawExecute }) {
  const execute = (s, name, args) => rawExecute(s, name, args, { source: 'flow' });
  const catalogs = catalogsFor(menu); // same object tools.js uses, so list indexes always agree

  const serviceChoices = () => [c('svc:delivery', '🛵 משלוח'), c('svc:takeaway', '🏃 איסוף עצמי')];
  const afterAddChoices = (n, hasOptions) => [
    ...(hasOptions ? [c(`opts:${n}:0`, '⚙️ תוספות / שינויים')] : []),
    c('cats', '➕ עוד מנה'),
    c('checkout', '✔️ לסיום ההזמנה'),
  ];

  function variantOf(service, line) {
    const p = menu.get(service, line.product_id);
    if (!p) return null;
    return p.variants.find((v) => v.label === line.size) || p.variants[0];
  }

  // options a customer can toggle on a cart line (no required groups, no half-pizza groups)
  function optionRows(service, line) {
    const v = variantOf(service, line);
    if (!v) return [];
    const rows = [];
    v.groups.forEach((g, gi) => {
      if ((g.min || 0) >= 1 || /חצי/.test(g.group)) return;
      g.options.forEach((o, oi) => {
        const added = line.add.some((a) => a.name === o.name && a.group === g.group);
        const removed = line.remove.includes(o.name);
        const title = o.type === 'remove'
          ? (removed ? `↩️ להחזיר ${o.name}` : `🚫 בלי ${o.name}`)
          : (added ? `✓ ${o.name}` : `➕ ${o.name}`);
        const description = o.type === 'remove'
          ? (removed ? 'הוסר מהמנה' : 'כלול במנה')
          : (added ? `נוסף · ${o.price}₪ · לחיצה מסירה` : `${o.price ? `+${o.price}₪` : 'ללא תוספת מחיר'}`);
        rows.push({ gi, oi, ...c(null, title, description) });
      });
    });
    return rows;
  }

  function categoriesReply(service, intro) {
    const cats = catalogs[service];
    return {
      reply: intro || 'מה תרצו? בחרו קטגוריה, או פשוט כתבו לי 🍕',
      choices: cats.map((cat, i) => c(`cat:${i}:0`, `${cat.emoji} ${cat.title}`, (cat.items.length === 1 ? "מנה אחת" : `${cat.items.length} מנות`))),
      listTitle: 'תפריט',
    };
  }

  function itemsReply(service, ci, page) {
    const cat = catalogs[service][ci];
    if (!cat) return categoriesReply(service);
    const per = cat.items.length <= PAGE + 1 ? PAGE + 1 : PAGE; // 9 fit without paging (9 + back = 10 rows)
    const start = page * per;
    const slice = cat.items.slice(start, start + per);
    const choices = slice.map((it, k) => c(`item:${ci}:${start + k}`, it.title, priceText(it)));
    if (start + per < cat.items.length) choices.push(c(`cat:${ci}:${page + 1}`, 'עוד ›', `${cat.items.length - start - per} מנות נוספות`));
    choices.push(c('cats', '‹ קטגוריות'));
    return { reply: `${cat.emoji} ${cat.title} — מה להכין?`, choices, listTitle: cat.title };
  }

  // what to show right after line n was added (by a tap or by the model)
  function afterAdd(s, n) {
    const line = s.cart[n - 1];
    if (!line) return cartReply(s);
    const v = variantOf(s.service, line);
    const buildYourOwn = v && v.groups.some((g) => /על הכל/.test(g.group));
    if (buildYourOwn) {
      // toppings are the whole point of this pizza — open the list right away
      const o = optionsReply(s, n, 0);
      return { ...o, reply: `✓ נוסף: ${describeLine(line)} — ${line.total}₪\nעכשיו תוספות — כל לחיצה מוסיפה (אפשר כמה):` };
    }
    const hasOptions = optionRows(s.service, line).length > 0;
    return {
      reply: `✓ נוסף: ${describeLine(line)} — ${line.total}₪${hasOptions ? '\nרוצים תוספות או שינויים?' : ''}`,
      choices: afterAddChoices(n, hasOptions),
    };
  }

  async function addLine(s, sizeEntry, addSpecs = []) {
    const r = await execute(s, 'add_to_cart', { product_id: sizeEntry.product_id, size: sizeEntry.size, add: addSpecs });
    if (r.error) return { reply: `לא הצלחתי להוסיף: ${r.error}`, choices: r.choices || [c('cats', '‹ לתפריט')] };
    return afterAdd(s, s.cart.length);
  }

  // a dish by product id (+ size): ask the required option first if there is one, else add it
  function productStep(s, productId, size, title) {
    const p = menu.get(s.service, productId);
    if (!p) return categoriesReply(s.service, 'המנה הזו לא קיימת בתפריט הזה. מה להכין?');
    const v = p.variants.find((x) => x.label === size) || p.variants[0];
    const gi = v.groups.findIndex((g) => (g.min || 0) >= 1);
    if (gi >= 0) {
      const g = v.groups[gi];
      return {
        reply: `${title || p.name}${v.label ? ` ${v.label}` : ''} — ${g.group}:`,
        choices: g.options.slice(0, 10).map((o, oi) => c(`pr:${p.id}:${v.label || '-'}:${gi}:${oi}`, `${o.name}${o.price ? ` +${o.price}₪` : ''}`)),
      };
    }
    return addLine(s, { product_id: p.id, size: v.label });
  }

  function optionsReply(s, n, page) {
    const line = s.cart[n - 1];
    if (!line) return cartReply(s);
    const rows = optionRows(s.service, line);
    const per = rows.length <= PAGE + 1 ? PAGE + 1 : PAGE;
    const start = page * per;
    const choices = rows.slice(start, start + per).map((r) => c(`opt:${n}:${r.gi}:${r.oi}:${page}`, r.title, r.description));
    if (start + per < rows.length) choices.push(c(`opts:${n}:${page + 1}`, 'עוד אפשרויות ›'));
    else if (page > 0) choices.push(c(`opts:${n}:0`, '‹ חזרה'));
    choices.push(c(`done:${n}`, '✔️ סיימתי'));
    return {
      reply: `${itemTitle(line)} — ${line.total}₪\nבחרו תוספת/שינוי (כל לחיצה מוסיפה או מבטלת):`,
      choices,
      listTitle: 'תוספות ושינויים',
    };
  }

  function toggleOption(s, n, gi, oi) {
    const line = s.cart[n - 1];
    const v = line && variantOf(s.service, line);
    const g = v && v.groups[gi];
    const o = g && g.options[oi];
    if (!o) return { error: 'האפשרות לא נמצאה' };
    let add = line.add.map((a) => (/חצי/.test(a.group) ? `${a.group}: ${a.name}` : `${a.group}: ${a.name}`));
    let remove = [...line.remove];
    if (o.type === 'remove') {
      remove = remove.includes(o.name) ? remove.filter((x) => x !== o.name) : [...remove, o.name];
    } else {
      const spec = `${g.group}: ${o.name}`;
      add = add.includes(spec) ? add.filter((x) => x !== spec) : [...add, spec];
    }
    const r = menu.buildLine(s.service, { product_id: line.product_id, size: line.size, quantity: line.quantity, add, remove, note: line.note });
    if (r.error) return { error: r.error };
    s.cart[n - 1] = r.line;
    return { line: r.line };
  }

  function cartReply(s, intro) {
    if (!s.cart.length) return { ...categoriesReply(s.service, 'הסל ריק. מה להכין?') };
    const sub = s.cart.reduce((x, l) => x + l.total, 0);
    return {
      reply: `${intro ? `${intro}\n` : ''}🛒 *הסל שלך*\n${s.cart.map((l, i) => `${i + 1}. ${describeLine(l)} — ${l.total}₪`).join('\n')}\nביניים: ${Math.round(sub * 100) / 100}₪`,
      choices: [c('cats', '➕ עוד מנה'), c('checkout', '✔️ לסיום ההזמנה'), c('edit', '✏️ עריכת הסל')],
    };
  }

  function editReply(s) {
    if (!s.cart.length) return cartReply(s);
    const choices = [];
    s.cart.slice(0, 4).forEach((l, i) => {
      choices.push(c(`del:${i + 1}`, `🗑 הסרה: ${itemTitle(l)}`.slice(0, 60), `${l.total}₪`));
      if (optionRows(s.service, l).length) choices.push(c(`opts:${i + 1}:0`, `⚙️ שינויים: ${itemTitle(l)}`.slice(0, 60)));
    });
    choices.push(c('cart', '‹ חזרה לסל'));
    return { reply: 'מה לשנות? (אפשר גם לכתוב, למשל "תוריד את הקולה" או "2 במקום 1")', choices: choices.slice(0, 10), listTitle: 'עריכת הסל' };
  }

  async function checkoutReply(s) {
    if (!s.cart.length) return categoriesReply(s.service, 'הסל עדיין ריק — מה להכין?');
    const saved = store.customer(s.customerId);
    if (!s.details.name && saved?.name) s.details.name = saved.name;
    if (s.service === 'delivery' && !s.details.address && saved?.address) {
      return {
        reply: `לשלוח ל-${saved.address}?`,
        choices: [c('addr:saved', '📍 כן, לשם'), c('addr:new', '✏️ כתובת אחרת')],
      };
    }
    const missing = [];
    if (!s.details.name) missing.push('על איזה שם');
    if (s.service === 'delivery' && !s.details.address) missing.push('לאן לשלוח (רחוב, מספר, שכונה, קומה)');
    if (s.service === 'takeaway' && !s.details.pickupTime) missing.push('לאיזו שעה (או "בהקדם")');
    if (missing.length) return { reply: `כמעט סיימנו! ${missing.join(', ')}?${s.details.payment ? '' : ' ומזומן או אשראי?'}` };
    if (!s.details.payment) return { reply: 'איך משלמים?', choices: [c('pay:מזומן', '💵 מזומן'), c('pay:אשראי', '💳 אשראי')] };
    const sum = await execute(s, 'show_summary', {});
    if (sum.error) return { reply: sum.error, choices: [c('cats', '➕ עוד מנה'), c('edit', '✏️ עריכת הסל')] };
    return { reply: `${sum.summary_text}\n\nלאשר?`, choices: [c('confirm', '✅ מאשר'), c('edit', '✏️ לשנות משהו')] };
  }

  async function handle(s, payload) {
    const [kind, ...a] = String(payload).split(':');
    const needService = !['svc', 'menu'].includes(kind) && !s.service;
    if (needService) return { reply: 'משלוח או איסוף עצמי? (המחירים שונים)', choices: serviceChoices() };

    switch (kind) {
      case 'svc': {
        const hadCart = s.cart.length > 0 && s.service && s.service !== a[0];
        const r = await execute(s, 'set_service', { service: a[0] });
        if (hadCart) {
          const lines = [`עברנו ל${SERVICES[s.service]} 👌`];
          if (r.price_changes) lines.push(`מחירים מעודכנים: ${r.price_changes.join(' · ')}`);
          if (r.dropped) lines.push(`⚠️ לא קיים ב${SERVICES[s.service]}: ${r.dropped.join(', ')}`);
          return r.choices ? { reply: `${lines.join('\n')}\nלהוסיף במקום?`, choices: r.choices } : cartReply(s, lines.join('\n'));
        }
        if (s.menuShown) {
          // menu images were already sent — just continue to the clickable menu (its prices are for this service)
          return categoriesReply(s.service, `מעולה, ${SERVICES[s.service]} 👌${s.service === 'delivery' && s.menuShown !== 'delivery' ? ' (המחירים ברשימה הם למשלוח)' : ''} בחרו קטגוריה או פשוט כתבו מה להכין:`);
        }
        await execute(s, 'send_menu', { section: 'all' });
        return { ...categoriesReply(s.service, `מעולה, ${SERVICES[s.service]} 👌 הנה התפריט. בחרו קטגוריה או פשוט כתבו מה להכין:`) };
      }
      case 'menu': {
        await execute(s, 'send_menu', { section: 'all' });
        if (!s.service) {
          return { reply: 'הנה התפריט 👆\nהמחירים בתמונות הם לאיסוף עצמי (במשלוח קצת יותר).\nלהזמנה — משלוח או איסוף?', choices: serviceChoices() };
        }
        return categoriesReply(s.service, 'הנה התפריט 👆 בחרו קטגוריה או כתבו לי:');
      }
      case 'cats': return categoriesReply(s.service);
      case 'cat': return itemsReply(s.service, Number(a[0]), Number(a[1] || 0));
      case 'item': {
        const it = catalogs[s.service][Number(a[0])]?.items[Number(a[1])];
        if (!it) return categoriesReply(s.service);
        if (it.sizes.length === 1) return handle(s, `size:${a[0]}:${a[1]}:0`);
        return {
          reply: `${it.title}${it.description ? `\n${it.description}` : ''}\nאיזה גודל?`,
          choices: it.sizes.map((sz, si) => c(`size:${a[0]}:${a[1]}:${si}`, `${sz.label} ${sz.price}₪`)),
        };
      }
      case 'size': {
        const it = catalogs[s.service][Number(a[0])]?.items[Number(a[1])];
        const sz = it?.sizes[Number(a[2])];
        if (!sz) return categoriesReply(s.service);
        return productStep(s, sz.product_id, sz.size, it.title);
      }
      case 'req': { // legacy payload: req:<cat>:<item>:<size>:<group>:<option>
        const it = catalogs[s.service][Number(a[0])]?.items[Number(a[1])];
        const sz = it?.sizes[Number(a[2])];
        if (!sz) return categoriesReply(s.service);
        return handle(s, `pr:${sz.product_id}:${sz.size || '-'}:${a[3]}:${a[4]}`);
      }
      case 'p': // p:<product_id>:<size|->
        return productStep(s, a[0], a[1] === '-' ? null : a[1]);
      case 'pr': { // pr:<product_id>:<size|->:<group>:<option>  — required option chosen
        const p = menu.get(s.service, a[0]);
        if (!p) return categoriesReply(s.service);
        const size = a[1] === '-' ? null : a[1];
        const v = p.variants.find((x) => x.label === size) || p.variants[0];
        const g = v.groups[Number(a[2])];
        const o = g && g.options[Number(a[3])];
        if (!o) return productStep(s, p.id, size);
        return addLine(s, { product_id: p.id, size: v.label }, [`${g.group}: ${o.name}`]);
      }
      case 'opts': return optionsReply(s, Number(a[0]), Number(a[1] || 0));
      case 'opt': {
        const r = toggleOption(s, Number(a[0]), Number(a[1]), Number(a[2]));
        const next = optionsReply(s, Number(a[0]), Number(a[3] || 0));
        return r.error ? { ...next, reply: `⚠️ ${r.error}\n\n${next.reply}` } : next;
      }
      case 'done': {
        const line = s.cart[Number(a[0]) - 1];
        return { reply: line ? `✓ ${describeLine(line)} — ${line.total}₪\nעוד משהו?` : 'עוד משהו?', choices: afterAddChoices(0, false) };
      }
      case 'cart': return cartReply(s);
      case 'edit': return editReply(s);
      case 'del': {
        await execute(s, 'update_cart', { action: 'remove', line: Number(a[0]) });
        return cartReply(s, '🗑 הוסר.');
      }
      case 'checkout': return checkoutReply(s);
      case 'addr': {
        if (a[0] === 'saved') {
          const saved = store.customer(s.customerId);
          const r = await execute(s, 'set_details', { address: saved?.address });
          if (r.error) return { reply: 'לאן לשלוח? (רחוב, מספר, שכונה, קומה)' };
          return checkoutReply(s);
        }
        return { reply: 'לאן לשלוח? (רחוב, מספר, שכונה, קומה)' };
      }
      case 'pay': {
        await execute(s, 'set_details', { payment: a[0] });
        return checkoutReply(s);
      }
      case 'confirm': {
        const r = await execute(s, 'confirm_order', {});
        if (r.error) return checkoutReply(s);
        const eta = s.service === 'delivery' ? `תגיע תוך ${r.eta_minutes} דק'` : `תהיה מוכנה תוך ${r.eta_minutes} דק'`;
        return { reply: `✅ הזמנה #${r.order_number} התקבלה! ${eta}. בתיאבון 🍕` };
      }
      default:
        return null;
    }
  }

  return { handle, catalogs, serviceChoices, afterAdd };
}

module.exports = { createFlow };
