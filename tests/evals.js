// Real-LLM evals: each case is a fresh customer. Run after every prompt/data change:
//   npm run evals            (needs an API key in .env)
// A case passes when the final reply matches every `must` and none of `mustNot`,
// and (optionally) the expected tool was called.

const fs = require('fs');
const os = require('os');
const path = require('path');
require('../src/env').loadEnv();


const { Menu } = require('../src/menu');
const { Business } = require('../src/business');
const { Store } = require('../src/store');
const { createLLM } = require('../src/llm');
const { createAgent } = require('../src/agent');

const CASES = [
  // --- info questions ---
  { name: 'hours', turns: ['עד מתי אתם פתוחים היום?'], must: [/\d{1,2}:\d{2}/] },
  { name: 'shabbat', turns: ['אתם פתוחים בשבת?'], must: [/שבת|מוצ/] },
  { name: 'kosher', turns: ['אתם כשרים?'], must: [/רובין/] },
  { name: 'meat', turns: ['יש לכם פיצה עם פפרוני?'], mustNot: [/פפרוני.{0,10}\d+₪/], must: [/חלבי|אין|לא/] },
  { name: 'gluten', turns: ['יש פיצה ללא גלוטן?'], must: [/אין|לא/] },
  { name: 'zone yes', turns: ['אתם מגיעים לרמות?'], must: [/25/] },
  { name: 'zone no', turns: ['מגיעים למבשרת?'], must: [/לא|איסוף/] },
  { name: 'min order', turns: ['מה המינימום למשלוח?'], must: [/60/] },
  { name: 'price both', turns: ['כמה עולה מרגריטה אישית?'], must: [/50/, /65/] },
  { name: 'size', turns: ['כמה אנשים אוכלים פיצה L?'], must: [/2|3|שניים|שלושה/] },
  { name: 'half-half', turns: ['אפשר חצי חצי?'], must: [/כן|אפשר/] },
  { name: 'english', turns: ['Do you deliver to Rehavia?'], must: [/deliver/i, /15/], mustNot: [/[א-ת]{3,}/] },
  { name: 'unknown → team', turns: ['יש לכם חניה לנכים?'], expectTool: 'handoff_to_human' },
  { name: 'late order', turns: ['הזמנתי לפני שעה ועוד לא הגיע'], expectTool: 'handoff_to_human' },
  { name: 'big event', turns: ['אני צריך 25 פיצות לבר מצווה ביום חמישי'], expectTool: 'handoff_to_human' },
  { name: 'off topic', turns: ['מי ינצח במונדיאל?'], mustNot: [/\d+₪/] },

  { name: 'menu as images', turns: ['איסוף', 'מה יש בתפריט?'], expectTool: 'send_menu' },
  { name: 'menu asks service first', turns: ['מה יש בתפריט?'], must: [/משלוח|איסוף/] },

  // --- ordering ---
  {
    name: 'asks service first',
    turns: ['אני רוצה להזמין'],
    must: [/משלוח|איסוף/],
  },
  {
    name: 'asks size when missing',
    turns: ['משלוח', 'מרגריטה אחת'],
    must: [/אישית|L|גודל/],
  },
  {
    name: 'full delivery order',
    turns: [
      'היי רוצה משלוח',
      '2 מרגריטה L ואחת גבינה אישית בלי מרינרה',
      'זהו',
      'יוסי כהן, הרב קוק 12 מרכז העיר קומה 2, מזומן',
      'מאשר',
    ],
    must: [/#\d{4}/],
    expectTool: 'confirm_order',
  },
  {
    name: 'below minimum',
    turns: ['משלוח', 'טבעות בצל אחד', 'זהו', 'דנה, עזה 3 רחביה, אשראי'],
    must: [/מינימום|חסר/],
  },
  {
    name: 'pickup order',
    turns: ['איסוף עצמי', 'פיצה סביח אישית ולחם שום', 'זה הכל', 'מיכל, ב-20:00, אשראי', 'כן'],
    expectTool: 'confirm_order',
  },
  {
    name: 'extra cheese edits the same pizza',
    turns: ['איסוף', 'פיצת שקשוקה L', 'אפשר עם תוספת גבינה?', 'זהו', 'משה, 17:00, אשראי'],
    // "אפשר עם…?" on an item in the cart is a request — the bot should add it, not ask again
    must: [/115/],
    mustNot: [/205/],
    expectTool: 'modify_cart_item',
  },
  {
    name: 'switch to pickup keeps the cart',
    turns: ['משלוח', 'מרגריטה L', 'זהו', 'אני בעצם אבוא לאסוף'],
    must: [/85/],
    mustNot: [/ריק|התאפס/],
    expectTool: 'set_service',
  },
  {
    name: 'no confirm without yes',
    turns: ['איסוף', 'פיצה גבינה אישית', 'זהו', 'רון, בהקדם, מזומן'],
    mustNotTool: 'confirm_order',
  },
];

async function run() {
  const tel = require('../src/telemetry');
  process.env.LOG_CONSOLE = process.env.LOG_CONSOLE || 'warn';
  const llm = createLLM();
  const only = process.argv[2];
  const started = Date.now();
  const results = [];
  for (const c of CASES.filter((x) => !only || x.name.includes(only))) {
    const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'papido-eval-')));
    const agent = createAgent({ llm, menu: new Menu(), business: new Business(), store, options: { ignoreHours: true } });
    const id = `+9725${Math.floor(Math.random() * 1e8)}`;
    const turns = [];
    const tools = [];
    let last = '';
    const t0 = Date.now();
    for (const t of c.turns) {
      const r = await agent.answer(id, t, null, { channel: 'eval' });
      last = r.reply;
      tools.push(...r.tools.map((x) => x.name));
      turns.push({ user: t, bot: r.reply, tools: r.tools.map((x) => ({ name: x.name, args: x.args, error: x.result?.error })), traceId: r.traceId, error: r.error });
    }
    const problems = [];
    for (const re of c.must || []) if (!re.test(last)) problems.push(`missing ${re}`);
    for (const re of c.mustNot || []) if (re.test(last)) problems.push(`should not match ${re}`);
    if (c.expectTool && !tools.includes(c.expectTool)) problems.push(`tool ${c.expectTool} not called`);
    if (c.mustNotTool && tools.includes(c.mustNotTool)) problems.push(`tool ${c.mustNotTool} should not be called`);
    const res = { name: c.name, pass: !problems.length, problems, ms: Date.now() - t0, turns };
    results.push(res);

    if (problems.length) {
      console.log(`❌ ${c.name}: ${problems.join('; ')}`);
      for (const t of turns) console.log(`  👤 ${t.user}\n  🤖 ${t.bot.replace(/\n/g, '\n     ')}   [${t.tools.map((x) => x.name).join(', ') || '—'}] ${t.traceId}`);
      console.log('');
    } else {
      console.log(`✅ ${c.name}  (${(res.ms / 1000).toFixed(1)}s)`);
    }
  }

  const pass = results.filter((r) => r.pass).length;
  const summary = {
    at: new Date().toISOString(), model: llm.name, durationSec: Math.round((Date.now() - started) / 1000),
    passed: pass, failed: results.length - pass, metrics: tel.snapshot(), results,
  };
  const dir = path.join(__dirname, '..', 'logs', 'evals');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${summary.at.replace(/[:.]/g, '-').slice(0, 19)}.json`);
  fs.writeFileSync(file, JSON.stringify(summary, null, 2));
  const tk = summary.metrics.tokens;
  console.log(`\n${pass} passed, ${results.length - pass} failed (${llm.name}) · ${summary.durationSec}s · model calls ${summary.metrics.counters['llm.calls'] || 0} · tokens ${tk.prompt + tk.output + tk.thoughts}`);
  console.log(`full report: ${path.relative(process.cwd(), file)}`);
  process.exit(results.length - pass ? 1 : 0);
}

run().catch((e) => { console.error(e.message); process.exit(1); });
