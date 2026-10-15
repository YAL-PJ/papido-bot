// server.js — demo web chat + WhatsApp webhooks. No dependencies (Node 18+).
//   npm start  ->  http://localhost:3000

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
require('./env').loadEnv();
const tel = require('./telemetry');
tel.installProcessHandlers();


const { Menu } = require('./menu');
const { Business } = require('./business');
const { Store } = require('./store');
const { createLLM } = require('./llm');
const { createAgent } = require('./agent');
const { describeLine, totals } = require('./tools');
const { ticketText } = require('./kitchen');
const { menuDocument } = require('./menu-page');
const { timeline } = require('./timeline');
const { handleTwilio } = require('./channels/twilio');
const { verifyMeta, handleMeta } = require('./channels/meta');

const menu = new Menu();
const business = new Business();
const store = new Store();
// on Redis, logs are kept there too (a free server's disk is wiped on restart)
const shipper = store.backend.name === 'redis' ? require('./log-shipper').createLogShipper(store.backend) : null;
const readLogs = (q) => (shipper ? shipper.read(q) : Promise.resolve(tel.readEvents(q)));
const llm = createLLM();
const agent = createAgent({ llm, menu, business, store });
// the long fixed part of what the model sees — logged once, so the timeline can show exactly what it was told
tel.log('prompt.loaded', { chars: agent.systemPrompt.length, hash: crypto.createHash('sha256').update(agent.systemPrompt).digest('hex').slice(0, 10), text: agent.systemPrompt });

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, '..', 'public');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function send(res, { status = 200, type = 'application/json', body }) {
  res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8` });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function sessionView(id) {
  const s = store.peek(id);
  const t = s ? totals(s, business) : { subtotal: 0 };
  return {
    conversationId: s?.conversationId || null,
    service: s?.service || null,
    cart: s ? s.cart.map((l) => ({ text: describeLine(l), total: l.total })) : [],
    subtotal: t.subtotal,
    details: s?.details || {},
    status: s?.status || 'new',
    customer: store.customer(id),
  };
}

// requests that poll often are not logged (they would drown everything else)
// /healthz: Render pings it every 5 s — 17k useless log lines a day
const QUIET = /^\/(healthz|timeline|api\/(orders|metrics|state|logs|conversations|timeline)|menu\/|favicon|monitor)/;

// Admin pages show customer data (names, addresses, conversations). On a public server set ADMIN_PASSWORD:
// the browser asks once (any user name + this password). The demo chat itself stays open.
const ADMIN = /^\/(monitor|timeline|api\/(logs|metrics|conversations|orders|timeline))(\/|$)/;
const same = (given, expected) => crypto.timingSafeEqual(
  crypto.createHash('sha256').update(String(given)).digest(), crypto.createHash('sha256').update(String(expected)).digest());
function adminAllowed(req) {
  const pass = process.env.ADMIN_PASSWORD;
  if (!pass) return true;
  // read-only key for remote log access (e.g. for Claude): GET only, revoke by changing LOGS_TOKEN
  const bearer = String(req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (bearer) return req.method === 'GET' && !!process.env.LOGS_TOKEN && same(bearer[1], process.env.LOGS_TOKEN);
  const m = String(req.headers.authorization || '').match(/^Basic (.+)$/);
  if (!m) return false;
  const given = Buffer.from(m[1], 'base64').toString('utf8').split(':').slice(1).join(':');
  return same(given, pass);
}

// The demo chat lets anyone type a "phone number". Those customers live under web:… so the demo can never
// read or reset a real WhatsApp customer (whatsapp:/twilio ids are the bare phone number).
const webId = (id) => (id ? `web:${String(id).replace(/[^\w+-]/g, '').slice(0, 32)}` : null);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const t0 = Date.now();
  res.on('finish', () => {
    tel.count(`http.${res.statusCode}`);
    if (!QUIET.test(url.pathname.slice(0)) || res.statusCode >= 400) {
      tel.log('http.request', { method: req.method, path: url.pathname, status: res.statusCode, ms: Date.now() - t0 }, res.statusCode >= 500 ? 'error' : 'debug');
    }
  });
  try {
    if (ADMIN.test(url.pathname) && !adminAllowed(req)) {
      // only the /monitor page opens the browser's login box; background API calls just get 401
      // (after logging in at /monitor the browser sends the password with them automatically)
      const challenge = ['/monitor', '/timeline'].includes(url.pathname) ? { 'WWW-Authenticate': 'Basic realm="papido-admin", charset="UTF-8"' } : {};
      res.writeHead(401, { ...challenge, 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('נדרשת סיסמת ניהול');
    }
    if (url.pathname === '/healthz') return send(res, { body: { ok: true, storage: store.backend.name, version: (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || null } });
    // ---- monitoring ----
    if (req.method === 'GET' && url.pathname === '/monitor') {
      return send(res, { type: 'text/html', body: fs.readFileSync(path.join(PUBLIC, 'monitor.html'), 'utf8') });
    }
    if (req.method === 'GET' && url.pathname === '/api/metrics') {
      return send(res, { body: { ...tel.snapshot(), llm: llm.name, orders: (await store.orders(10000)).length, storage: store.backend.name } });
    }
    if (req.method === 'GET' && url.pathname === '/api/logs') {
      const q = Object.fromEntries(url.searchParams);
      const events = await readLogs({
        date: q.date,
        limit: Math.min(Number(q.limit || 300), 5000),
        filter: (e) => (!q.trace || e.traceId === q.trace)
          && (!q.conversation || e.conversationId === q.conversation)
          && (!q.type || e.type.startsWith(q.type))
          && (!q.problems || ['warn', 'error'].includes(e.level))
          && (!q.since || e.ts >= q.since),
      });
      return send(res, { body: events });
    }

    // everything that happened, one readable line per action (whole day, one conversation or one message)
    if (req.method === 'GET' && url.pathname === '/timeline') {
      return send(res, { type: 'text/html', body: fs.readFileSync(path.join(PUBLIC, 'timeline.html'), 'utf8') });
    }
    if (req.method === 'GET' && url.pathname === '/api/timeline') {
      const q = Object.fromEntries(url.searchParams);
      const events = await readLogs({
        date: q.date,
        limit: Math.min(Number(q.limit || 2000), 10000),
        filter: (e) => (!q.trace || e.traceId === q.trace) && (!q.conversation || e.conversationId === q.conversation),
      });
      return send(res, { body: timeline(events, { noise: q.noise === '1' }) });
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, { type: 'text/html', body: fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8') });
    }

    // menu images (rendered by scripts/render-menu-images.js) and the same menu as a web page
    let m;
    if (req.method === 'GET' && (m = url.pathname.match(/^\/menu\/((?:delivery|takeaway)-\d+\.png)$/))) {
      const file = path.join(PUBLIC, 'menu', m[1]);
      if (!fs.existsSync(file)) return send(res, { status: 404, type: 'text/plain', body: 'menu image missing — run npm run menu-images' });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=300' });
      return res.end(fs.readFileSync(file));
    }
    if (req.method === 'GET' && (m = url.pathname.match(/^\/menu\/(delivery|takeaway)$/))) {
      return send(res, { type: 'text/html', body: menuDocument(menu, business, m[1]) });
    }

    if (req.method === 'POST' && url.pathname === '/api/chat') {
      const body = JSON.parse(await readBody(req));
      const { text, payload } = body;
      const customerId = webId(body.customerId);
      if (!customerId || (!text && !payload)) return send(res, { status: 400, body: { error: 'customerId and text/payload required' } });
      const r = await agent.answer(customerId, text, payload, { channel: 'web' });
      return send(res, { body: {
        reply: r.reply, images: r.images, links: r.links, choices: r.choices, listTitle: r.listTitle,
        tools: r.tools, state: sessionView(customerId), error: r.error, traceId: r.traceId, conversationId: r.conversationId,
      } });
    }

    if (req.method === 'POST' && url.pathname === '/api/reset') {
      const body = JSON.parse(await readBody(req));
      const customerId = webId(body.customerId);
      if (!customerId) return send(res, { status: 400, body: { error: 'customerId required' } });
      store.resetSession(customerId);
      if (body.forget) store.forgetCustomer(customerId);
      await store.flush();
      return send(res, { body: { ok: true } });
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      const id = webId(url.searchParams.get('customerId'));
      if (!id) return send(res, { status: 400, body: { error: 'customerId required' } });
      await store.load(id);
      return send(res, { body: sessionView(id) });
    }

    if (req.method === 'GET' && url.pathname === '/api/orders') {
      const orders = (await store.orders(30)).reverse().map((o) => ({ number: o.number, conversationId: o.conversationId, createdAt: o.createdAt, ticket: ticketText(o) }));
      return send(res, { body: orders });
    }

    // conversations: list (optionally of one customer) and one full transcript
    if (req.method === 'GET' && url.pathname === '/api/conversations') {
      const list = await store.conversations({ customerId: url.searchParams.get('customerId') || undefined, limit: Number(url.searchParams.get('limit')) || 50 });
      return send(res, { body: list.map((c) => ({ ...c, customerId: tel.pii(c.customerId) })) });
    }
    const convMatch = url.pathname.match(/^\/api\/conversations\/(c-[\w-]+)$/);
    if (req.method === 'GET' && convMatch) {
      return send(res, { body: await store.conversation(convMatch[1]) });
    }

    if (url.pathname === '/webhook/twilio' && req.method === 'POST') {
      const params = Object.fromEntries(new URLSearchParams(await readBody(req)));
      return send(res, await handleTwilio(params, agent));
    }

    if (url.pathname === '/webhook/meta') {
      if (req.method === 'GET') return send(res, verifyMeta(Object.fromEntries(url.searchParams)));
      if (req.method === 'POST') return send(res, handleMeta(JSON.parse(await readBody(req)), agent));
    }

    send(res, { status: 404, type: 'text/plain', body: 'not found' });
  } catch (e) {
    tel.log('http.exception', { method: req.method, path: url.pathname, message: e.message, stack: e.stack?.split('\n').slice(0, 5).join(' | ') }, 'error');
    send(res, { status: 500, body: { error: e.message } });
  }
});

server.listen(PORT, () => {
  tel.log('server.start', {
    message: `http://localhost:${PORT}`, port: Number(PORT), llm: llm.name, node: process.version,
    menuUpdated: menu.updated, logDir: tel.LOG_DIR, storage: store.backend.name, ignoreHours: process.env.DEMO_IGNORE_HOURS !== 'false',
  });
  console.log(`🍕 Papido bot on http://localhost:${PORT}  (LLM: ${llm.name}, storage: ${store.backend.name})  ·  monitor: http://localhost:${PORT}/monitor  ·  logs: ${tel.LOG_DIR}`);
});

// hosts stop the server with SIGTERM (deploy / sleep) — finish pending writes first
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    tel.log('server.stop', { signal: sig });
    try { await store.flush(); await shipper?.flush(); } catch {}
    process.exit(0);
  });
}
