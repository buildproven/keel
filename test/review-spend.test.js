import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseCard } from '../src/config.js';
import { readLedger, report } from '../src/ledger.js';
import { run } from '../src/run.js';
import { addUsage } from '../src/workers.js';
import { formatValue, value, withReviewUsage } from '../src/value.js';
import { fixtureConfig, fixtureRepo, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);
const card = parseCard('# T-1: fix add\nkind: bug\nsize: S\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n');
const FAKE = fileURLToPath(new URL('./fake-worker.js', import.meta.url));
const builder = { provider: 'exec', family: 'claude', model: 'exec-good', effort: 'low', command: ['node', FAKE, 'good'] };
const reviewer = {
  provider: 'exec',
  family: 'codex',
  model: 'exec-reviewer',
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

test('REQ-LED-13 the attempt row records the review usage, priced from the reviewer tier when it reports no cost', () => {
  const { dir } = fixtureRepo();
  const r = run({ repo: dir, card, config: fixtureConfig({ review: true, tiers: [builder, reviewer] }) });
  assert.equal(r.pass, true, r.failure);
  const [row] = readLedger();
  assert.deepEqual(row.reviewUsage, { in: 3000, out: 200, cached: 0 });
  near(row.reviewCost, (3000 * 4 + 200 * 20) / 1e6);
});

const row = (over) => ({
  run: 'r1',
  card: 'A-1',
  attempt: 1,
  tier: 0,
  attemptPass: true,
  durationMs: 1,
  usage: { in: 1000, out: 500, cached: 0 },
  cost: 0.3,
  ...over,
});

test('REQ-LED-13 per finished card, builder and review tokens and cost are shown apart and summed', () => {
  const rows = [
    row({ reviewer: 'claude/claude-opus-5-5/high', reviewUsage: { in: 2000, out: 1000, cached: 0 }, reviewCost: 0.1 }),
    // An older Codex review: no cost recorded, so it is priced by the reviewer its row names.
    row({
      run: 'r2',
      card: 'B-1',
      reviewer: 'codex/gpt-5.6-sol/high',
      reviewUsage: { in: 1_000_000, out: 0, cached: 0 },
      reviewCost: null,
    }),
  ];
  const r = report(rows);
  assert.equal(r.accepted, 2);
  assert.equal(r.tokensPerAccepted, 1500, 'builder only, as before');
  assert.equal(r.reviewTokensPerAccepted, (3000 + 1_000_000) / 2);
  near(r.builderCostPerAccepted, 0.3);
  near(r.reviewCostPerAccepted, (0.1 + 4) / 2);
  near(r.costPerAccepted, 0.3 + 2.05);
  assert.equal(r.reviewUnpriced, 0);
  const text = formatValue(value(rows));
  assert.match(text, /^Tokens per finished card: builder 1\.5k \+ review 502k = 503k$/m);
  assert.match(text, /^Cost per finished card: builder \$0\.30 \+ review \$2\.05 = \$2\.35$/m);
});

test('REQ-LED-13 a review with no usage and no cost is unpriced, and the cost is a lower bound', () => {
  const r = report([row({ reviewer: 'codex/unknown-model/high', reviewUsage: null, reviewCost: null })]);
  assert.equal(r.reviewUnpriced, 1);
  assert.match(
    formatValue(value([row({ reviewer: 'codex/unknown-model/high', reviewUsage: null, reviewCost: null })])),
    /^Cost per finished card: builder \$0\.30 \+ review ≥\$0\.00 = ≥\$0\.30$/m,
  );
});

test('REQ-LED-13 an older row without reviewUsage takes it from the gate receipts written during its gate time', () => {
  const receipts = join(process.env.KEEL_STATE_DIR, 'receipts');
  mkdirSync(receipts, { recursive: true });
  const at = Date.parse('2026-10-10T12:00:00Z');
  const receipt = (ms, usage) =>
    writeFileSync(
      join(receipts, `A-1-abc-${ms}.json`),
      JSON.stringify({ card: 'A-1', head: 'abc', results: [{ name: 'review', usage, reviewer: 'codex/gpt-5.6-sol/high' }] }),
    );
  receipt(at - 60_000, { in: 100, out: 10, cached: 0 }); // first gate of this attempt (a re-gate followed)
  receipt(at - 1_000, { in: 200, out: 20, cached: 5 });
  receipt(at - 3_600_000, { in: 9999, out: 0, cached: 0 }); // an earlier hand gate of the same head: not this attempt
  const old = row({ head: 'abc', gateMs: 120_000, reviewer: 'codex/gpt-5.6-sol/high', reviewCost: null, at: new Date(at).toISOString() });
  const [filled] = withReviewUsage([old]);
  assert.deepEqual(filled.reviewUsage, { in: 300, out: 30, cached: 5 });
  const [kept] = withReviewUsage([{ ...old, reviewUsage: { in: 1, out: 1, cached: 0 } }]);
  assert.deepEqual(kept.reviewUsage, { in: 1, out: 1, cached: 0 }, 'a recorded reviewUsage wins');
  const [named] = withReviewUsage([{ ...old, reviewer: undefined }]);
  assert.equal(named.reviewer, 'codex/gpt-5.6-sol/high', 'a row older still takes the reviewer from the receipt');
  assert.deepEqual(named.reviewUsage, { in: 300, out: 30, cached: 5 });
  receipt(at - 7_200_000 + 1, undefined); // a receipt from before reviews recorded usage
  const early = { ...old, at: new Date(at - 7_200_000 + 2).toISOString(), reviewer: undefined };
  const [unknown] = withReviewUsage([early]);
  assert.equal(unknown.reviewer, 'codex/gpt-5.6-sol/high');
  assert.equal(unknown.reviewUsage, undefined);
  assert.equal(report([unknown]).reviewUnpriced, 1, 'a review that ran with no usage is unpriced, not free');
});

test('REQ-LED-13 the usage of several reviewers sums with cache writes kept', () => {
  assert.deepEqual(addUsage({ in: 1, cacheWrite: 10, out: 2, cached: 3 }, { in: 4, out: 5, cached: 6 }), {
    in: 5,
    cacheWrite: 10,
    out: 7,
    cached: 9,
  });
  assert.deepEqual(addUsage(null, { in: 1, out: 1, cached: 0 }), { in: 1, out: 1, cached: 0 });
  assert.equal(addUsage(null, null), null);
});

test('REQ-LED-13 a reviewer that spent tokens at no known price makes the review cost a lower bound, keeping the priced part', () => {
  const { dir } = fixtureRepo();
  const unpricedOut = {
    provider: 'exec',
    family: 'codex',
    model: 'exec-unpriced',
    effort: 'high',
    command: [
      'node',
      '-e',
      `require('fs').readFileSync(0); console.log(JSON.stringify({ usage: { input_tokens: 500, output_tokens: 5 } }))`,
    ],
  };
  const pricedFallback = { ...reviewer, family: 'claude', model: 'exec-fallback' };
  const config = fixtureConfig({ review: true, tiers: [builder, unpricedOut, pricedFallback] });
  const r = run({ repo: dir, card, config });
  assert.equal(r.pass, true, r.failure);
  const [row] = readLedger();
  near(row.reviewCost, (3000 * 4 + 200 * 20) / 1e6, 'the priced fallback still counts toward the card budget');
  assert.equal(row.reviewUnpriced, true, 'the first reviewer gave no verdict and had no price');
  assert.deepEqual(row.reviewUsage, { in: 3500, out: 205, cached: 0 });
  assert.equal(report([row]).reviewUnpriced, 1);
});
