import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseCard } from '../src/config.js';
import { readLedger } from '../src/ledger.js';
import { run } from '../src/run.js';
import { fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const BUILDER = `
const fs = require('fs');
const counter = process.argv[2];
const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
fs.writeFileSync(counter, String(n + 1));
fs.readFileSync(0, 'utf8');
if (n === 0) {
  fs.writeFileSync('src/add.js', 'export const add = (a, b) => a + b;\\n');
  fs.mkdirSync('test', { recursive: true });
  fs.writeFileSync('test/add.test.js', "import assert from 'node:assert';\\nimport { add } from '../src/add.js';\\nassert.strictEqual(add(2, 3), 5);\\n");
} else {
  const gitdir = fs.readFileSync('.git', 'utf8').replace('gitdir:', '').trim();
  fs.writeFileSync(gitdir + '/index.lock', '');
  fs.writeFileSync('KEEL_BLOCKED', 'cannot address the review finding\\n');
}
console.log('done');
console.log(JSON.stringify({
  is_error: false,
  total_cost_usd: 0.01,
  usage: { input_tokens: 10, output_tokens: 5 },
  session_id: 'session-1'
}));
`;

const REVIEWER = `
require('fs').readFileSync(0, 'utf8');
console.log('FINDING low src/add.js:1 negative sums are not tested\\nVERDICT: pass');
`;

test('REQ-RUN-37 a failed restoration records that the findings turn was not accepted', () => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
  const scripts = tmp('keel-scripts-');
  const builder = join(scripts, 'builder.cjs');
  const reviewer = join(scripts, 'reviewer.cjs');
  const counter = join(scripts, 'calls');
  writeFileSync(builder, BUILDER);
  writeFileSync(reviewer, REVIEWER);
  const config = fixtureConfig({
    review: true,
    learnStart: false,
    tiers: [
      { provider: 'exec', family: 'claude', model: 'builder', effort: 'high', command: ['node', builder, counter] },
      { provider: 'exec', family: 'codex', model: 'reviewer', effort: 'high', command: ['node', reviewer] },
    ],
  });
  const card = parseCard('# T-50: fix add\nkind: bug\nsize: S\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n');
  const { dir: repo } = fixtureRepo();

  assert.throws(() => run({ repo, card, config }), /index\.lock/);
  const row = readLedger().find((entry) => entry.role === 'fix-findings');
  assert.equal(row.outcome, 'restore-failed');
  assert.match(row.error, /^restore: .*index\.lock/s);
  assert.equal(row.workerStatus, 'ok', 'the corrective worker itself completed successfully');
  assert.equal(row.gatePass, false, 'the earlier passing receipt was not restored');
  assert.equal(row.attemptPass, false, 'an unrestored worktree is not accepted');
});
