// Runs the unit tests and keeps a copy of every run: logs/tests/<timestamp>.tap (+ junit.xml for CI tools)
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'logs', 'tests');
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const tap = path.join(dir, `${stamp}.tap`);
const junit = path.join(dir, `${stamp}.junit.xml`);

const r = spawnSync(process.execPath, [
  '--test',
  '--test-reporter=spec', '--test-reporter-destination=stdout',
  '--test-reporter=tap', `--test-reporter-destination=${tap}`,
  '--test-reporter=junit', `--test-reporter-destination=${junit}`,
  path.join(__dirname, '..', 'tests', 'core.test.js'),
], { stdio: 'inherit', env: { ...process.env, LOG_CONSOLE: 'silent' } });

console.log(`\nתוצאות נשמרו: ${path.relative(process.cwd(), tap)}`);
process.exit(r.status ?? 1);
