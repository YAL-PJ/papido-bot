// Gemini provider (REST, no SDK). Env: GEMINI_API_KEY, GEMINI_MODEL.
// Converts the bot's neutral history <-> Gemini "contents".

const API = 'https://generativelanguage.googleapis.com/v1beta/models';
const tel = require('../telemetry');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Client-side rate limit so we don't hit the free-tier quota at all.
// GEMINI_RPM: requests per minute allowed (free tier: Flash-Lite 15, Flash 5). 0 = no limit.
function makeLimiter(rpm) {
  const times = [];
  return async function wait() {
    if (!rpm) return;
    for (;;) {
      const now = Date.now();
      while (times.length && now - times[0] >= 60_000) times.shift();
      if (times.length < rpm) { times.push(now); return; }
      await sleep(60_000 - (now - times[0]) + 50);
    }
  };
}

// "Please retry in 1.43s" / RetryInfo.retryDelay "2s" -> ms
function retryDelayMs(bodyText) {
  const m = bodyText.match(/retry in ([\d.]+)s/i) || bodyText.match(/"retryDelay":\s*"([\d.]+)s"/);
  return m ? Math.ceil(parseFloat(m[1]) * 1000) + 250 : null;
}

function toContents(history) {
  return history.map((m) => {
    if (m.role === 'user') return { role: 'user', parts: [{ text: m.text }] };
    if (m.role === 'assistant') {
      if (m.raw) return { role: 'model', parts: m.raw }; // keep original parts (thought signatures)
      const parts = [];
      if (m.text) parts.push({ text: m.text });
      for (const c of m.toolCalls || []) parts.push({ functionCall: { name: c.name, args: c.args } });
      return { role: 'model', parts };
    }
    // tool results
    return {
      role: 'user',
      parts: m.results.map((r) => ({ functionResponse: { name: r.name, response: { result: r.result } } })),
    };
  });
}

// GEMINI_FALLBACK_MODEL (optional): used when the main model is overloaded (503) — e.g. another free model.
function createGemini({ apiKey = process.env.GEMINI_API_KEY, model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite', fallbackModel = process.env.GEMINI_FALLBACK_MODEL || null } = {}) {
  if (!apiKey) {
    const { ENV_FILE } = require('../env');
    const fs = require('fs');
    throw new Error(fs.existsSync(ENV_FILE)
      ? `GEMINI_API_KEY ריק בקובץ ${ENV_FILE}. כתוב את המפתח אחרי הסימן = (בלי רווחים). מפתח: https://aistudio.google.com/apikey`
      : `לא נמצא קובץ ${ENV_FILE}. צור אותו מ-.env.example (Windows: copy .env.example .env) ומלא GEMINI_API_KEY.`);
  }

  const defaultRpm = /lite/.test(model) ? 14 : 5; // stay just under the free-tier limits
  const limit = makeLimiter(Number(process.env.GEMINI_RPM ?? defaultRpm));

  return {
    name: `gemini:${model}`,
    // opts: tools ([] = plain text), maxAttempts, timeoutMs (per HTTP call), purpose (for logs)
    async complete({ system, history, tools = [], maxAttempts = 5, timeoutMs = 60000, purpose = 'turn' }) {
      let useModel = model;
      const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents: toContents(history),
        ...(tools.length ? { tools: [{ functionDeclarations: tools }] } : {}),
        // Gemini 3.x: Google recommends keeping the default temperature (lower values can cause loops).
        // Thinking tokens count toward the output limit, so keep it roomy.
        generationConfig: /^gemini-[12]\./.test(model) ? { temperature: 0.3, maxOutputTokens: 2048 } : { maxOutputTokens: 4096 },
      };
      // retry on rate limit / overload (free tier hits 429 quickly — an order is several calls)
      let res;
      let errText = '';
      const tStart = Date.now();
      let overloaded = 0;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const tWait = Date.now();
        await limit();
        const waitedMs = Date.now() - tWait;
        if (waitedMs > 50) tel.log('llm.throttled', { model, waitedMs }, 'debug');
        const t0 = Date.now();
        try {
          res = await fetch(`${API}/${useModel}:generateContent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, // key in a header, never in URLs/logs
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (e) {
          tel.log('llm.network_error', { provider: 'gemini', model: useModel, purpose, attempt, ms: Date.now() - t0, message: e.message }, purpose === 'turn' ? 'error' : 'warn');
          tel.count('llm.errors');
          throw e;
        }
        tel.count('llm.calls');
        if (res.ok) break;
        errText = await res.text();
        tel.count(`llm.http_${res.status}`);
        const retryable = [429, 500, 502, 503, 504].includes(res.status) && !(res.status === 429 && /per day|PerDay/i.test(errText));
        const wait = retryable ? (res.status === 429 && retryDelayMs(errText)) || 1500 * 2 ** attempt : 0;
        const last = attempt >= maxAttempts - 1;
        tel.log('llm.http_error', {
          provider: 'gemini', model: useModel, purpose, attempt, status: res.status, ms: Date.now() - t0,
          message: errText.slice(0, 300), retrying: retryable && !last, retryInMs: wait,
        }, retryable && !last ? 'warn' : 'error');
        if (!retryable || last) break;
        // overloaded twice in a row → switch to the fallback model for the rest of this call
        if (res.status === 503 && ++overloaded >= 2 && fallbackModel && useModel !== fallbackModel) {
          tel.log('llm.fallback_model', { from: useModel, to: fallbackModel, purpose }, 'warn');
          useModel = fallbackModel;
          continue;
        }
        await sleep(wait);
      }
      if (!res.ok) { tel.count('llm.errors'); throw new Error(`Gemini ${res.status}: ${errText.slice(0, 500)}`); }
      const data = await res.json();
      const ms = Date.now() - tStart;
      tel.timing(purpose === 'turn' ? 'llm' : `llm.${purpose}`, ms);
      const cand = data.candidates?.[0];
      const parts = cand?.content?.parts || [];
      const usage = data.usageMetadata || {};
      tel.metrics.tokens.prompt += usage.promptTokenCount || 0;
      tel.metrics.tokens.output += usage.candidatesTokenCount || 0;
      tel.metrics.tokens.thoughts += usage.thoughtsTokenCount || 0;
      const out = {
        text: parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim(),
        toolCalls: parts.filter((p) => p.functionCall).map((p) => ({ name: p.functionCall.name, args: p.functionCall.args || {} })),
        raw: parts,
      };
      tel.log('llm.call', {
        provider: 'gemini', model: useModel, purpose, ms,
        historyMessages: history.length,
        tokens: { prompt: usage.promptTokenCount, output: usage.candidatesTokenCount, thoughts: usage.thoughtsTokenCount, total: usage.totalTokenCount },
        finishReason: cand?.finishReason,
        toolCalls: out.toolCalls.map((c) => c.name),
        text: tel.truncate(out.text, 500),
      }, 'debug');
      if (!data.candidates?.length) {
        tel.log('llm.empty', { model, promptFeedback: data.promptFeedback }, 'error');
        throw new Error(`Gemini: no candidates (${JSON.stringify(data.promptFeedback || {}).slice(0, 200)})`);
      }
      if (cand.finishReason && !['STOP', 'MAX_TOKENS'].includes(cand.finishReason)) {
        tel.log('llm.unusual_finish', { model, finishReason: cand.finishReason }, 'warn');
      }
      return out;
    },
  };
}

module.exports = { createGemini };
