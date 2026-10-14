// Twilio WhatsApp (Sandbox works without business verification).
// Setup: Twilio console -> Messaging -> Try it out -> WhatsApp sandbox ->
//        "When a message comes in": https://<your-public-url>/webhook/twilio  (POST)
// Replies are returned as TwiML, so no Twilio API key is needed for basic back-and-forth.
// Buttons: real WhatsApp buttons via Twilio need pre-made "Content Templates" — so here they are sent
//          as a numbered list; the customer can answer "1" / "2" (the agent maps the number back).
// Images: need PUBLIC_BASE_URL (your ngrok/cloudflared https address) so Twilio can fetch them.
// TODO (production): verify X-Twilio-Signature with TWILIO_AUTH_TOKEN.

const NUM = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

function toTwiml(r) {
  const base = (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  const msgs = [];
  for (const img of r.images || []) {
    if (base) msgs.push(`<Message><Media>${escapeXml(base + img)}</Media></Message>`);
  }
  let text = r.reply;
  if ((r.images || []).length && !base) text += `\n\nהתפריט: ${(r.images || []).length} עמודים (PUBLIC_BASE_URL לא מוגדר)`;
  for (const l of r.links || []) text += `\n📄 התפריט המלא: ${base}${l}`;
  if (r.choices && r.choices.length) text += '\n\n' + r.choices.map((c, i) => `${NUM[i]} ${c.title || c}`).join('\n') + '\n(שלחו מספר או כתבו חופשי)';
  msgs.push(`<Message>${escapeXml(text)}</Message>`);
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${msgs.join('')}</Response>`;
}

async function handleTwilio(params, agent) {
  const from = (params.From || '').replace(/^whatsapp:/, ''); // +9725...
  const text = params.ButtonText || params.Body || '';
  if (!from) return { status: 400, type: 'text/plain', body: 'missing From' };

  const r = text.trim() ? await agent.answer(from, text, null, { channel: 'twilio' }) : { reply: 'כרגע אני מבין רק הודעות טקסט 🙏' };
  return { status: 200, type: 'text/xml', body: toTwiml(r) };
}

module.exports = { handleTwilio, toTwiml };
