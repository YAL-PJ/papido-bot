# Papido bot — instructions for Claude sessions

WhatsApp ordering & Q&A bot for "פיצה פפידו ירושלים" (dairy, kosher בד"ץ רובין). Owner: Yehuda (test client for his AI-implementation business).
He works in Hebrew, often from his phone. Wants small, testable increments and direct feedback.

## Live
- Server: https://papido-bot.onrender.com (Render free tier, auto-deploys from `main`; sleeps after ~15 min idle)
  - `/` demo chat · `/monitor` + `/timeline` (ADMIN_PASSWORD; `/timeline` = every action as one Hebrew line: customer, code routing, state sent to Gemini, Gemini's tool calls+args, tool results, reply composition, final reply) · `/healthz` → `{storage, version}` (version = deployed commit)
- Storage + logs: Upstash Redis (env UPSTASH_REDIS_REST_URL/TOKEN). Logs survive restarts.
- Remote read access (read-only): `PAPIDO_URL=https://papido-bot.onrender.com LOGS_TOKEN=<ask Yehuda> npm run remote -- chats|conv <id>|trace <msgId>|timeline [convId|msgId]|errors|metrics`
  Never commit the token. The shell can reach papido-bot.onrender.com directly; `POST /api/chat {customerId,text,payload}` works without auth (demo customers live under `web:`).
- Owner questionnaire (Claude Doc): "שאלות לבעלים — פיצה פפידו" — answers go into `data/business.json`.

## Rules that matter
- Prices, totals, dish/size resolution: always in code, never the model. The model passes dish *names* (`add_to_cart(name,size)`), `catalog.findDish` resolves; ambiguous → buttons.
- Taps (payloads) → `src/flow.js`, deterministic, no model. Short intents ("תפריט", "משלוח", allergy questions) are routed in code (`src/agent.js`).
- Allergy questions never go to the model (fixed answer from `business.allergens`). Unknown facts (`[לעדכן]`) → handoff, never guessed.
- Model replies pass `src/proofread.js` (guarded). Add confirmations are built in code.
- After every change: `npm test` (45 tests, no key needed). Real-model checks: `npm run evals` (needs GEMINI_API_KEY).
- Commit + push to `main`, then poll `/healthz` until `version` = new commit, then replay a conversation via `/api/chat`.

## Map
`src/agent.js` (routing, LLM loop, safety nets) · `src/flow.js` (click ordering) · `src/tools.js` (cart, details, summary, confirm, handoff)
`src/menu.js` + `src/catalog.js` (Tabit menu, merged sizes, findDish) · `src/prompt.js` (system prompt; per-service menu without ids)
`src/store.js` + `src/storage.js` (file | Redis; customerId=phone, conversationId c-YYMMDD-xxxxxx, messageId=traceId)
`docs/architecture.svg` (diagram, shown in README — update when the structure changes) · `src/telemetry.js` + `src/log-shipper.js` (JSONL + Redis) · `src/timeline.js` (event → readable line; add a case when adding a new log type) · `src/channels/{twilio,meta}.js` · `src/server.js`

## Known issues / next steps (as of 2026-10-15)
1. Latency 11–30 s per order message — Gemini free tier (3–6 s/call, 503s). Decide: paid Gemini or Claude Haiku (supported, LLM_PROVIDER=claude).
2. Data in `data/business.json` is mostly invented (`verified:false`, phone/address `[לעדכן]`) — fill from the owner's questionnaire.
3. Twilio WhatsApp sandbox: webhook `https://papido-bot.onrender.com/webhook/twilio` — not connected yet. Meta: needs business verification.
4. Handoff notifies nobody yet (placeholder in `tools.js` handoff_to_human) — add Telegram/WhatsApp to owner with transcript link.
5. Model sometimes completes dish names/sizes the customer didn't say (prompt tightened in fa23572 — verify live).
6. Tabit menu gaps: some L dishes exist only in delivery or only in pickup; Caprese L delivery 90₪ vs 117₪ — owner fixes in Tabit.
