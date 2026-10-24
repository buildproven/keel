import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseCard } from '../src/config.js';
import { readLedger } from '../src/ledger.js';
import { run } from '../src/run.js';
import { fixtureConfig, fixtureRepo, tmp, unlockDir } from './helpers.js';

const BUILDER = `
const fs = require('fs');
const [calls, state] = process.argv.slice(2);
const n = fs.existsSync(calls) ? Number(fs.readFileSync(calls, 'utf8')) : 0;
fs.writeFileSync(calls, String(n + 1));
fs.readFileSync(0);
if (n === 0) {
  fs.writeFileSync('src/add.js', 'export const add = (a, b) => a + b;\\n');
  fs.mkdirSync('test', { recursive: true });
  fs.writeFileSync('test/add.test.js', "import assert from 'node:assert';\\nimport { add } from '../src/add.js';\\nassert.strictEqual(add(2, 3), 5);\\n");
} else {
  fs.writeFileSync('test/add-negative.test.js', "import assert from 'node:assert';\\nimport { add } from '../src/add.js';\\nassert.strictEqual(add(-2, -3), -5);\\n");
  // A mode does not stop root: there the dir is made immutable too (unlockDir undoes both).
  fs.chmodSync(state + '/receipts', 0o500);
  if (process.getuid?.() === 0) require('child_process').execFileSync('chattr', ['+i', state + '/receipts']);
}
console.log(JSON.stringify({
  result: 'done',
  session_id: 'builder-session',
  total_cost_usd: 0.02,
  usage: { input_tokens: 10, output_tokens: 5 }
}));
`;

const REVIEWER = `
const fs = require('fs');
const [calls] = process.argv.slice(2);
const n = fs.existsSync(calls) ? Number(fs.readFileSync(calls, 'utf8')) : 0;
fs.writeFileSync(calls, String(n + 1));
fs.readFileSync(0);
console.log(n === 0 ? 'FINDING low src/add.js:1 negative sums need a test\\nVERDICT: pass' : 'VERDICT: pass');
console.log(JSON.stringify({
  total_cost_usd: 0.03,
  usage: { input_tokens: 7, output_tokens: 3 }
}));
`;

test('REQ-RUN-38 a findings re-gate that throws after review records its time, review cost, and review usage', () => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
  const scripts = tmp('keel-scripts-');
  const builder = join(scripts, 'builder.js');
  const reviewer = join(scripts, 'reviewer.js');
  const builderCalls = join(scripts, 'builder-calls');
  const reviewerCalls = join(scripts, 'reviewer-calls');
  writeFileSync(builder, BUILDER);
  writeFileSync(reviewer, REVIEWER);
  const config = fixtureConfig({
    review: true,
    learnStart: false,
    tiers: [
      {
        provider: 'exec',
        family: 'claude',
        model: 'builder',
        effort: 'high',
        command: ['node', builder, builderCalls, process.env.KEEL_STATE_DIR],
      },
      { provider: 'exec', family: 'codex', model: 'reviewer', effort: 'high', command: ['node', reviewer, reviewerCalls] },
    ],
  });
  const card = parseCard(`# T-51: fix add\nkind: bug\nsize: S\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n`);
  const { dir: repo } = fixtureRepo();
  const receipts = join(process.env.KEEL_STATE_DIR, 'receipts');

  try {
    const result = run({ repo, card, config });
    assert.equal(result.pass, true, result.failure);
    assert.equal(Number(readFileSync(reviewerCalls, 'utf8')), 2, 'the failing persistence follows the second review');
    const row = readLedger().find((entry) => entry.role === 'fix-findings');
    assert.equal(row.outcome, 'reverted');
    assert.equal(typeof row.gateMs, 'number');
    assert.equal(row.reviewCost, 0.03);
    assert.deepEqual(row.reviewUsage, { in: 7, out: 3, cached: 0 });
  } finally {
    unlockDir(receipts);
  }
});
