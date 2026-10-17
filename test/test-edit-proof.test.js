import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { gate } from '../src/gate.js';
import { reviewSpend } from '../src/run.js';
import { testShape } from '../src/scan.js';
import { commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

// Fixture sources are built from parts: a line that starts with a test call, or a skip marker, in this file would
// read as a test title (REQ-TRACE-1) or a skip (REQ-GATE-6).
const SKIP = 'skip';
const src = (...lines) => `${lines.join('\n')}\n`;
const HEAD = ["import assert from 'node:assert';", "import { it } from 'node:test';", "import { add } from '../src/add.js';"];
const BUGGY = { 'src/add.js': 'export const add = (a, b) => a - b;\n' };
const FIXED = { 'src/add.js': 'export const add = (a, b) => a + b;\n' };
// On base, add(5, 3) is 2 and the test pins that; the fix makes it 8, so the test must change with it.
const OLD_TEST = src(...HEAD, "it('adds', () => {", '  assert.strictEqual(add(5, 3), 2);', '  assert.ok(add(0, 0) === 0);', '});');
const NEW_TEST = src(...HEAD, "it('adds', () => {", '  assert.strictEqual(add(5, 3), 8);', '  assert.ok(add(0, 0) === 0);', '});');
const FILES_COMMAND = 'for f in {files}; do node "$f" || exit 1; done';
const card = (kind = 'bug') => ({
  id: 'c1',
  kind,
  size: 'S',
  paths: [],
  allowEdits: [],
  acceptance: [],
  heldOut: null,
  text: '# c1\n\n- REQ-ADD-1: add shall sum.\n',
});

/** A reviewer tier of family `family` that answers the test-edit question with `answer` and logs each one. */
function reviewer(answer, family = 'codex') {
  const log = join(tmp('keel-te-'), 'asked');
  return {
    log,
    tier: {
      provider: 'exec',
      family,
      model: `exec-${family}`,
      effort: 'high',
      command: [
        'node',
        '-e',
        `const fs = require('fs'); const p = fs.readFileSync(0, 'utf8');
if (p.includes('changed existing test files')) { fs.appendFileSync(${JSON.stringify(log)}, p); console.log(${JSON.stringify(answer)}); }
else console.log('VERDICT: pass');
console.log(JSON.stringify({ is_error: false, total_cost_usd: 0.02, usage: { input_tokens: 5, output_tokens: 1 } }));`,
      ],
    },
  };
}
const asked = (r) => (existsSync(r.log) ? readFileSync(r.log, 'utf8') : '');

function setup(head, over = {}) {
  const { dir, base } = fixtureRepo({ ...BUGGY, 'test/add.test.js': OLD_TEST });
  commit(dir, { ...FIXED, ...head });
  const config = fixtureConfig({ testFilesCommand: FILES_COMMAND, ...over });
  return { dir, base, config };
}
const lockedWhy = (receipt) =>
  receipt.results.find((r) => r.name === 'locked').problems.find((p) => p.rule === 'existing-test-changed')?.why;

test('REQ-GATE-44 testShape counts tests by name and assertions, ignoring commented-out ones', () => {
  const shape = testShape(
    src(
      "it('a', () => {",
      '  assert.equal(1, 1);',
      '  // assert.equal(2, 2);',
      '  /* expect(x).toBe(1); */',
      '  expect(y).toBe(2);',
      '});',
      'it("b", () => {});',
      'def test_c():',
      '    assert x == 1',
      '    self.assertEqual(a, b)',
    ),
  );
  assert.deepEqual(shape.tests, ['a', 'b', 'test_c']);
  assert.equal(shape.assertions, 4);
  assert.equal(shape.skips, 0);
  assert.equal(testShape(src(`it.${SKIP}('a', () => {});`)).skips, 1);
});

test('REQ-GATE-44 an edited existing test that fails alone on base, keeps its tests and assertions, and is approved passes', () => {
  const r = reviewer('APPROVE: REQ-ADD-1 changes add(5, 3) from 2 to 8; the edit keeps both checks');
  const { dir, base, config } = setup({ 'test/add.test.js': NEW_TEST }, { review: true, tiers: [r.tier] });
  const receipt = gate({ repo: dir, base, card: card(), config, reviewer: r.tier });
  assert.equal(receipt.pass, true, JSON.stringify(receipt.results, null, 1));
  const locked = receipt.results.find((x) => x.name === 'locked');
  assert.deepEqual(locked.relaxed, [
    { path: 'test/add.test.js', rule: 'existing-test-changed', proof: 'pending test-edit-proof and test-edits' },
  ]);
  assert.deepEqual(receipt.results.find((x) => x.name === 'test-edit-proof').files, ['test/add.test.js']);
  const approval = receipt.results.find((x) => x.name === 'test-edits');
  assert.deepEqual(approval.approval, {
    approved: true,
    by: 'exec/exec-codex/high',
    reason: 'REQ-ADD-1 changes add(5, 3) from 2 to 8; the edit keeps both checks',
  });
  assert.match(asked(r), /assert\.strictEqual\(add\(5, 3\), 8\)/, 'the reviewer sees the test diff');
  assert.equal(approval.cost, 0.02);
});

test('REQ-GATE-44 a reviewer that says the edit weakens the test keeps it locked', () => {
  const r = reviewer('DENY: the expected value was changed to fit the code');
  const { dir, base, config } = setup({ 'test/add.test.js': NEW_TEST }, { review: true, tiers: [r.tier] });
  const receipt = gate({ repo: dir, base, card: card(), config, reviewer: r.tier });
  assert.equal(receipt.pass, false);
  const stage = receipt.results.find((x) => x.name === 'test-edits');
  assert.equal(stage.pass, false);
  assert.equal(stage.problems[0].rule, 'existing-test-changed');
  assert.match(stage.problems[0].why, /denied by exec\/exec-codex\/high: the expected value was changed/);
  assert.equal(
    receipt.results.some((x) => x.name === 'review'),
    false,
  );
});

test('REQ-GATE-44 only the reviewer family may approve: a same-family fallback answer does not count', () => {
  const silent = reviewer('no verdict here');
  const other = reviewer('APPROVE: fine', 'claude');
  const { dir, base, config } = setup({ 'test/add.test.js': NEW_TEST }, { review: true, tiers: [other.tier, silent.tier] });
  const receipt = gate({ repo: dir, base, card: card(), config, reviewer: silent.tier });
  assert.equal(receipt.pass, false);
  assert.match(receipt.results.find((x) => x.name === 'test-edits').problems[0].why, /no exec-codex|no approval/);
  assert.equal(asked(other), '');
});

test('REQ-GATE-44 a deleted assertion, a commented-out assertion, a deleted test, or a skipped test stays locked before any review', () => {
  const r = reviewer('APPROVE: fine');
  const cases = {
    'assertion deleted': src(...HEAD, "it('adds', () => {", '  assert.strictEqual(add(5, 3), 8);', '});'),
    'assertion commented out': src(
      ...HEAD,
      "it('adds', () => {",
      '  assert.strictEqual(add(5, 3), 8);',
      '  // assert.ok(add(0, 0) === 0);',
      '});',
    ),
    'test deleted': src(...HEAD, "it('sums', () => {", '  assert.strictEqual(add(5, 3), 8);', '  assert.ok(add(0, 0) === 0);', '});'),
    'test skipped': src(
      ...HEAD,
      `it.${SKIP}('adds', () => {`,
      '  assert.strictEqual(add(5, 3), 8);',
      '  assert.ok(add(0, 0) === 0);',
      '});',
    ),
  };
  for (const [name, text] of Object.entries(cases)) {
    const { dir, base, config } = setup({ 'test/add.test.js': text }, { review: true, tiers: [r.tier] });
    const receipt = gate({ repo: dir, base, card: card(), config, reviewer: r.tier });
    assert.equal(receipt.pass, false, name);
    assert.match(lockedWhy(receipt) ?? '', /assertions|test removed|skip/, name);
  }
  assert.equal(asked(r), '', 'no reviewer was asked');
});

test('REQ-GATE-44 an edited test that passes alone on base stays locked, even when a new test proves the fix', () => {
  const r = reviewer('APPROVE: fine');
  // Two assertions, same test name, passes on base and head: nothing shows the edit was needed.
  const loose = src(...HEAD, "it('adds', () => {", '  assert.strictEqual(add(5, 3) * 0, 0);', '  assert.ok(add(0, 0) === 0);', '});');
  const sum = src(...HEAD, "it('sums', () => assert.strictEqual(add(2, 3), 5));");
  const { dir, base, config } = setup({ 'test/add.test.js': loose, 'test/sum.test.js': sum }, { review: true, tiers: [r.tier] });
  const receipt = gate({ repo: dir, base, card: card(), config, reviewer: r.tier });
  assert.equal(receipt.pass, false);
  assert.equal(receipt.results.find((x) => x.name === 'red-proof').pass, true);
  const proof = receipt.results.find((x) => x.name === 'test-edit-proof');
  assert.equal(proof.pass, false);
  assert.deepEqual(
    proof.problems.map((p) => [p.rule, p.path]),
    [['existing-test-changed', 'test/add.test.js']],
  );
  assert.match(proof.problems[0].why, /passes alone on base/);
  assert.equal(asked(r), '');
});

test('REQ-GATE-44 without testFilesCommand, on a chore card, or with no reviewer, an edited test stays locked', () => {
  const r = reviewer('APPROVE: fine');
  const noFiles = setup({ 'test/add.test.js': NEW_TEST }, { testFilesCommand: null, review: true, tiers: [r.tier] });
  assert.match(
    lockedWhy(gate({ repo: noFiles.dir, base: noFiles.base, card: card(), config: noFiles.config, reviewer: r.tier })),
    /testFilesCommand/,
  );
  const chore = setup({ 'test/add.test.js': NEW_TEST }, { review: true, tiers: [r.tier] });
  assert.match(
    lockedWhy(gate({ repo: chore.dir, base: chore.base, card: card('chore'), config: chore.config, reviewer: r.tier })),
    /bug or feature/,
  );
  const off = setup({ 'test/add.test.js': NEW_TEST }, { approveAllowEdits: false });
  assert.match(lockedWhy(gate({ repo: off.dir, base: off.base, card: card(), config: off.config })), /approveAllowEdits/);
  const none = setup({ 'test/add.test.js': NEW_TEST });
  const receipt = gate({ repo: none.dir, base: none.base, card: card(), config: none.config, reviewer: null });
  assert.equal(receipt.pass, false);
  assert.match(receipt.results.find((x) => x.name === 'test-edits').problems[0].why, /no cross-family reviewer/);
});

test('REQ-GATE-44 the test-edit approval counts as review spend', () => {
  const spend = reviewSpend([
    { name: 'test-edits', pass: true, cost: 0.02, usage: { in: 5, out: 1, cached: 0 } },
    { name: 'review', pass: true, reviewer: 'x', cost: 0.1, usage: { in: 10, out: 2, cached: 1 } },
  ]);
  assert.ok(Math.abs(spend.reviewCost - 0.12) < 1e-9, String(spend.reviewCost));
  assert.deepEqual(spend.reviewUsage, { in: 15, out: 3, cached: 1 });
  assert.equal(spend.reviewer, 'x');
  assert.equal(reviewSpend([{ name: 'locked', pass: true }]), null);
});
