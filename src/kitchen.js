// kitchen.js — where a confirmed order goes.
// Today: saved to data/runtime/orders.jsonl + shown in the demo "kitchen" panel + console.
// Later: one of the PLACEHOLDERS below (Tabit API / Telegram group / WhatsApp to staff).

function ticketText(order) {
  const lines = order.items.map((l) => {
    const title = l.size ? `${l.name.replace(/\s*(אישית|גדולה)$/, '')} ${l.size}` : l.name;
    const add = l.add.length ? `\n     + ${l.add.map((a) => (a.group && /חצי/.test(a.group) ? `${a.name} (${a.group})` : a.name)).join(', ')}` : '';
    const rem = l.remove.length ? `\n     - בלי ${l.remove.join(', ')}` : '';
    const note = l.note ? `\n     * ${l.note}` : '';
    return `${l.quantity} x ${title}  ${l.total}₪${add}${rem}${note}`;
  });
  const d = order.details;
  return [
    `🍕 הזמנה #${order.number} — ${order.service === 'delivery' ? 'משלוח' : 'איסוף עצמי'}`,
    `${d.name} | ${order.customerId}`,
    order.service === 'delivery' ? `כתובת: ${d.address} (${d.zone})` : `איסוף: ${d.pickupTime || 'בהקדם'}`,
    '──────────',
    ...lines,
    '──────────',
    order.service === 'delivery' ? `משלוח: ${order.deliveryFee}₪` : null,
    `סה"כ: ${order.total}₪ | תשלום: ${d.payment || 'בעת קבלה'}`,
    d.notes ? `הערות: ${d.notes}` : null,
  ].filter(Boolean).join('\n');
}

const tel = require('./telemetry');

async function notifyKitchen(order) {
  const text = ticketText(order);
  tel.count('orders');
  tel.count('orders.revenue', order.total);
  tel.log('order.created', {
    number: order.number, service: order.service, items: order.items.length, total: order.total,
    message: `#${order.number} ${order.total}₪`, ticket: text,
  });

  // PLACEHOLDER 1 — Telegram group for the staff (easiest real option):
  // if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_KITCHEN_CHAT_ID) {
  //   await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
  //     method: 'POST', headers: { 'Content-Type': 'application/json' },
  //     body: JSON.stringify({ chat_id: process.env.TELEGRAM_KITCHEN_CHAT_ID, text }),
  //   });
  // }

  // PLACEHOLDER 2 — Tabit (if/when Tabit gives API access for creating orders):
  // await tabit.createOrder(mapToTabit(order));   // TODO: requires Tabit partner API

  return { delivered: true, channel: 'demo-kitchen-panel', text };
}

module.exports = { notifyKitchen, ticketText };
