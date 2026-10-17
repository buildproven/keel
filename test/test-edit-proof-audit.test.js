import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { parseCard } from '../src/config.js';
import { gate } from '../src/gate.js';
import { reviewSpend, run } from '../src/run.js';
import { testShape } from '../src/scan.js';
import { commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

// Fixture sources are built from parts: a line that starts with a test call in this file would read as a test title
// (REQ-TRACE-1).
const src = (...lines) => `${lines.join('\n')}\n`;
const HEAD = ["import assert from 'node:assert';", "import { it } from 'node:test';", "import { add } from '../src/add.js';"];
const BUGGY = { 'src/add.js': 'export const add = (a, b) => a - b;\n' };
const FIXED = { 'src/add.js': 'export const add = (a, b) => a + b;\n' };
const OLD_TEST = src(...HEAD, "it('adds', () => {", '  assert.strictEqual(add(5, 3), 2);', '  assert.ok(add(0, 0) === 0);', '});');
const NEW_TEST = src(...HEAD, "it('adds', () => {", '  assert.strictEqual(add(5, 3), 8);', '  assert.ok(add(0, 0) === 0);', '});');
const FILES_COMMAND = 'for f in {files}; do node "$f" || exit 1; done';
const card = (over = {}) => ({
  id: 'c1',
  kind: 'bug',
  size: 'S',
  paths: [],
  allowEdits: [],
  acceptance: [],
  heldOut: null,
  text: '# c1\n\n- REQ-ADD-1: add shall sum.\n',
  ...over,
});

/** A reviewer tier that answers the test-edit question with `answer` and logs each one. */
function reviewer(answer) {
  const log = join(tmp('keel-te-'), 'asked');
  return {
    log,
    tier: {
      provider: 'exec',
      family: 'codex',
      model: 'exec-codex',
      effort: 'high',
      command: [
        'node',
        '-e',
        `const fs = require('fs'); const p = fs.readFileSync(0, 'utf8');
if (p.includes('changed existing test files')) { fs.appendFileSync(${JSON.stringify(log)}, p); console.log(${JSON.stringify(answer)}); }
else console.log('VERDICT: pass');
console.log(JSON.stringify({ is_error: false, usage: { input_tokens: 5, output_tokens: 1 } }));`,
      ],
    },
  };
}
const asked = (r) => (existsSync(r.log) ? readFileSync(r.log, 'utf8') : '');
const lockedWhy = (receipt) =>
  receipt.results.find((r) => r.name === 'locked').problems.find((p) => p.rule === 'existing-test-changed')?.why;

function setup(head, over = {}, baseFiles = { 'test/add.test.js': OLD_TEST }) {
  const { dir, base } = fixtureRepo({ ...BUGGY, ...baseFiles });
  commit(dir, { ...FIXED, ...head });
  return { dir, base, config: fixtureConfig({ testFilesCommand: FILES_COMMAND, ...over }) };
}

test('REQ-GATE-44 a test call or an assertion inside a string literal is text, not a test or an assertion', () => {
  const shape = testShape(
    src(
      'const a = "it(\'old\', () => {})";',
      "const b = 'assert.equal(1, 1)';",
      'const c = `expect(x).toBe(1)',
      'test("older", () => {})`;',
      "const url = 'http://example.com'; assert.ok(url);",
      "it('real', () => {",
      '  assert.ok(true);',
      '});',
      '"""',
      'def test_doc():',
      '    assert x',
      '"""',
    ),
  );
  assert.deepEqual(shape.tests, ['real']);
  assert.equal(shape.assertions, 2);
  const r = reviewer('APPROVE: fine');
  const cases = {
    'assertion moved into a string': [
      /assertions/,
      src(...HEAD, "it('adds', () => {", '  assert.strictEqual(add(5, 3), 8);', "  'assert.ok(add(0, 0) === 0);';", '});'),
    ],
    'test replaced by its name in a string': [
      /test removed/,
      src(
        ...HEAD,
        'const old = "it(\'adds\', () => {})";',
        "it('sums', () => {",
        '  assert.strictEqual(add(5, 3), 8);',
        '  assert.ok(true);',
        '});',
      ),
    ],
  };
  for (const [name, [why, text]] of Object.entries(cases)) {
    const { dir, base, config } = setup({ 'test/add.test.js': text }, { review: true, tiers: [r.tier] });
    const receipt = gate({ repo: dir, base, card: card(), config, reviewer: r.tier });
    assert.equal(receipt.pass, false, name);
    assert.match(lockedWhy(receipt) ?? '', why, name);
  }
  assert.equal(asked(r), '', 'no reviewer was asked');
});

test('REQ-GATE-44 each edited test is overlaid on base alone, so another edited test cannot make it fail there', () => {
  // test/a.test.js imports test/b.test.js. The head b.test.js imports `sum`, which only head has, so with both edits on
  // base a.test.js fails; alone on base it passes, so nothing shows the change needs its edit.
  const baseFiles = {
    'test/b.test.js': src(...HEAD, 'export const two = 2;', "it('b', () => {", '  assert.strictEqual(add(1, 1), 0);', '});'),
    'test/a.test.js': src(
      ...HEAD.slice(0, 2),
      "import { two } from './b.test.js';",
      "it('a', () => {",
      '  assert.strictEqual(two, 2);',
      '});',
    ),
  };
  const head = {
    'src/add.js': 'export const add = (a, b) => a + b;\nexport const sum = add;\n',
    'test/b.test.js': src(
      ...HEAD.slice(0, 2),
      "import { add, sum } from '../src/add.js';",
      'export const two = 2;',
      "it('b', () => {",
      '  assert.strictEqual(sum(1, 1), 2);',
      '});',
    ),
    'test/a.test.js': src(
      ...HEAD.slice(0, 2),
      "import { two } from './b.test.js';",
      "it('a', () => {",
      '  assert.strictEqual(two, 2);',
      '  assert.ok(two > 1);',
      '});',
    ),
  };
  const r = reviewer('APPROVE: fine');
  const { dir, base, config } = setup(head, { review: true, tiers: [r.tier] }, baseFiles);
  const receipt = gate({ repo: dir, base, card: card(), config, reviewer: r.tier });
  assert.equal(receipt.pass, false);
  const proof = receipt.results.find((x) => x.name === 'test-edit-proof');
  assert.deepEqual(
    proof.problems.map((p) => [p.path, p.why]),
    [['test/a.test.js', 'passes alone on base, so the change does not need the edit']],
  );
});

test('REQ-GATE-44 an allowEdits path the other family approved (REQ-RUN-30) is still proved; a human one is not', () => {
  const dropped = src(...HEAD, "it('adds', () => {", '  assert.strictEqual(add(5, 3), 8);', '});');
  const approved = card({ allowEdits: ['test/add.test.js'], approvedEdits: ['test/add.test.js'] });
  const shape = setup({ 'test/add.test.js': dropped }, { testFilesCommand: null });
  const locked = gate({ repo: shape.dir, base: shape.base, card: approved, config: shape.config });
  assert.equal(locked.pass, false);
  assert.match(lockedWhy(locked) ?? '', /assertions drop from 2 to 1/);
  const human = gate({ repo: shape.dir, base: shape.base, card: card({ allowEdits: ['test/add.test.js'] }), config: shape.config });
  assert.equal(human.pass, true, JSON.stringify(human.results, null, 1));
  // Kept shape, no testFilesCommand: the counts are the proof.
  const kept = setup({ 'test/add.test.js': NEW_TEST }, { testFilesCommand: null });
  const counted = gate({ repo: kept.dir, base: kept.base, card: approved, config: kept.config });
  assert.equal(counted.pass, true, JSON.stringify(counted.results, null, 1));
  assert.deepEqual(
    counted.results.find((x) => x.name === 'locked').relaxed?.map((x) => x.path),
    ['test/add.test.js'],
  );
  // With testFilesCommand, the per-file red proof and the cross-family verdict run too.
  const r = reviewer('DENY: the expected value was changed to fit the code');
  const full = setup({ 'test/add.test.js': NEW_TEST }, { review: true, tiers: [r.tier] });
  const denied = gate({ repo: full.dir, base: full.base, card: approved, config: full.config, reviewer: r.tier });
  assert.equal(denied.pass, false);
  assert.equal(denied.results.find((x) => x.name === 'test-edit-proof').pass, true);
  assert.match(denied.results.find((x) => x.name === 'test-edits').problems[0].why, /denied by exec\/exec-codex\/high/);
});

test('REQ-GATE-44 a run that approved allowEdits (REQ-RUN-30) gates the edit as approved, so a dropped assertion fails', () => {
  const { dir } = fixtureRepo();
  const builder = {
    provider: 'exec',
    family: 'claude',
    model: 'exec-build',
    effort: 'low',
    command: [
      'node',
      '-e',
      `const fs = require('fs'); const p = fs.readFileSync(0, 'utf8');
if (!p.includes('Keel approved allowEdits')) fs.writeFileSync('KEEL_BLOCKED', 'The old test pins the bug.\\nallowEdits: test/basic.test.js\\n');
else {
  fs.writeFileSync('src/add.js', 'export const add = (a, b) => a + b;\\n');
  fs.writeFileSync('test/basic.test.js', "import assert from 'node:assert';\\n");
  fs.writeFileSync('test/add.test.js', "import assert from 'node:assert';\\nimport { add } from '../src/add.js';\\nassert.strictEqual(add(2, 3), 5);\\n");
}
console.log(JSON.stringify({ is_error: false, total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } }));`,
    ],
  };
  const approver = {
    provider: 'exec',
    family: 'codex',
    model: 'exec-approve',
    effort: 'high',
    command: [
      'node',
      '-e',
      `const p = require('fs').readFileSync(0, 'utf8');
console.log(p.includes('asks to edit existing test files') ? 'APPROVE: REQ-ADD-1 makes the old test wrong' : 'VERDICT: pass');`,
    ],
  };
  const c = parseCard('# BUI-9: fix add\nkind: bug\nsize: S\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n');
  const r = run({ repo: dir, card: c, config: fixtureConfig({ review: true, maxAttempts: 2, tiers: [builder, approver] }) });
  assert.equal(r.pass, false, 'the approved edit dropped the only assertion of test/basic.test.js');
  assert.deepEqual(r.approvedEdits?.[0]?.paths, ['test/basic.test.js']);
});

test('REQ-GATE-44 the test-edit verdict names its reviewer in the review spend when no regular review ran (REQ-LED-13)', () => {
  const usage = { in: 5, out: 1, cached: 0 };
  const denied = { name: 'test-edits', pass: false, approval: { approved: false, by: 'exec/exec-codex/high', reason: 'x' }, usage };
  assert.equal(reviewSpend([denied]).reviewer, 'exec/exec-codex/high');
  const silent = reviewer('no verdict here');
  const { dir, base, config } = setup({ 'test/add.test.js': NEW_TEST }, { review: true, tiers: [silent.tier] });
  const receipt = gate({ repo: dir, base, card: card(), config, reviewer: silent.tier });
  const stage = receipt.results.find((x) => x.name === 'test-edits');
  assert.equal(stage.pass, false);
  assert.equal(
    receipt.results.some((x) => x.name === 'review'),
    false,
  );
  assert.equal(reviewSpend(receipt.results).reviewer, 'exec/exec-codex/high');
});
