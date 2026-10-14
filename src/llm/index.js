// Picks the LLM provider from env: LLM_PROVIDER=gemini (default) | claude
const { createGemini } = require('./gemini');
const { createClaude } = require('./claude');

function createLLM() {
  const p = (process.env.LLM_PROVIDER || 'gemini').toLowerCase();
  if (p === 'claude') return createClaude();
  return createGemini();
}

module.exports = { createLLM };
