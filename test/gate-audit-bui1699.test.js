// BUI-1699: findings of the gate audit (src/gate.js), each with a test that fails on the code before the fix.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseCard } from '../src/config.js';
import { failingTests, gate, heldOutTestCommand, linkShared, proofFiles } from '../src/gate.js';
import { readLedger } from '../src/ledger.js';
import { cardFromIssue } from '../src/linear.js';
import { run } from '../src/run.js';
import { BUGGY, FIXED_SRC, commit, fixtureConfig, fixtureRepo, g, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

const card = (header = 'kind: bug\nsize: S') => parseCard(`# T-1: test card\n${header}\n`);
const rules = (receipt) => receipt.results.flatMap((r) => r.problems.map((p) => p.rule));
const proofOf = (receipt) => receipt.results.find((x) => x.name === 'red-proof');

const SUITE = 'for f in test/*.js; do echo "$f"; node "$f" || exit 1; done';
const FILES = 'for f in {files}; do node "$f" || exit 1; done';
// Fails on the buggy base add(), passes on the fixed one, and names its own path when it fails.
const RED_ON_BASE = "import assert from 'node:assert';\nimport { add } from '../src/add.js';\nassert.strictEqual(add(1, 1), 2);\n";
const FIXED_TEST = `${RED_ON_BASE}assert.strictEqual(add(2, 3), 5);\n`;
const PASSING_TEST = "import assert from 'node:assert';\nassert.ok(true);\n";

// ---------------------------------------------------------------------------------------------------------------------
// Audit #8: a test run's leftovers must not decide another edited test's result.

const src = (...lines) => `${lines.join('\n')}\n`;
const IMPORTS = ["import assert from 'node:assert';", "import { it } from 'node:test';", "import { add } from '../src/add.js';"];
const EDIT_BASE = (name) =>
  src(...IMPORTS, `it('${name}', () => {`, '  assert.strictEqual(add(5, 3), 2);', '  assert.ok(add(0, 0) === 0);', '});');

function approver() {
  const tier = {
    provider: 'exec',
    family: 'codex',
    model: 'exec-codex',
    effort: 'high',
    command: [
      'node',
      '-e',
      `const fs = require('fs'); const p = fs.readFileSync(0, 'utf8');
console.log(p.includes('changed existing test files') ? 'APPROVE: fine' : 'VERDICT: pass');
console.log(JSON.stringify({ is_error: false, usage: { input_tokens: 5, output_tokens: 1 } }));`,
    ],
  };
  return tier;
}

test('REQ-GATE-62 an untracked file one edited test leaves on base does not make the next edited test pass there', () => {
  // a.test.js writes marker.txt as it runs; b.test.js passes whenever marker.txt exists, and otherwise needs the fix.
  const base = { 'test/a.test.js': EDIT_BASE('a'), 'test/b.test.js': EDIT_BASE('b') };
  const head = {
    ...FIXED_SRC,
    'test/a.test.js': src(
      "import { writeFileSync } from 'node:fs';",
      ...IMPORTS,
      "it('a', () => {",
      "  writeFileSync('marker.txt', 'x');",
      '  assert.strictEqual(add(5, 3), 8);',
      '  assert.ok(add(0, 0) === 0);',
      '});',
    ),
    'test/b.test.js': src(
      "import { existsSync } from 'node:fs';",
      ...IMPORTS,
      "it('b', () => {",
      "  assert.strictEqual(existsSync('marker.txt') ? 8 : add(5, 3), 8);",
      '  assert.ok(add(0, 0) === 0);',
      '});',
    ),
  };
  const { dir, base: baseSha } = fixtureRepo({ ...BUGGY, 'test/basic.test.js': PASSING_TEST, ...base });
  commit(dir, head);
  const tier = approver();
  const config = fixtureConfig({ testFilesCommand: FILES, review: true, tiers: [tier] });
  const r = gate({ repo: dir, base: baseSha, card: card(), config, reviewer: tier });
  const proof = r.results.find((x) => x.name === 'test-edit-proof');
  assert.deepEqual(proof?.problems, [], JSON.stringify(r.results, null, 1));
});

// ---------------------------------------------------------------------------------------------------------------------
// Review: base-red-fixed skipped the overlay, so a new proof file was never shown to fail on base.

test('REQ-GATE-52 a base-red-fixed card with a new test that also passes on base fails the red proof', () => {
  const { dir, base } = fixtureRepo({ ...BUGGY, 'test/a.test.js': RED_ON_BASE });
  commit(dir, { ...FIXED_SRC, 'test/a.test.js': FIXED_TEST, 'test/new.test.js': PASSING_TEST });
  const config = fixtureConfig({ testCommand: SUITE, checks: { test: SUITE } });
  const r = gate({ repo: dir, base, card: card('kind: bug\nsize: S\nallowEdits: test/a.test.js'), config });
  assert.deepEqual(rules(r), ['test-passes-on-base'], JSON.stringify(r.results, null, 1));
  assert.deepEqual(proofOf(r).problems[0].files, ['test/new.test.js']);
});

test('REQ-GATE-52 a base-red-fixed card with a new test that fails on base passes, targeted or not', () => {
  for (const over of [{}, { testFilesCommand: FILES }]) {
    const { dir, base } = fixtureRepo({ ...BUGGY, 'test/a.test.js': RED_ON_BASE });
    const newTest = "import assert from 'node:assert';\nimport { add } from '../src/add.js';\nassert.strictEqual(add(4, 4), 8);\n";
    commit(dir, { ...FIXED_SRC, 'test/a.test.js': FIXED_TEST, 'test/new.test.js': newTest });
    const config = fixtureConfig({ testCommand: SUITE, checks: { test: SUITE }, ...over });
    const r = gate({ repo: dir, base, card: card('kind: bug\nsize: S\nallowEdits: test/a.test.js'), config });
    assert.equal(r.pass, true, JSON.stringify(r.results, null, 1));
    assert.deepEqual(proofOf(r).baseRedFixed, ['test/a.test.js']);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Audit #31: a targeted baseline may be red in a test file the card does not modify.

test('REQ-GATE-52 a targeted base baseline that also shows a test file the card does not modify failing is baseline-not-green', () => {
  const { dir, base } = fixtureRepo({ ...BUGGY, 'test/a.test.js': RED_ON_BASE, 'test/b.test.js': RED_ON_BASE });
  commit(dir, { ...FIXED_SRC, 'test/a.test.js': FIXED_TEST });
  // On base the files command fails and names both files, though it was given only test/a.test.js.
  const files = `grep -q "a - b" src/add.js && { echo FAIL {files} test/b.test.js; exit 1; }; ${FILES}`;
  const config = fixtureConfig({ testCommand: SUITE, checks: { test: SUITE }, testFilesCommand: files });
  const r = gate({ repo: dir, base, card: card('kind: bug\nsize: S\nallowEdits: test/a.test.js'), config });
  assert.deepEqual(proofOf(r).problems, [{ rule: 'baseline-not-green', files: ['test/a.test.js', 'test/b.test.js'] }]);
});

// ---------------------------------------------------------------------------------------------------------------------
// The "may not run them" hint is for a runner that was not given the files.

test('REQ-GATE-3 a targeted red proof whose new test passes on base gives no hint that the test command may not run it', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...FIXED_SRC, 'test/trivial.test.js': PASSING_TEST });
  const config = fixtureConfig({ testCommand: SUITE, checks: { test: SUITE }, testFilesCommand: FILES });
  const r = gate({ repo: dir, base, card: card(), config });
  assert.equal(r.results.find((x) => x.name === 'targeted-on-head')?.targeted, true);
  const problem = proofOf(r).problems[0];
  assert.equal(problem.rule, 'test-passes-on-base');
  assert.equal(problem.hint, undefined);
});

test('REQ-GATE-3 an untargeted red proof whose suite never names the new test keeps the hint', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...FIXED_SRC, 'test/trivial.test.js': PASSING_TEST });
  const r = gate({ repo: dir, base, card: card(), config: fixtureConfig() });
  assert.match(proofOf(r).problems[0].hint, /may not run them/);
});

// ---------------------------------------------------------------------------------------------------------------------
// Audit #28 and the vitest parser: timings, colour, and the FAIL summary line.

test('REQ-RUN-46 failing test names lose a bare trailing duration, so the same test matches across attempts', () => {
  const first = failingTests(' × suite > adds numbers 6ms\n × suite > other 1.5s\n');
  const second = failingTests(' × suite > adds numbers 12ms\n × suite > other 900ms\n');
  assert.deepEqual(first, ['suite > adds numbers', 'suite > other']);
  assert.deepEqual(second, first);
  assert.deepEqual(failingTests('✖ adds (12ms)\n'), ['adds'], 'the node:test form still works');
});

test('REQ-RUN-46 failing test names come from vitest FAIL summary lines, with colour codes removed', () => {
  const esc = String.fromCharCode(27);
  const out = [
    `${esc}[31m FAIL ${esc}[39m  test/add.test.ts > suite > adds numbers`,
    ' FAIL  test/add.test.ts > suite > other',
    ' FAIL  test/broken.test.ts',
    `${esc}[31m×${esc}[39m suite > third 3ms`,
    'failing tests:',
  ].join('\n');
  assert.deepEqual(failingTests(out).sort(), ['suite > adds numbers', 'suite > other', 'suite > third', 'test/broken.test.ts'].sort());
  assert.deepEqual(failingTests(`${esc}[1m${esc}[31mnot ok 1 - colored${esc}[0m`), ['colored']);
});

// ---------------------------------------------------------------------------------------------------------------------
// Audit #47: the sign-in outage of the first review stays on the receipt after the wait.

const clock = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

test('REQ-GATE-53 a sign-in outage in the first review stays on the receipt as IMPROVE after the wait and a good retry', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { 'docs/note.md': 'a note\n' });
  // The codex reviewer is out of quota until a flag file exists; its claude fallback cannot sign in, now and later.
  const flag = join(tmp('keel-flag-'), 'ran');
  const retry = clock(new Date(Date.now() + 120000));
  const codex = {
    provider: 'exec',
    family: 'codex',
    model: 'codex-once',
    effort: 'high',
    command: [
      'node',
      '-e',
      `const fs = require('fs'); fs.readFileSync(0);
if (!fs.existsSync(${JSON.stringify(flag)})) { fs.writeFileSync(${JSON.stringify(flag)}, ''); console.error('You have hit your usage limit. Try again at ${retry}.'); process.exit(1); }
console.log('VERDICT: pass');`,
    ],
  };
  const signedOut = {
    provider: 'exec',
    family: 'claude',
    model: 'claude-out',
    effort: 'high',
    command: ['node', '-e', "require('fs').readFileSync(0); console.log('Not logged in · Please run /login'); process.exit(1);"],
  };
  const slept = [];
  const r = gate({
    repo: dir,
    base,
    card: card('kind: chore\nsize: S'),
    config: fixtureConfig({ review: true, tiers: [codex, signedOut] }),
    reviewer: codex,
    waitReviewHours: 1,
    sleep: (ms) => slept.push(ms),
  });
  assert.equal(slept.length, 1, 'the gate did not wait for the reset');
  assert.equal(r.pass, true, JSON.stringify(r.results, null, 1));
  assert.equal(
    (r.improve ?? []).filter((l) => /^IMPROVE: reviewer exec\/claude-out\/high cannot sign in/.test(l)).length,
    1,
    `the sign-in outage of the first review is not on the receipt: ${JSON.stringify(r.improve)}`,
  );
});

// ---------------------------------------------------------------------------------------------------------------------
// Audit #62: a symlinked .git is not the main worktree's own directory.

test('REQ-GATE-48 a linked worktree whose .git is a symlink to its git directory still links the main worktree dirs', () => {
  const { dir: main } = fixtureRepo({ ...BUGGY, '.gitignore': 'node_modules/\n' });
  mkdirSync(join(main, 'node_modules'));
  writeFileSync(join(main, 'node_modules', 'pkg.txt'), 'x\n');
  const wt = join(tmp('keel-wt-'), 'agent');
  g(main, 'worktree', 'add', '-q', '-b', 'feat', wt);
  const gitdir = readFileSync(join(wt, '.git'), 'utf8')
    .replace(/^gitdir: /, '')
    .trim();
  rmSync(join(wt, '.git'));
  symlinkSync(gitdir, join(wt, '.git'));
  const co = tmp('keel-co-');
  linkShared(wt, co, ['node_modules']);
  assert.ok(existsSync(join(co, 'node_modules')), 'node_modules from the main worktree was not linked');
  assert.equal(realpathSync(readlinkSync(join(co, 'node_modules'))), realpathSync(join(main, 'node_modules')));
});

// ---------------------------------------------------------------------------------------------------------------------
// Test-file names runners pick up by name.

test('REQ-GATE-64 Node, PHPUnit, and underscore JS test names are runnable test files; helpers are not', () => {
  const names = ['a-test.js', 'a_test.mjs', 'test-a.js', 'sub/test-b.cjs', 'test.js', 'tests/FooTest.php'];
  const ctx = {
    changed: [...names, 'test/helpers.js', 'test/fixtures/data.json'].map((path) => ({ path, status: 'A' })),
    config: { testGlobs: ['test/**', 'tests/**', '**/*.js', '**/*.mjs', '**/*.cjs', '**/*.php'] },
  };
  assert.deepEqual(proofFiles(ctx).sort(), [...names].sort());
  const config = { heldOutFilesCommand: 'run {files}' };
  const command = heldOutTestCommand(config, ['x-test.js', 'heldout/curl.mjs']);
  assert.match(command, /x-test\.js/);
  assert.doesNotMatch(command, /curl/);
});

// ---------------------------------------------------------------------------------------------------------------------
// A reused held-out set is checked against the base the run starts from.

const FAKE = fileURLToPath(new URL('./fake-worker.js', import.meta.url));
const builder = (mode) => ({ provider: 'exec', family: 'claude', model: 'exec-build', effort: 'low', command: ['node', FAKE, mode] });
const author = {
  provider: 'exec',
  family: 'codex',
  model: 'exec-author',
  effort: 'high',
  command: [
    'node',
    '-e',
    "const fs=require('fs');fs.mkdirSync('test',{recursive:true});fs.writeFileSync('test/held.test.js',\"import assert from 'node:assert';\\nimport { add } from '../src/add.js';\\nassert.strictEqual(add(2, 3), 5);\\n\");console.log(JSON.stringify({total_cost_usd:0.01,usage:{input_tokens:1,output_tokens:1}}));",
  ],
};
const issue = {
  id: 'BUI-9802',
  title: 'Reused held-out tests meet a moved base',
  description: '- REQ-RUN-63: When add is called, the system shall return the sum.\n',
  priority: 2,
  createdAt: '2026-11-01',
  labels: ['Bug'],
  estimate: 3,
};

test('REQ-RUN-63 a reused held-out set that the moved base already passes is authored again, not run into held-out-not-executed', () => {
  const { dir } = fixtureRepo();
  process.env.KEEL_FAKE_LOG = join(tmp('keel-log-'), 'calls.jsonl');
  const config = (mode) => fixtureConfig({ tiers: [builder(mode), author], heldOutAuthorTier: 1, maxAttempts: 1 });
  const first = run({ repo: dir, card: cardFromIssue(issue), config: config('quota') });
  assert.equal(first.stopped, 'quota', first.failure);
  const authored = () => readLedger().filter((r) => r.role === 'held-out-author').length;
  assert.equal(authored(), 1);
  // The base moves: main now holds the fix, so the authored test passes on it.
  commit(dir, FIXED_SRC, 'fix: already done on main');
  const log = [];
  const r = run({ repo: dir, card: cardFromIssue(issue), config: config('good'), log: (m) => log.push(m) });
  assert.equal(r.pass, false);
  assert.equal(r.stopped, 'held-out-author', `${r.stopped}: ${r.failure}\n${log.join('\n')}`);
  assert.equal(authored(), 2, 'the stale held-out set was reused');
  assert.match(r.failure, /pass on base/);
});

test('REQ-RUN-63 a reused held-out set that still fails on the base is reused', () => {
  const { dir } = fixtureRepo();
  process.env.KEEL_FAKE_LOG = join(tmp('keel-log-'), 'calls.jsonl');
  const config = (mode) => fixtureConfig({ tiers: [builder(mode), author], heldOutAuthorTier: 1, maxAttempts: 1 });
  assert.equal(run({ repo: dir, card: cardFromIssue(issue), config: config('quota') }).stopped, 'quota');
  commit(dir, { 'docs/unrelated.md': 'moved\n' }, 'docs: base moves');
  const log = [];
  const r = run({ repo: dir, card: cardFromIssue(issue), config: config('good'), log: (m) => log.push(m) });
  assert.equal(r.pass, true, `${r.stopped}: ${r.failure}\n${log.join('\n')}`);
  assert.equal(readLedger().filter((x) => x.role === 'held-out-author').length, 1, 'the set was authored again');
  assert.ok(log.some((m) => /reusing the held-out tests/.test(m)));
});
