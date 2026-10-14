#!/usr/bin/env node
// clean-menu.js — turns a raw Tabit catalog (tdcatalogs JSON) into a clean menu for the bot.
// Usage: node clean-menu.js menu-raw.json
// Output: menu-clean.json (for the bot) + menu-clean.md (for the owner to review)

const fs = require('fs');
const path = require('path');

const inFile = process.argv[2] || 'menu-raw.json';
const raw = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const ils = (agorot) => (agorot == null ? null : agorot / 100);
const warnings = [];

// ---- indexes ----
const offers = new Map((raw.offers || []).map((o) => [o._id, o]));
const items = new Map((raw.items || []).map((i) => [i._id, i]));
const modGroups = new Map((raw.modifierGroups || []).map((g) => [g._id, g]));

const offerPrice = new Map(); // `${offer}|${menu}` -> agorot
const modPrice = new Map();   // `${group}|${modifier}|${menu}` -> agorot
for (const p of raw.prices || []) {
  if (p.offer) offerPrice.set(`${p.offer}|${p.menu}`, p.price);
  if (p.modifierGroup) modPrice.set(`${p.modifierGroup}|${p.modifier}|${p.menu}`, p.price);
}

function priceOfOffer(offerId) {
  const o = offers.get(offerId);
  if (!o) return null;
  if (offerPrice.has(`${offerId}|${o.menu}`)) return offerPrice.get(`${offerId}|${o.menu}`);
  for (const [k, v] of offerPrice) if (k.startsWith(offerId + '|')) return v; // fallback: any price list
  return null;
}

function priceOfModifier(groupId, modId, menuId) {
  if (modPrice.has(`${groupId}|${modId}|${menuId}`)) return modPrice.get(`${groupId}|${modId}|${menuId}`);
  return 0; // no price row = free change (e.g. removing an ingredient)
}

function optionsFor(offerId) {
  const o = offers.get(offerId);
  const item = o && items.get(o.items && o.items[0]);
  if (!item) return [];
  return (item.modifierGroups || []).map((mg) => {
    const g = modGroups.get(mg.modifierGroup);
    if (!g) return null;
    const defaults = new Set((mg.defaults || []).map((d) => d.modifier));
    return {
      group: g.name,
      min: mg.min ?? null,
      max: mg.max ?? null,
      options: (g.modifiers || []).map((m) => ({
        name: m.name,
        // default = already on the dish (the customer can remove it); otherwise it's an add-on
        type: defaults.has(m._id) ? 'remove' : 'add',
        price: ils(priceOfModifier(g._id, m._id, o.menu)),
      })),
    };
  }).filter(Boolean);
}

// ---- build ----
const services = {};
for (const view of raw.view || []) {
  if (view.type !== 'menu' || view.disabled || view._hidden) continue;
  const activeItems = (view.items || []).filter((it) => !it.disabled);
  if (!activeItems.length) continue;

  for (const service of view.services || ['all']) {
    if (service === 'eatin') continue; // the bot handles delivery & pickup only
    const cats = (services[service] ||= []);
    const cat = { category: view.name, items: [] };

    for (const it of activeItems) {
      const entry = {
        name: it.name,
        description: it.description || offers.get(it.offer)?.description || '',
        price: ils(priceOfOffer(it.offer)),
        options: optionsFor(it.offer),
      };

      // sizes (personal / L) come as a bundle of offers
      const bundle = it.offerBundle && it.offerBundle.offers;
      if (Array.isArray(bundle) && bundle.length) {
        entry.sizes = bundle.map((b) => {
          const listed = priceOfOffer(b.offerId);
          if (listed != null && b.price != null && listed !== b.price) {
            warnings.push(`${it.name} (${service}): size "${b.caption || b.name}" — bundle says ${ils(b.price)}₪, price list says ${ils(listed)}₪. Using price list.`);
          }
          return {
            size: b.caption || b.name,
            price: ils(listed ?? b.price),
            options: optionsFor(b.offerId),
          };
        });
        delete entry.price;
        delete entry.options;
      }

      if (entry.price == null && !entry.sizes) warnings.push(`${it.name} (${service}): no price found`);
      cat.items.push(entry);
    }
    cats.push(cat);
  }
}

// ---- write JSON ----
const out = {
  source: path.basename(inFile),
  catalogLastUpdated: raw.lastUpdated || null,
  currency: 'ILS',
  services,
  warnings,
};
fs.writeFileSync('menu-clean.json', JSON.stringify(out, null, 2));

// ---- write Markdown for owner review ----
const label = { delivery: 'משלוח', takeaway: 'איסוף עצמי' };
let md = `# תפריט פפידו — לבדיקה\n\nמקור: קטלוג טאביט, עודכן ${raw.lastUpdated || '?'}\n\n`;
for (const [svc, cats] of Object.entries(services)) {
  md += `## ${label[svc] || svc}\n\n`;
  for (const c of cats) {
    md += `### ${c.category}\n\n`;
    for (const it of c.items) {
      const p = it.sizes ? it.sizes.map((s) => `${s.size || 'אישית'}: ${s.price}₪`).join(' | ') : `${it.price}₪`;
      md += `- **${it.name}** — ${p}${it.description ? `\n  ${it.description}` : ''}\n`;
    }
    md += '\n';
  }
}
if (warnings.length) md += `## אזהרות\n\n${warnings.map((w) => `- ${w}`).join('\n')}\n`;
fs.writeFileSync('menu-clean.md', md);

const count = Object.values(services).flat().reduce((n, c) => n + c.items.length, 0);
console.log(`OK: ${Object.keys(services).join(', ')} | ${count} items | ${warnings.length} warnings`);
console.log('Wrote menu-clean.json and menu-clean.md');
