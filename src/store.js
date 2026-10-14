// store.js — customers, conversations and orders, on top of a storage backend (files or Redis — see storage.js).
//
// Identifiers:
//   customerId      — the customer's phone number (WhatsApp sends it with every message)
//   conversationId  — one conversation = from the first message until the order is done or 2h of silence.
//                     Format c-YYMMDD-xxxx. Every message is recorded under it.
//   messageId       — one customer message + the bot's reply (= the telemetry traceId, so logs and transcript link up)
//   order.number    — running order number (1001, 1002, …), also linked to its conversationId
//
// Reads during a message are synchronous (from an in-memory copy); the agent calls load() before a message
// and persist() after it, so nothing is lost when the server restarts or another instance takes the next message.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const tel = require('./telemetry');
const { createBackend } = require('./storage');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data', 'runtime');
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // a conversation ends after 2h of silence
const DAY = 24 * 3600;
const CONVERSATION_TTL_SEC = Number(process.env.CONVERSATION_RETENTION_DAYS || 90) * DAY;

const K = {
  session: (id) => `session:${id}`,
  customer: (id) => `customer:${id}`,
  conv: (cid) => `conv:${cid}`,
  convIndex: 'conversations',
  custConvs: (id) => `cconvs:${id}`,
  orders: 'orders',
  orderCounter: 'order-counter',
};

function newConversationId(now = new Date()) {
  const d = now.toISOString().slice(2, 10).replace(/-/g, '');
  return `c-${d}-${crypto.randomBytes(3).toString('hex')}`;
}

class Store {
  constructor(dir = DATA_DIR, { backend } = {}) {
    this.backend = backend || createBackend({ dir });
    this.sessions = new Map();
    this.customers = new Map(); // id -> record | null
    this.pending = new Set(); // writes in flight
    if (this.backend.name === 'file') migrateOldFiles(dir, this.backend);
    tel.log('storage.ready', { backend: this.backend.name });
  }

  // ---- write queue: writes never block a reply, but persist()/flush() wait for them ----
  write(what, fn) {
    const p = Promise.resolve().then(fn).catch((e) => tel.log('storage.write_failed', { what, message: e.message }, 'error'));
    this.pending.add(p);
    p.finally(() => this.pending.delete(p));
    return p;
  }
  async flush() { while (this.pending.size) await Promise.all([...this.pending]); }

  // ---- per message ----
  async load(customerId) {
    if (!this.backend.shared && this.sessions.has(customerId)) return;
    const [s, c] = await Promise.all([this.backend.get(K.session(customerId)), this.backend.get(K.customer(customerId))]);
    if (s) this.sessions.set(customerId, s); else if (this.backend.shared) this.sessions.delete(customerId);
    this.customers.set(customerId, c || null);
  }

  async persist(customerId) {
    const s = this.sessions.get(customerId);
    if (s) {
      const { out, ...rest } = s; // `out` is only the current reply
      await this.write('session', () => this.backend.set(K.session(customerId), rest, Math.ceil(SESSION_TTL_MS / 1000) + DAY));
    }
    await this.flush();
  }

  // ---- sessions (= the open conversation) ----
  session(customerId) {
    const now = Date.now();
    let s = this.sessions.get(customerId);
    if (!s && this.backend.getSync) s = this.backend.getSync(K.session(customerId));
    if (!s || now - s.lastSeen > SESSION_TTL_MS || s.status === 'done') {
      s = newSession(customerId);
      this.write('conversation.index', async () => {
        const entry = { conversationId: s.conversationId, customerId, startedAt: s.startedAt };
        await this.backend.push(K.convIndex, entry, { max: 5000 });
        await this.backend.push(K.custConvs(customerId), s.conversationId, { max: 200 });
      });
      tel.log('conversation.start', { conversationId: s.conversationId });
    }
    if (!s.out) s.out = { images: [], links: [], choices: null, listTitle: null };
    s.lastSeen = now;
    this.sessions.set(customerId, s);
    return s;
  }

  // the current conversation without starting a new one (for status screens)
  peek(customerId) {
    let s = this.sessions.get(customerId);
    if (!s && this.backend.getSync) s = this.backend.getSync(K.session(customerId));
    if (!s || Date.now() - s.lastSeen > SESSION_TTL_MS) return null;
    return s;
  }

  resetSession(customerId) {
    this.sessions.delete(customerId);
    this.write('session.reset', () => this.backend.del(K.session(customerId)));
  }

  // ---- conversation transcript ----
  record(session, entry) {
    const e = { at: new Date().toISOString(), ...entry };
    this.write('conversation.message', () => this.backend.push(K.conv(session.conversationId), e, { ttlSec: CONVERSATION_TTL_SEC }));
  }
  async conversation(conversationId) { return this.backend.range(K.conv(conversationId), 0, -1); }
  async conversations({ customerId, limit = 50 } = {}) {
    if (customerId) {
      const ids = await this.backend.range(K.custConvs(customerId), -limit, -1);
      return ids.reverse().map((conversationId) => ({ conversationId, customerId }));
    }
    return (await this.backend.range(K.convIndex, -limit, -1)).reverse();
  }

  // ---- customers ----
  customer(customerId) {
    if (!this.customers.has(customerId) && this.backend.getSync) this.customers.set(customerId, this.backend.getSync(K.customer(customerId)));
    return this.customers.get(customerId) || null;
  }

  saveCustomer(customerId, patch) {
    const rec = { ...(this.customer(customerId) || {}), ...patch, updatedAt: new Date().toISOString() };
    this.customers.set(customerId, rec);
    this.write('customer', () => this.backend.set(K.customer(customerId), rec));
    return rec;
  }

  forgetCustomer(customerId) {
    this.customers.set(customerId, null);
    this.write('customer.forget', () => this.backend.del(K.customer(customerId)));
  }

  // ---- orders ----
  async nextOrderNumber() { return 1000 + (await this.backend.incr(K.orderCounter)); }
  saveOrder(order) { return this.write('order', () => this.backend.push(K.orders, order)); }
  async orders(limit = 200) { return this.backend.range(K.orders, -limit, -1); }
}

function newSession(customerId) {
  const now = new Date();
  return {
    customerId,
    conversationId: newConversationId(now),
    startedAt: now.toISOString(),
    history: [], // LLM conversation (provider-neutral format)
    service: null, // 'delivery' | 'takeaway'
    cart: [],
    details: { name: null, address: null, zone: null, deliveryFee: 0, pickupTime: null, payment: null, notes: null },
    summaryHash: null, // set when the order summary is shown; confirm only if cart unchanged since
    status: 'open',
    out: { images: [], links: [], choices: null, listTitle: null }, // rich content for the current reply (not stored)
    lastChoices: null, // buttons shown in the previous reply (so "2" can mean the 2nd button)
    lastSeen: now.getTime(),
  };
}

// earlier versions kept all customers in one customers.json — move them to one record per customer
function migrateOldFiles(dir, backend) {
  const old = path.join(dir, 'customers.json');
  try {
    if (fs.existsSync(old)) {
      const all = JSON.parse(fs.readFileSync(old, 'utf8'));
      for (const [id, rec] of Object.entries(all)) if (!backend.getSync(K.customer(id))) backend.set(K.customer(id), rec);
      fs.renameSync(old, old + '.migrated');
    }
    if (backend.getSync(K.orderCounter) == null) {
      const n = backend.rangeSync(K.orders, 0, -1).length;
      if (n) backend.set(K.orderCounter, n);
    }
  } catch (e) {
    tel.log('storage.migrate_failed', { message: e.message }, 'warn');
  }
}

module.exports = { Store, newConversationId };
