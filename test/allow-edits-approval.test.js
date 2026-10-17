import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { parseCard } from '../src/config.js';
import { readLedger } from '../src/ledger.js';
import { learnedStart, run } from '../src/run.js';
import { fixtureConfig, fixtureRepo, g, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

const card = () => parseCard('# BUI-9: fix add\nkind: bug\nsize: S\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n');
const JSON_OUT = 'console.log(JSON.stringify({ is_error: false, total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } }));';

/** A builder that asks for allowEdits on `path` until Keel says it approved, then fixes add() and edits that test. */
const builder = (path) => ({
  provider: 'exec',
  family: 'claude',
  model: 'exec-build',
  effort: 'low',
  command: [
    'node',
    '-e',
    `const fs = require('fs'); const p = fs.readFileSync(0, 'utf8');
if (!p.includes('Keel approved allowEdits')) {
  fs.writeFileSync('KEEL_BLOCKED', 'The existing test asserts the old behavior.\\nallowEdits: ${path}\\n');
} else {
  fs.writeFileSync('src/add.js', 'export const add = (a, b) => a + b;\\n');
  fs.appendFileSync('test/basic.test.js', '// updated for REQ-ADD-1\\n');
  fs.writeFileSync('test/add.test.js', "import assert from 'node:assert';\\nimport { add } from '../src/add.js';\\nassert.strictEqual(add(2, 3), 5);\\n");
}
${JSON_OUT}`,
  ],
});

/** The other-family tier: answers an allowEdits request with `answer` (logging each request), and reviews with a pass. */
function approver(answer) {
  const log = join(tmp('keel-approve-'), 'asked');
  return {
    log,
    tier: {
      provider: 'exec',
      family: 'codex',
      model: 'exec-approve',
      effort: 'high',
      command: [
        'node',
        '-e',
        `const fs = require('fs'); const p = fs.readFileSync(0, 'utf8');
if (p.includes('asks to edit existing test files')) { fs.appendFileSync(${JSON.stringify(log)}, 'x'); console.log(${JSON.stringify(answer)}); }
else console.log('VERDICT: pass');`,
      ],
    },
  };
}
const asked = (a) => (existsSync(a.log) ? readFileSync(a.log, 'utf8').length : 0);

test('REQ-RUN-30 a builder blocked only for allowEdits on an existing test continues when the other family approves', () => {
  const { dir } = fixtureRepo();
  const a = approver('APPROVE: REQ-ADD-1 changes what add returns, so the old test is wrong');
  const r = run({ repo: dir, card: card(), config: fixtureConfig({ review: true, tiers: [builder('test/basic.test.js'), a.tier] }) });
  assert.equal(r.pass, true, r.failure);
  assert.equal(asked(a), 1);
  assert.deepEqual(r.approvedEdits, [
    { paths: ['test/basic.test.js'], by: 'exec/exec-approve/high', reason: 'REQ-ADD-1 changes what add returns, so the old test is wrong' },
  ]);
  assert.ok(readLedger().some((row) => row.allowEditsApproved?.paths?.[0] === 'test/basic.test.js'));
});

test('REQ-RUN-30 a denied request stops the run blocked, with the reason', () => {
  const { dir } = fixtureRepo();
  const a = approver('DENY: the card does not change what that test checks');
  const r = run({ repo: dir, card: card(), config: fixtureConfig({ review: true, tiers: [builder('test/basic.test.js'), a.tier] }) });
  assert.equal(r.stopped, 'blocked');
  assert.match(r.failure, /allowEdits denied by exec\/exec-approve\/high: the card does not change what that test checks/);
});

test('REQ-RUN-30 a request for a policy file or a non-test file is never offered for approval', () => {
  for (const path of ['keel.json', 'src/add.js']) {
    const { dir } = fixtureRepo();
    const a = approver('APPROVE: yes');
    const r = run({ repo: dir, card: card(), config: fixtureConfig({ review: true, tiers: [builder(path), a.tier] }) });
    assert.equal(r.stopped, 'blocked', path);
    assert.equal(asked(a), 0, path);
  }
});

test('REQ-RUN-30 with approveAllowEdits false, the request stops the run as before', () => {
  const { dir } = fixtureRepo();
  const a = approver('APPROVE: yes');
  const r = run({
    repo: dir,
    card: card(),
    config: fixtureConfig({ review: true, approveAllowEdits: false, tiers: [builder('test/basic.test.js'), a.tier] }),
  });
  assert.equal(r.stopped, 'blocked');
  assert.equal(asked(a), 0);
});

test('REQ-RUN-30 the approver runs in a scratch checkout, so a file it writes never reaches the build', () => {
  const { dir } = fixtureRepo();
  const a = approver('APPROVE: REQ-ADD-1 changes what add returns');
  a.tier.command[2] = `require('fs').writeFileSync('POISON.txt', 'x'); ${a.tier.command[2]}`;
  const r = run({ repo: dir, card: card(), config: fixtureConfig({ review: true, tiers: [builder('test/basic.test.js'), a.tier] }) });
  assert.equal(r.pass, true, r.failure);
  assert.equal(g(dir, 'ls-tree', '-r', '--name-only', r.branch).includes('POISON.txt'), false);
});

test('REQ-RUN-21 an approval attempt is not a failed first try', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) {
    const at = new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString();
    rows.push({ run: `r${i}`, repo: '/r', attempt: 1, tier: 0, cost: 0.1, workerStatus: 'approved', attemptPass: false, at });
    rows.push({ run: `r${i}`, repo: '/r', attempt: 2, tier: 0, cost: 0.1, workerStatus: 'ok', attemptPass: true, at });
    rows.push({ run: `s${i}`, repo: '/r', attempt: 1, tier: 1, cost: 0.3, workerStatus: 'ok', attemptPass: true, at, ruleTier: 1 });
  }
  assert.equal(learnedStart(rows, '/r', 0, fixtureConfig({ tiers: fixtureConfig().tiers })).tier, 0);
});
