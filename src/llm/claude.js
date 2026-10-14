// Claude provider (REST, no SDK). Env: ANTHROPIC_API_KEY, ANTHROPIC_MODEL.

const tel = require('../telemetry');

function toMessages(history) {
  return history.map((m) => {
    if (m.role === 'user') return { role: 'user', content: m.text };
    if (m.role === 'assistant') {
      const content = [];
      if (m.text) content.push({ type: 'text', text: m.text });
      for (const c of m.toolCalls || []) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
      return { role: 'assistant', content };
    }
    return {
      role: 'user',
      content: m.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: JSON.stringify(r.result) })),
    };
  });
}

function createClaude({ apiKey = process.env.ANTHROPIC_API_KEY, model = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5' } = {}) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY חסר ב-.env');
  return {
    name: `claude:${model}`,
    async complete({ system, history, tools }) {
      const t0 = Date.now();
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          system,
          messages: toMessages(history),
          tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
        }),
      });
      tel.count('llm.calls');
      if (!res.ok) {
        const t = await res.text();
        tel.count('llm.errors');
        tel.log('llm.http_error', { provider: 'claude', model, status: res.status, ms: Date.now() - t0, message: t.slice(0, 300) }, 'error');
        throw new Error(`Claude ${res.status}: ${t.slice(0, 500)}`);
      }
      const data = await res.json();
      const ms = Date.now() - t0;
      tel.timing('llm', ms);
      tel.metrics.tokens.prompt += data.usage?.input_tokens || 0;
      tel.metrics.tokens.output += data.usage?.output_tokens || 0;
      tel.log('llm.call', {
        provider: 'claude', model, ms, historyMessages: history.length,
        tokens: { prompt: data.usage?.input_tokens, output: data.usage?.output_tokens }, finishReason: data.stop_reason,
        toolCalls: data.content.filter((b) => b.type === 'tool_use').map((b) => b.name),
      }, 'debug');
      return {
        text: data.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim(),
        toolCalls: data.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input || {} })),
      };
    },
  };
}

module.exports = { createClaude };
