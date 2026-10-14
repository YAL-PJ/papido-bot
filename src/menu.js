// menu.js — loads the cleaned Tabit menu and answers deterministic questions about it.
// Prices are ALWAYS computed here, never by the language model.

const fs = require('fs');
const path = require('path');

const SERVICES = { delivery: 'משלוח', takeaway: 'איסוף עצמי' };

function norm(s) {
  return String(s || '')
    .replace(/^ח\./, '')
    .replace(/[׳'’"״]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// "רוטב לפיצה בהרכבה גדול" ~ "רוטב לפיצה בהרכבה", "חצי ימין - גדולה" ~ "חצי ימין"
function groupCore(name) {
  return norm(name).replace(/[-–?]/g, ' ').replace(/(^|\s)(גדולה?|l)(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
}
function sameGroup(a, b) {
  const x = groupCore(a);
  const y = groupCore(b);
  return x === y || x.includes(y) || y.includes(x);
}

function sizeLabel(size) {
  if (!size) return 'אישית';
  return /\bL\b|גדול/.test(size) ? 'L' : 'אישית';
}

// Display names for options whose Tabit name isn't customer-friendly (aliases still match the old name)
const OPTION_RENAMES = { 'Extra Cheese': 'תוספת גבינה' };
const OPTION_ALIASES = { 'extra cheese': 'תוספת גבינה', 'אקסטרה גבינה': 'תוספת גבינה', 'גבינה נוספת': 'תוספת גבינה' };

function renameOptions(groups) {
  for (const g of groups || []) for (const o of g.options || []) if (OPTION_RENAMES[o.name]) o.name = OPTION_RENAMES[o.name];
  return groups || [];
}

function loadMenu(file = path.join(__dirname, '..', 'data', 'menu-clean.json')) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const products = {}; // service -> [product]
  for (const [service, cats] of Object.entries(raw.services)) {
    const prefix = service === 'delivery' ? 'd' : 't';
    let n = 0;
    products[service] = [];
    for (const cat of cats) {
      for (const it of cat.items) {
        n += 1;
        const variants = it.sizes
          ? it.sizes.map((s) => ({ label: sizeLabel(s.size), price: s.price, groups: renameOptions(s.options) }))
          : [{ label: null, price: it.price, groups: renameOptions(it.options) }];
        products[service].push({
          id: `${prefix}${n}`,
          service,
          category: cat.category,
          name: it.name,
          description: it.description || '',
          variants,
        });
      }
    }
  }
  return { products, updated: raw.catalogLastUpdated };
}

class Menu {
  constructor(file) {
    const { products, updated } = loadMenu(file);
    this.products = products;
    this.updated = updated;
  }

  get(service, id) {
    return (this.products[service] || []).find((p) => p.id === id) || null;
  }

  // Compact text for the system prompt: ids, names, prices. Generated from data, so prices are exact.
  compactListing(service) {
    const lines = [];
    let cat = null;
    for (const p of this.products[service] || []) {
      if (p.category !== cat) {
        cat = p.category;
        lines.push(`## ${cat}`);
      }
      const price = p.variants
        .map((v) => (v.label ? `${v.label} ${v.price}₪` : `${v.price}₪`))
        .join(' / ');
      const hasOptions = p.variants.some((v) => v.groups.length);
      lines.push(`${p.id} | ${p.name} | ${price}${p.description ? ` | ${p.description}` : ''}${hasOptions ? ' | [יש תוספות/שינויים]' : ''}`);
    }
    return lines.join('\n');
  }

  details(service, id) {
    const p = this.get(service, id);
    if (!p) return { error: `אין מנה ${id} בתפריט ה${SERVICES[service] || service}` };
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      variants: p.variants.map((v) => ({
        size: v.label,
        price: v.price,
        option_groups: v.groups.map((g) => ({
          group: g.group,
          required: (g.min || 0) >= 1,
          max: g.max,
          options: g.options.map((o) => ({
            name: o.name,
            type: o.type === 'remove' ? 'כלול במנה (אפשר להוריד)' : 'תוספת',
            price: o.price,
          })),
        })),
      })),
    };
  }

  // Build a validated order line. Returns { line } or { error }.
  buildLine(service, { product_id, size, quantity = 1, add = [], remove = [], note = '' }) {
    const p = this.get(service, product_id);
    if (!p) return { error: `מנה ${product_id} לא קיימת בתפריט ה${SERVICES[service]}. השתמש במזהה מהתפריט.` };

    let variant = p.variants[0];
    if (p.variants.length > 1) {
      if (!size) {
        return {
          error: `צריך לבחור גודל ל${p.name}: ${p.variants.map((v) => `${v.label} (${v.price}₪)`).join(' או ')}`,
          choices: p.variants.map((v) => ({ id: `p:${p.id}:${v.label}`, title: `${v.label} ${v.price}₪` })),
        };
      }
      variant = p.variants.find((v) => norm(v.label) === norm(size) || norm(size).startsWith(norm(v.label) + ' ')) || null;
      if (!variant) return { error: `גודל "${size}" לא קיים ל${p.name}. אפשרויות: ${p.variants.map((v) => v.label).join(', ')}` };
    }

    const qty = Math.max(1, Math.min(50, parseInt(quantity, 10) || 1));
    const chosen = [];
    const errors = [];

    const resolve = (spec, wantType) => {
      let groupHint = null;
      let name = spec;
      const m = String(spec).match(/^(.+?)\s*:\s*(.+)$/);
      if (m) { groupHint = m[1]; name = m[2]; }
      name = OPTION_ALIASES[norm(name)] || name;
      const candidates = [];
      for (const g of variant.groups) {
        if (groupHint && !sameGroup(g.group, groupHint)) continue;
        for (const o of g.options) {
          if (wantType && o.type !== wantType) continue;
          if (norm(o.name) === norm(name) || norm(o.name).includes(norm(name)) || norm(name).includes(norm(o.name))) {
            candidates.push({ group: g.group, ...o });
          }
        }
      }
      if (!candidates.length) {
        const avail = variant.groups.flatMap((g) => g.options.filter((o) => !wantType || o.type === wantType).map((o) => o.name));
        errors.push(`"${spec}" לא אפשרי ב${p.name}.${avail.length ? ` אפשרויות: ${[...new Set(avail)].join(', ')}` : ' אין למנה הזו שינויים.'}`);
        return null;
      }
      const groups = [...new Set(candidates.map((c) => c.group))];
      if (groups.length > 1) {
        errors.push(`"${spec}" — צריך לציין איפה: ${groups.join(' / ')} (למשל "${groups[0]}: ${name}")`);
        return null;
      }
      return candidates[0];
    };

    for (const a of add) {
      const o = resolve(a, 'add');
      if (o) chosen.push({ group: o.group, name: o.name, kind: 'add', price: o.price || 0 });
    }
    for (const r of remove) {
      const o = resolve(r, 'remove');
      if (o) chosen.push({ group: o.group, name: o.name, kind: 'remove', price: 0 });
    }

    let choices = null;
    variant.groups.forEach((g, gi) => {
      const count = chosen.filter((c) => c.group === g.group).length;
      if ((g.min || 0) >= 1 && count < g.min) {
        errors.push(`חובה לבחור ב"${g.group}": ${g.options.map((o) => o.name).join(' / ')}`);
        // clickable answer: picks the required option and adds the dish (with the other add-ons asked for)
        if (!choices) choices = g.options.slice(0, 10).map((o, oi) => ({ id: `pr:${p.id}:${variant.label || '-'}:${gi}:${oi}`, title: `${o.name}${o.price ? ` +${o.price}₪` : ''}` }));
      }
      if (g.max && count > g.max) errors.push(`אפשר לבחור עד ${g.max} ב"${g.group}"`);
    });
    if (errors.length) return { error: errors.join(' | '), ...(choices ? { choices } : {}) };

    const unit = variant.price + chosen.reduce((s, c) => s + c.price, 0);
    return {
      line: {
        product_id: p.id,
        name: p.name,
        size: variant.label,
        quantity: qty,
        add: chosen.filter((c) => c.kind === 'add').map((c) => ({ name: c.name, group: c.group, price: c.price })),
        remove: chosen.filter((c) => c.kind === 'remove').map((c) => c.name),
        note: note || '',
        unitPrice: Math.round(unit * 100) / 100,
        total: Math.round(unit * qty * 100) / 100,
      },
    };
  }
}

const canonicalOption = (name) => OPTION_ALIASES[norm(name)] || name;

module.exports = { Menu, SERVICES, norm, canonicalOption };
