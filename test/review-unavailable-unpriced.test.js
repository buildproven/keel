import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseCard } from '../src/config.js';
import { readLedger, report } from '../src/ledger.js';
import { approveEdits } from '../src/review.js';
import { run } from '../src/run.js';
import { fixtureConfig, fixtureRepo, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

const card = parseCard('# T-1: fix add\nkind: bug\nsize: S\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n');
const FAKE = fileURLToPath(new URL('./fake-worker.js', import.meta.url));
const builder = { provider: 'exec', family: 'claude', model: 'exec-good', effort: 'low', command: ['node', FAKE, 'good'] };
// A reviewer that gives no verdict and reports no usage: what it spent is unknown.
const silent = {
  provider: 'exec',
  family: 'codex',
  model: 'exec-silent',
  effort: 'high',
  command: ['node', '-e', `require('fs').readFileSync(0); console.log('no verdict')`],
};
const pricedFallback = {
  provider: 'exec',
  family: 'claude',
  model: 'exec-fallback',
  effort: 'high',
  priceInPerM: 4,
  priceOutPerM: 20,
  priceCachedPerM: 0.4,
  command: [
    'node',
    '-e',
    `require('fs').readFileSync(0); console.log('VERDICT: pass\\n' + JSON.stringify({ usage: { input_tokens: 3000, output_tokens: 200 } }))`,
  ],
};

test('REQ-LED-13 an unavailable reviewer with no usage makes the review cost a lower bound when a later fallback has a price', () => {
  const { dir } = fixtureRepo();
  const r = run({ repo: dir, card, config: fixtureConfig({ review: true, tiers: [builder, silent, pricedFallback] }) });
  assert.equal(r.pass, true, r.failure);
  const [row] = readLedger();
  assert.ok(Math.abs(row.reviewCost - (3000 * 4 + 200 * 20) / 1e6) < 1e-9, 'the priced fallback still counts');
  assert.deepEqual(row.reviewUsage, { in: 3000, out: 200, cached: 0 });
  assert.equal(row.reviewUnpriced, true, 'the first reviewer ran at an unknown cost, so the sum is a lower bound');
  assert.equal(report([row]).reviewUnpriced, 1);
});

test('REQ-LED-13 an allowEdits approver that gives no answer and no usage makes the approval cost a lower bound', () => {
  const { dir } = fixtureRepo();
  const approver = {
    ...pricedFallback,
    command: [
      'node',
      '-e',
      `require('fs').readFileSync(0); console.log('APPROVE: the card changes it\\n' + JSON.stringify({ usage: { input_tokens: 3000, output_tokens: 200 } }))`,
    ],
  };
  const config = fixtureConfig({ review: true, tiers: [approver, silent] });
  const r = approveEdits({ config, builder: approver, card, request: 'the test asserts the old sum', paths: ['test/a.test.js'], cwd: dir });
  assert.equal(r.approved, true);
  assert.equal(r.by, 'exec/exec-fallback/high');
  assert.ok(Math.abs(r.cost - (3000 * 4 + 200 * 20) / 1e6) < 1e-9, 'the priced approver still counts');
  assert.equal(r.unpriced, true, 'the first approver ran at an unknown cost');
});
