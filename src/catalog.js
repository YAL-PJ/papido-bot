// catalog.js — the menu arranged for click-through ordering (categories -> dishes -> sizes).
// Pizzas that exist as separate "personal" and "L" products are merged into one dish with two sizes.

const CAT_EMOJI = [
  [/לבנ/, '⚪'],
  [/פיצ/, '🍕'],
  [/ראשונ/, '🥖'],
  [/פסט/, '🍝'],
  [/סלט/, '🥗'],
  [/מתוק/, '🍩'],
];

const emojiFor = (title) => (CAT_EMOJI.find(([re]) => re.test(title)) || [null, '•'])[1];

function pizzaKey(name) {
  return name
    .replace(/[׳'’"]/g, '')
    .split(/\s+/)
    .filter((w) => !['פיצה', 'פיצת', 'אישית', 'גדולה', 'L'].includes(w))
    .sort()
    .join(' ');
}

const displayName = (name) => name.replace(/\s*(אישית|גדולה)$/, '').replace(/^פיצת /, 'פיצה ').trim();

// -> [{ title, items: [{ title, description, sizes: [{ label, product_id, size, price }] }] }]
function buildCatalog(menu, service) {
  const cats = [];
  const pizza = { red: new Map(), white: new Map() };
  const byCat = new Map();

  for (const p of menu.products[service] || []) {
    if (/פיצ/.test(p.category)) {
      const bucket = /לבנ/.test(p.category) ? pizza.white : pizza.red;
      const key = pizzaKey(p.name);
      const item = bucket.get(key) || { title: displayName(p.name), description: '', sizes: [] };
      if (!item.description && p.description) item.description = p.description;
      for (const v of p.variants) {
        const isL = v.label === 'L' || (!v.label && /L$/.test(p.category));
        const label = isL ? 'L' : 'אישית';
        if (!item.sizes.some((s) => s.label === label)) item.sizes.push({ label, product_id: p.id, size: v.label, price: v.price });
      }
      if (/אישית/.test(p.name) || /אישיות/.test(p.category)) item.title = displayName(p.name);
      bucket.set(key, item);
    } else {
      const list = byCat.get(p.category) || [];
      list.push({
        title: p.name,
        description: p.description,
        sizes: p.variants.map((v) => ({ label: v.label || '', product_id: p.id, size: v.label, price: v.price })),
      });
      byCat.set(p.category, list);
    }
  }

  const sortSizes = (it) => { it.sizes.sort((a) => (a.label === 'L' ? 1 : -1)); return it; };
  if (pizza.red.size) cats.push({ title: 'פיצות', items: [...pizza.red.values()].map(sortSizes) });
  if (pizza.white.size) cats.push({ title: 'פיצות לבנות', items: [...pizza.white.values()].map(sortSizes) });
  for (const [title, items] of byCat) cats.push({ title, items });
  return cats.map((c) => ({ ...c, emoji: emojiFor(c.title) }));
}

const priceText = (item) => item.sizes.map((s) => (s.label ? `${s.label} ${s.price}₪` : `${s.price}₪`)).join(' · ');

// ---- moving a cart line between price lists (delivery <-> pickup) ----
const cache = new WeakMap();
function catalogsFor(menu) {
  if (!cache.has(menu)) cache.set(menu, { delivery: buildCatalog(menu, 'delivery'), takeaway: buildCatalog(menu, 'takeaway') });
  return cache.get(menu);
}

// The same dish + size in the other service. Returns { product_id, size } or null.
// Works across the different Tabit layouts: e.g. delivery "פיצה X אישית" with an L size
// vs. pickup "פיצה X אישית" and a separate "פיצת X גדולה" product.
function equivalentLine(menu, line, from, to) {
  const cats = catalogsFor(menu);
  let found = null;
  for (const cat of cats[from] || []) {
    for (const item of cat.items) {
      const s = item.sizes.find((x) => x.product_id === line.product_id && (x.size || null) === (line.size || null));
      if (s) { found = { item, label: s.label }; break; }
    }
    if (found) break;
  }
  if (!found) return null;
  const key = pizzaKey(found.item.title);
  for (const cat of cats[to] || []) {
    for (const item of cat.items) {
      if (item.title !== found.item.title && pizzaKey(item.title) !== key) continue;
      const s = item.sizes.find((x) => x.label === found.label) || (item.sizes.length === 1 && found.item.sizes.length === 1 ? item.sizes[0] : null);
      if (s) return { product_id: s.product_id, size: s.size };
    }
  }
  return null;
}

// When the exact dish/size doesn't exist in the other service: the same dish in another size.
// -> [{ catIndex, itemIndex, title, prices }]
function alternativesFor(menu, line, from, to) {
  const cats = catalogsFor(menu);
  let src = null;
  for (const cat of cats[from] || []) {
    src = cat.items.find((it) => it.sizes.some((x) => x.product_id === line.product_id));
    if (src) break;
  }
  const key = pizzaKey(src ? src.title : line.name);
  const out = [];
  (cats[to] || []).forEach((cat, ci) => cat.items.forEach((it, ii) => {
    if (pizzaKey(it.title) === key) out.push({ catIndex: ci, itemIndex: ii, title: it.title, prices: priceText(it) });
  }));
  return out;
}

module.exports = { buildCatalog, priceText, equivalentLine, catalogsFor, alternativesFor };
