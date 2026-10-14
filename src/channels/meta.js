// Meta WhatsApp Cloud API — ready for when business verification is approved.
// Env (PLACEHOLDERS): META_VERIFY_TOKEN, META_ACCESS_TOKEN, META_PHONE_NUMBER_ID, PUBLIC_BASE_URL
// Setup: App dashboard -> WhatsApp -> Configuration -> Webhook URL https://<your-public-url>/webhook/meta,
//        verify token = META_VERIFY_TOKEN, subscribe to "messages".
// Rich replies: menu images = image messages; up to 3 choices = reply buttons; 4-10 = list message.
// (Interactive messages are free-form inside the 24h customer service window — no template needed.)

const GRAPH = 'https://graph.facebook.com/v21.0';
const tel = require('../telemetry');
const seen = new Set(); // Meta may deliver the same message twice
const cut = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));

function verifyMeta(query) {
  if (query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === process.env.META_VERIFY_TOKEN) {
    return { status: 200, type: 'text/plain', body: query['hub.challenge'] };
  }
  return { status: 403, type: 'text/plain', body: 'forbidden' };
}

async function post(payload) {
  const { META_ACCESS_TOKEN: token, META_PHONE_NUMBER_ID: phoneId } = process.env;
  if (!token || !phoneId) {
    tel.log('meta.send_skipped', { message: 'META_ACCESS_TOKEN / META_PHONE_NUMBER_ID not set', type: payload.type }, 'warn');
    return;
  }
  const t0 = Date.now();
  const res = await fetch(`${GRAPH}/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
  });
  tel.count(res.ok ? 'meta.sent' : 'meta.send_failed');
  if (!res.ok) tel.log('meta.send_failed', { status: res.status, type: payload.type, ms: Date.now() - t0, message: (await res.text()).slice(0, 300) }, 'error');
  else tel.log('meta.sent', { type: payload.type, ms: Date.now() - t0 }, 'debug');
}

// Converts the agent's reply into one or more WhatsApp messages.
function toMetaMessages(to, r) {
  const base = (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  const out = [];
  for (const img of r.images || []) {
    if (base) out.push({ to, type: 'image', image: { link: base + img } });
  }
  let body = r.reply;
  for (const l of r.links || []) body += `\n📄 התפריט המלא: ${base}${l}`;
  const choices = r.choices || [];

  if (choices.length >= 1 && choices.length <= 3 && body.length <= 1024) {
    out.push({
      to, type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body },
        action: { buttons: choices.map((c, i) => ({ type: 'reply', reply: { id: c.id || `t:${i + 1}`, title: cut(c.title, 20) } })) },
      },
    });
  } else if (choices.length >= 4 && body.length <= 1024) {
    out.push({
      to, type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: body },
        action: {
          button: cut(r.listTitle || 'בחירה', 20),
          sections: [{
            title: cut(r.listTitle || 'אפשרויות', 24),
            rows: choices.slice(0, 10).map((c, i) => ({
              id: c.id || `t:${i + 1}`,
              title: cut(c.title, 24),
              ...(c.description ? { description: cut(c.description, 72) } : {}),
            })),
          }],
        },
      },
    });
  } else {
    out.push({ to, type: 'text', text: { body } });
  }
  return out;
}

// -> { text, payload }  (button/list taps carry our payload id; "t:N" = plain-text choice)
function incoming(m) {
  if (m.type === 'text') return { text: m.text.body };
  if (m.type === 'interactive') {
    const r = m.interactive.button_reply || m.interactive.list_reply;
    if (!r) return null;
    return { text: r.title, payload: r.id && !r.id.startsWith('t:') ? r.id : null };
  }
  if (m.type === 'button') return { text: m.button.text };
  return null;
}

// Responds 200 immediately (Meta requires a fast ack), processes in the background.
function handleMeta(payload, agent) {
  const msgs = (payload.entry || []).flatMap((e) => (e.changes || []).flatMap((c) => c.value?.messages || []));
  for (const m of msgs) {
    if (seen.has(m.id)) { tel.log('meta.duplicate', { id: m.id }, 'debug'); continue; }
    seen.add(m.id);
    const inc = incoming(m);
    (async () => {
      if (!inc) tel.log('meta.unsupported_message', { messageType: m.type }, 'warn');
      const r = inc ? await agent.answer(`+${m.from}`, inc.text, inc.payload, { channel: 'meta' }) : { reply: 'כרגע אני מבין רק הודעות טקסט 🙏' };
      for (const msg of toMetaMessages(m.from, r)) await post(msg);
    })().catch((e) => tel.log('meta.handle_failed', { message: e.message, stack: e.stack }, 'error'));
  }
  return { status: 200, type: 'text/plain', body: 'ok' };
}

module.exports = { verifyMeta, handleMeta, toMetaMessages };
