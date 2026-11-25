import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { parseCard } from '../src/config.js';
import { failureExcerpts, gate } from '../src/gate.js';
import { commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

const card = parseCard('# T-1: test card\nkind: chore\nsize: S\n');

// One failing test with its error, then a long tail of passing lines, as a multi-folder runner prints it (BUI-2233).
const NOISY_SUITE = [
  "console.log('  ✘ fixture fails');",
  "console.log('    Error: expected 1 to be 2 at test/fixture.spec.mjs:140');",
  'for (let i = 1; i <= 400; i += 1) console.log(`  ✓ passing line ${i}`);',
  'process.exit(1);',
].join('\n');

function failingGate(suite = NOISY_SUITE, receiptDir = join(process.env.KEEL_STATE_DIR, 'receipts')) {
  // The suite is on base, so the candidate does not change a runner file (REQ-GATE-4).
  const { dir, base } = fixtureRepo({ 'suite.mjs': `${suite}\n` });
  commit(dir, { 'notes.md': 'a change\n' });
  const config = fixtureConfig({ checks: { test: 'node suite.mjs' }, testCommand: 'node suite.mjs' });
  const receipt = gate({ repo: dir, base, card, config, receiptDir });
  const stage = receipt.results.find((r) => r.name === 'test');
  assert.equal(stage?.pass, false, JSON.stringify(receipt.results));
  return { receipt, stage };
}

test('REQ-GATE-73 a failed test step prints the failing test and its error, though 400 passing lines follow it', () => {
  const { stage } = failingGate();
  assert.match(stage.output, /✘ fixture fails/);
  assert.match(stage.output, /Error: expected 1 to be 2 at test\/fixture\.spec\.mjs:140/);
  // The excerpt comes before the tail, which still ends the output as before.
  assert.ok(stage.output.indexOf('✘ fixture fails') < stage.output.indexOf('passing line 400'), stage.output);
  assert.doesNotMatch(stage.output, /passing line 20\n/, 'only 15 lines after a failure are excerpted');
});

test('REQ-GATE-73 each failure mark is excerpted once, with overlapping excerpts merged', () => {
  const suite = [
    "for (const l of ['not ok 1 - first', 'FAILED tests/a.py::t', 'FAIL  src/b.test.ts > b', '✖ node fails', 'plain']) console.log(l);",
    'for (let i = 1; i <= 300; i += 1) console.log(`ok ${i}`);',
    'process.exit(1);',
  ].join('\n');
  const { stage } = failingGate(suite);
  for (const mark of ['not ok 1 - first', 'FAILED tests/a.py::t', 'FAIL  src/b.test.ts > b', '✖ node fails']) {
    assert.equal(stage.output.split('\n').filter((l) => l === mark).length, 1, `${mark}\n${stage.output}`);
  }
});

test('REQ-GATE-73 a test step that fails with no failure mark prints only the tail and the log path', () => {
  const { stage } = failingGate("console.log('boom'); process.exit(1);");
  assert.doesNotMatch(stage.output, /failing tests/);
  assert.match(stage.output, /boom/);
  assert.match(stage.output, /^keel: full test output: .+-test\.log$/m);
});

test('REQ-GATE-73 a passing test step saves no log and prints no excerpt', () => {
  const { dir, base } = fixtureRepo({ 'suite.mjs': "console.log('✘ a mark in a passing run');\n" });
  commit(dir, { 'notes.md': 'a change\n' });
  const config = fixtureConfig({ checks: { test: 'node suite.mjs' }, testCommand: 'node suite.mjs' });
  const stage = gate({ repo: dir, base, card, config, receiptDir: join(process.env.KEEL_STATE_DIR, 'receipts') }).results.find(
    (r) => r.name === 'test',
  );
  assert.equal(stage.pass, true, JSON.stringify(stage));
  assert.equal(stage.output, undefined, JSON.stringify(stage));
  assert.equal(stage.log, undefined);
});

test('REQ-GATE-74 a failed test step saves the full output under gates/<repo-key>/<head>-test.log and names it', () => {
  const { receipt, stage } = failingGate();
  const m = /^keel: full test output: (.+)$/m.exec(stage.output);
  assert.ok(m, stage.output);
  const path = m[1];
  assert.equal(stage.log, path);
  assert.ok(path.startsWith(join(process.env.KEEL_STATE_DIR, 'gates')), path);
  assert.ok(path.endsWith(`/${receipt.head}-test.log`), path);
  const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
  assert.equal(lines.length, 402);
  assert.equal(lines[0], '  ✘ fixture fails');
  assert.equal(lines.at(-1), '  ✓ passing line 400');
});

test('REQ-GATE-74 when the log cannot be written the gate says so and still fails the test step', () => {
  writeFileSync(join(process.env.KEEL_STATE_DIR, 'gates'), 'a file where the log directory goes');
  const { stage } = failingGate();
  assert.match(stage.output, /^keel: full test output not saved: /m);
  assert.match(stage.output, /✘ fixture fails/);
  assert.equal(stage.log, undefined);
});

test('REQ-GATE-74 a gate given no receipt dir writes no log, as it writes no receipt', () => {
  const { stage } = failingGate(NOISY_SUITE, null);
  assert.match(stage.output, /✘ fixture fails/);
  assert.doesNotMatch(stage.output, /full test output/);
  assert.equal(stage.log, undefined);
  assert.equal(existsSync(join(process.env.KEEL_STATE_DIR, 'gates')), false);
});

test('REQ-GATE-73 the regression run of a bug card prints the failing test the same way', () => {
  const { dir, base } = fixtureRepo({ 'suite.mjs': `${NOISY_SUITE}\n` });
  commit(dir, { 'notes.md': 'a change\n' });
  const config = fixtureConfig({ checks: { lint: 'true' }, testCommand: 'node suite.mjs' });
  const bug = parseCard('# T-2: bug card\nkind: bug\nsize: S\n');
  const receiptDir = join(process.env.KEEL_STATE_DIR, 'receipts');
  const stage = gate({ repo: dir, base, card: bug, config, receiptDir }).results.find((r) => r.name === 'regression-on-head');
  assert.equal(stage?.pass, false);
  assert.match(stage.output, /✘ fixture fails/);
  assert.match(stage.output, /^keel: full test output: .+-test\.log$/m);
});

test('REQ-GATE-73 excerpts of very many failures are cut, with a pointer to the full output', () => {
  const out = Array.from({ length: 5000 }, (_, i) => `not ok ${i} - case ${i}`).join('\n');
  const text = failureExcerpts(out);
  assert.ok(text.length < 21000, String(text.length));
  assert.match(text, /^not ok 0 - case 0$/m);
  assert.match(text, /more failures cut; see the full test output$/);
  assert.equal(failureExcerpts('ok 1 - fine\nall good'), '');
});
