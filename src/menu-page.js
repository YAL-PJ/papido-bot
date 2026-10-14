// menu-page.js — builds a compact, printable menu (HTML) from the menu data.
// Pizzas are merged into one table: name | personal | L. Everything else in a price list.
// The HTML is served at /menu/<service> and rendered to PNG pages by scripts/render-menu-images.js.

const { SERVICES } = require('./menu');

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function pizzaKey(name) {
  return name
    .replace(/[׳'’"]/g, '')
    .split(/\s+/)
    .filter((w) => !['פיצה', 'פיצת', 'אישית', 'גדולה', 'L'].includes(w))
    .sort()
    .join(' ');
}

function displayName(name) {
  const n = name.replace(/\s*(אישית|גדולה)$/, '').replace(/^פיצת /, 'פיצה ').trim();
  return n;
}

function range(prices) {
  const ps = prices.filter((p) => p > 0);
  if (!ps.length) return null;
  const a = Math.min(...ps), b = Math.max(...ps);
  return a === b ? `${a}₪` : `${a}-${b}₪`;
}

// Topping and extra-cheese price ranges, computed from the real data (not hard-coded).
function extrasInfo(menu, service) {
  const toppings = new Set();
  const topPrices = [];
  const cheese = [];
  for (const p of menu.products[service]) {
    for (const v of p.variants) {
      for (const g of v.groups) {
        for (const o of g.options) {
          if (o.type !== 'add') continue;
          if (/extra cheese|תוספת גבינה/i.test(o.name) || /תוספת גבינה/.test(g.group)) cheese.push(o.price);
          else if (/על הכל/.test(g.group)) { toppings.add(o.name.replace(/^ח\./, '')); topPrices.push(o.price); }
        }
      }
    }
  }
  return { toppings: [...toppings], toppingRange: range(topPrices), cheeseRange: range(cheese) };
}

function collect(menu, service) {
  const red = new Map();
  const white = new Map();
  const others = new Map(); // category -> [{name, price, description}]
  for (const p of menu.products[service]) {
    if (/פיצ/.test(p.category)) {
      const bucket = /לבנ/.test(p.category) ? white : red;
      const key = pizzaKey(p.name);
      const row = bucket.get(key) || { name: displayName(p.name), description: '', personal: null, large: null };
      if (!row.description && p.description) row.description = p.description;
      for (const v of p.variants) {
        const isL = v.label === 'L' || (!v.label && /L$/.test(p.category));
        if (isL) row.large = row.large ?? v.price;
        else row.personal = row.personal ?? v.price;
      }
      // personal-category items name the pizza best; keep that name
      if (/אישית/.test(p.name) || /אישיות/.test(p.category)) row.name = displayName(p.name);
      bucket.set(key, row);
    } else {
      const list = others.get(p.category) || [];
      list.push({ name: p.name, price: p.variants[0].price, description: p.description });
      others.set(p.category, list);
    }
  }
  return { red: [...red.values()], white: [...white.values()], others };
}

const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Rubik", "Heebo", "Segoe UI", "Arial", "DejaVu Sans", sans-serif; background: #ece7dc; }
  .page { width: 1080px; min-height: 1350px; margin: 0 auto 24px; background: #fffaf0; color: #1d1b16; padding: 56px 64px 48px; display: flex; flex-direction: column; }
  .top { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 6px solid #d7262f; padding-bottom: 18px; }
  .brand { font-size: 74px; font-weight: 900; color: #d7262f; letter-spacing: 3px; line-height: 1; direction: ltr; }
  .brand small { display: block; font-size: 22px; letter-spacing: 1px; color: #1d1b16; font-weight: 600; margin-top: 6px; }
  .tag { text-align: left; }
  .tag b { display: inline-block; background: #ffd400; padding: 8px 18px; border-radius: 999px; font-size: 26px; }
  .tag div { font-size: 19px; color: #6f6a5f; margin-top: 8px; }
  h2 { font-size: 34px; margin: 34px 0 12px; display: flex; align-items: baseline; gap: 14px; }
  h2 span { font-size: 19px; font-weight: 400; color: #6f6a5f; }
  table { width: 100%; border-collapse: collapse; }
  th { font-size: 19px; color: #6f6a5f; font-weight: 600; text-align: center; padding: 0 0 6px; }
  th:first-child { text-align: right; }
  td { padding: 11px 0; border-bottom: 1px dashed #d9d1bf; vertical-align: top; }
  td.name b { font-size: 26px; }
  td.name div { font-size: 17px; color: #6f6a5f; margin-top: 3px; line-height: 1.35; }
  td.price { width: 130px; text-align: center; font-size: 27px; font-weight: 700; white-space: nowrap; }
  td.price.na { color: #c4bba8; font-weight: 400; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 48px; }
  .item { display: flex; justify-content: space-between; gap: 16px; padding: 10px 0; border-bottom: 1px dashed #d9d1bf; }
  .item b { font-size: 24px; }
  .item div { font-size: 16px; color: #6f6a5f; margin-top: 2px; line-height: 1.35; }
  .item .p { font-size: 25px; font-weight: 700; white-space: nowrap; }
  .foot { margin-top: auto; padding-top: 28px; display: flex; justify-content: space-between; align-items: center; font-size: 21px; color: #6f6a5f; }
  .foot b { color: #d7262f; font-size: 25px; }
`;

function header(service, business, page, pages) {
  return `<div class="top">
    <div class="brand">PAPIDO<small>פיצה ניו יורק · ירושלים</small></div>
    <div class="tag"><b>תפריט ${SERVICES[service]}</b><div>${esc(business.data.kosher.value.split('.')[0])} · עמוד ${page}/${pages}</div></div>
  </div>`;
}

function footer(service, business) {
  const extra = service === 'delivery'
    ? `משלוח מינימום ${business.data.delivery.minOrder}₪ · ${business.data.delivery.etaMinutes} דק'`
    : `מוכן לאיסוף תוך ${business.data.pickup.readyMinutes} דק'`;
  return `<div class="foot"><span>${extra}</span><b>להזמנה — פשוט כתבו לנו כאן 💬</b></div>`;
}

function pizzaTable(rows) {
  return `<table><tr><th></th><th>אישית</th><th>L</th></tr>${rows.map((r) => `
    <tr><td class="name"><b>${esc(r.name)}</b>${r.description ? `<div>${esc(r.description)}</div>` : ''}</td>
    <td class="price${r.personal == null ? ' na' : ''}">${r.personal == null ? '—' : `${r.personal}₪`}</td>
    <td class="price${r.large == null ? ' na' : ''}">${r.large == null ? '—' : `${r.large}₪`}</td></tr>`).join('')}</table>`;
}

// Returns [{ title, html }] — one entry per printable page.
function menuPages(menu, business, service) {
  const { red, white, others } = collect(menu, service);
  const ex = extrasInfo(menu, service);
  const otherSections = [...others.entries()].map(([cat, items]) => `
    <h2>${esc(cat)}</h2>
    <div class="grid">${items.map((i) => `<div class="item"><span><b>${esc(i.name)}</b>${i.description ? `<div>${esc(i.description)}</div>` : ''}</span><span class="p">${i.price}₪</span></div>`).join('')}</div>`).join('');

  const pages = [
    { title: 'פיצות אדומות', body: `<h2>פיצות ניו יורק <span>רוטב עגבניות · אישית ≈30 ס"מ · L ≈45 ס"מ, 8 משולשים</span></h2>${pizzaTable(red)}` },
    { title: 'פיצות לבנות ותוספות', body: `<h2>פיצות לבנות <span>רוטב לבן</span></h2>${pizzaTable(white)}
      ${ex.toppings.length ? `<h2>תוספות לפיצה <span>בפיצה בהרכבה אפשר גם לחצי</span></h2>
      <div class="item"><span><b>תוספות</b><div>${esc(ex.toppings.filter((t) => !/extra cheese/i.test(t)).join(', '))}</div></span><span class="p">${ex.toppingRange || ''}</span></div>` : ''}
      ${ex.cheeseRange ? `<div class="item"><span><b>תוספת גבינה</b></span><span class="p">${ex.cheeseRange}</span></div>` : ''}` },
    { title: 'ראשונות, פסטות וסלטים', body: otherSections },
  ];
  return pages.map((p, i) => ({
    title: p.title,
    html: `<section class="page">${header(service, business, i + 1, pages.length)}${p.body}${footer(service, business)}</section>`,
  }));
}

function menuDocument(menu, business, service) {
  const pages = menuPages(menu, business, service);
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=1080"><title>תפריט פפידו — ${SERVICES[service]}</title><style>${CSS}</style></head>
<body>${pages.map((p) => p.html).join('\n')}</body></html>`;
}

module.exports = { menuPages, menuDocument };
