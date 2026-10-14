// business.js — business info (hours, delivery zones, FAQ) + deterministic helpers.

const fs = require('fs');
const path = require('path');
const { norm } = require('./menu');

const TZ = 'Asia/Jerusalem';
const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

function israelNow(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { day, minutes: parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10), hhmm: `${parts.hour}:${parts.minute}` };
}

const toMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h === 0 && m === 0 ? 24 * 60 : h * 60 + m; // "00:00" as closing = midnight
};

class Business {
  constructor(file = path.join(__dirname, '..', 'data', 'business.json')) {
    this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  // { open, acceptingOrders, text }
  status(date = new Date()) {
    const { day, minutes, hhmm } = israelNow(date);
    const ranges = this.data.hours.byDay[String(day)] || [];
    const lastOrder = this.data.hours.lastOrderMinutesBeforeClose || 0;
    for (const [from, to] of ranges) {
      const a = toMin(from);
      const b = toMin(to);
      if (minutes >= a && minutes < b) {
        return { open: true, acceptingOrders: minutes < b - lastOrder, now: `${DAY_NAMES[day]} ${hhmm}`, closesAt: to };
      }
    }
    return { open: false, acceptingOrders: false, now: `${DAY_NAMES[day]} ${hhmm}`, nextOpening: this.nextOpening(day, minutes) };
  }

  nextOpening(day, minutes) {
    for (let i = 0; i < 8; i++) {
      const d = (day + i) % 7;
      for (const [from] of this.data.hours.byDay[String(d)] || []) {
        if (i > 0 || toMin(from) > minutes) return `${i === 0 ? 'היום' : i === 1 ? 'מחר' : `יום ${DAY_NAMES[d]}`} ב-${from}`;
      }
    }
    return null;
  }

  // Find the delivery zone for a free-text address. Returns { zone, fee } or { error }.
  zoneFor(address) {
    const a = norm(address);
    for (const z of this.data.delivery.zones) {
      for (const area of z.areas) {
        if (a.includes(norm(area))) return { zone: z.name, area, fee: z.fee };
      }
    }
    return { error: 'לא זיהיתי את השכונה. שאל את הלקוח באיזו שכונה בירושלים.' };
  }

  // Knowledge text for the system prompt.
  promptText() {
    const d = this.data;
    const zones = d.delivery.zones.map((z) => `- ${z.name} (${z.fee}₪): ${z.areas.join(', ')}`).join('\n');
    const faq = d.faq
      .map((f) => `- ש: ${f.q}\n  ת: ${f.a === 'HANDOFF' ? '[העבר לנציג עם handoff_to_human]' : f.a}`)
      .join('\n');
    return [
      `שם: ${d.name}`,
      `על המקום: ${d.about}`,
      `כשרות: ${d.kosher.value}`,
      `כתובת: ${d.contact.address} | טלפון: ${d.contact.phone} | ניווט: ${d.contact.wazeLink}`,
      `שעות פתיחה: ${d.hours.text}`,
      `משלוחים: מינימום הזמנה ${d.delivery.minOrder}₪. זמן הגעה ${d.delivery.etaMinutes} דקות (בעומס ${d.delivery.etaPeakMinutes}).`,
      `אזורי משלוח ודמי משלוח:\n${zones}`,
      `לא מגיעים: ${d.delivery.notDelivered}`,
      `איסוף עצמי: מוכן תוך ${d.pickup.readyMinutes} דקות. חניה: ${d.pickup.parking.value}`,
      `תשלום: ${d.payment.methods}`,
      `קישור להזמנה באתר: ${d.orderLink}`,
      `שאלות נפוצות:\n${faq}`,
    ].join('\n');
  }
}

module.exports = { Business, israelNow };
