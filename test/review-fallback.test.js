import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS, parseCard } from '../src/config.js';
import { gate, stageLine } from '../src/gate.js';
import { fallbackReviewer } from '../src/review.js';
import { gateDescription, gateState } from '../src/status.js';
import { FIXED_SRC, REGRESSION_TEST, commit, fixtureConfig, fixtureRepo } from './helpers.js';

const card = () => parseCard('# T-1: test card\nkind: bug\nsize: S\n');
const tier = (family, model, script) => ({
  provider: 'exec',
  family,
  model,
  effort: 'high',
  command: ['node', '-e', `require('fs').readFileSync(0); ${script}`],
});
const down = tier('codex', 'exec-codex', '');
const passes = tier('claude', 'exec-claude', "console.log('VERDICT: pass')");
const blocks = tier('claude', 'exec-claude', "console.log('FINDING high src/add.js:1 wrong'); console.log('VERDICT: block')");

function setup() {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC });
  return { dir, base };
}
const review = (r) => r.results.find((x) => x.name === 'review');

test('REQ-GATE-22 when the reviewer is unavailable, the strongest tier of another family reviews instead and the receipt says so', () => {
  const { dir, base } = setup();
  const r = gate({ repo: dir, base, card: card(), config: fixtureConfig({ review: true, tiers: [passes, down] }), reviewer: down });
  assert.equal(r.pass, true, JSON.stringify(r.results));
  assert.equal(review(r).reviewer, 'exec/exec-claude/high');
  assert.deepEqual(review(r).fallback, { from: 'exec/exec-codex/high', status: 'no verdict' });
  assert.equal(gateState(r), 'success');
  assert.equal(gateDescription(r, { review: true }), 'passed; review by exec/exec-claude/high (fallback: exec/exec-codex/high no verdict)');
});

test('REQ-GATE-22 a fallback reviewer blocks like any reviewer', () => {
  const { dir, base } = setup();
  const r = gate({ repo: dir, base, card: card(), config: fixtureConfig({ review: true, tiers: [blocks, down] }), reviewer: down });
  assert.equal(r.pass, false);
  assert.equal(review(r).problems[0].rule, 'review-finding');
});

test('REQ-GATE-22 with reviewFallback false, or no tier of another family, an unavailable reviewer stays unavailable', () => {
  const { dir, base } = setup();
  const off = gate({
    repo: dir,
    base,
    card: card(),
    config: fixtureConfig({ review: true, reviewFallback: false, tiers: [passes, down] }),
    reviewer: down,
  });
  assert.equal(review(off).problems[0].rule, 'review-unavailable');
  const alone = gate({ repo: dir, base, card: card(), config: fixtureConfig({ review: true, tiers: [down] }), reviewer: down });
  assert.equal(review(alone).problems[0].rule, 'review-unavailable');
});

test('REQ-GATE-22 the fallback is the strongest tier whose family differs from the unavailable reviewer, and reviewFallback defaults on', () => {
  assert.equal(DEFAULTS.reviewFallback, true);
  const codex = DEFAULTS.tiers.find((t) => t.provider === 'codex');
  assert.equal(fallbackReviewer(DEFAULTS, codex).model, 'claude-opus-5-5');
  assert.equal(fallbackReviewer(DEFAULTS, DEFAULTS.tiers[1]).provider, 'codex');
});

test('REQ-GATE-22 the stage line names the fallback reviewer and why', () => {
  const line = stageLine({ name: 'review', pass: true, problems: [], reviewer: 'a/b/c', fallback: { from: 'x/y/z', status: 'quota' } });
  assert.equal(line, 'PASS review (fallback reviewer a/b/c; x/y/z quota)');
});

test('REQ-GATE-22 the review cost counts both the unavailable reviewer and the fallback', () => {
  const { dir, base } = setup();
  const priced = (cost) =>
    `console.log(JSON.stringify({ is_error: false, total_cost_usd: ${cost}, usage: { input_tokens: 1, output_tokens: 1 } }));`;
  const out = tier('codex', 'exec-codex', priced(0.02));
  const ok = tier('claude', 'exec-claude', `console.log('VERDICT: pass'); ${priced(0.03)}`);
  const r = gate({ repo: dir, base, card: card(), config: fixtureConfig({ review: true, tiers: [ok, out] }), reviewer: out });
  assert.equal(r.pass, true, JSON.stringify(r.results));
  assert.equal(Math.round(review(r).cost * 100), 5);
  const both = tier('claude', 'exec-claude', priced(0.04));
  const r2 = gate({ repo: dir, base, card: card(), config: fixtureConfig({ review: true, tiers: [both, out] }), reviewer: out });
  assert.equal(review(r2).problems[0].rule, 'review-unavailable');
  assert.equal(Math.round(review(r2).cost * 100), 6);
});
