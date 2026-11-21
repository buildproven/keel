import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { parseCard } from '../src/config.js';
import { failureSummary, gate, stageLine, writeInside } from '../src/gate.js';
import { BUGGY, FIXED_SRC, FIXTURE_TEST, REGRESSION_TEST, commit, fixtureConfig, fixtureRepo, g, tmp, write } from './helpers.js';

const card = (header = 'kind: bug\nsize: S') => parseCard(`# T-1: test card\n${header}\n`);
const failing = (receipt) => receipt.results.filter((r) => !r.pass).map((r) => r.name);
const rules = (receipt) => receipt.results.flatMap((r) => r.problems.map((p) => p.rule));
const HELD_PASS = "import assert from 'node:assert';\nimport { add } from '../src/add.js';\nassert.strictEqual(add(-1, 1), 0);\n";
const HELD_FAIL = "import assert from 'node:assert';\nimport { add } from '../src/add.js';\nassert.strictEqual(add(1, 1), 3);\n";

test('REQ-GATE-3 passes a bug fix whose new test fails on a green base and passes on head', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC });
  const r = gate({ repo: dir, base, card: card(), config: fixtureConfig() });
  assert.equal(r.pass, true, JSON.stringify(r.results, null, 2));
  assert.deepEqual(
    r.results.map((x) => x.name),
    ['locked', 'skip-markers', 'bypass', 'scope', 'test', 'red-proof'],
  );
});

test('REQ-GATE-3 fails when the new test also passes on base', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { 'test/trivial.test.js': "import assert from 'node:assert';\nassert.ok(1);\n", ...FIXED_SRC });
  assert.deepEqual(rules(gate({ repo: dir, base, card: card(), config: fixtureConfig() })), ['test-passes-on-base']);
});

test('REQ-GATE-3 fails a bug fix with no test change', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, FIXED_SRC);
  assert.deepEqual(rules(gate({ repo: dir, base, card: card(), config: fixtureConfig() })), ['no-test-changed']);
});

test('REQ-GATE-3 fails when the base is not green before the overlay', () => {
  const { dir, base } = fixtureRepo({ ...BUGGY, 'test/broken.test.js': 'process.exit(1);\n' });
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC, 'test/broken.test.js': null });
  const r = gate({ repo: dir, base, card: card('kind: bug\nsize: S\nallowEdits: test/broken.test.js'), config: fixtureConfig() });
  assert.deepEqual(rules(r), ['baseline-not-green']);
});

// A suite that names each file it runs, and the same for given files, so the red proof can be targeted (REQ-GATE-33).
const SUITE = 'for f in test/*.js; do echo "$f"; node "$f" || exit 1; done';
const FILES = 'for f in {files}; do node "$f" || exit 1; done';
// Fails on the buggy base add(), passes on the fixed one, and names its own path when it fails.
const RED_ON_BASE = "import assert from 'node:assert';\nimport { add } from '../src/add.js';\nassert.strictEqual(add(1, 1), 2);\n";
const PASSING_TEST = "import assert from 'node:assert';\nassert.ok(true);\n";

test('REQ-GATE-52 a base red only in a test file the card fixes passes the red proof as base-red-fixed, unrecorded', () => {
  const { dir, base } = fixtureRepo({ ...BUGGY, 'test/a.test.js': RED_ON_BASE });
  commit(dir, { ...FIXED_SRC, 'test/a.test.js': `${RED_ON_BASE}assert.strictEqual(add(2, 3), 5);\n` });
  const cacheDir = tmp('keel-cache-');
  const r = gate({ repo: dir, base, card: card('kind: bug\nsize: S\nallowEdits: test/a.test.js'), config: fixtureConfig(), cacheDir });
  assert.equal(r.pass, true, JSON.stringify(r.results, null, 2));
  const proof = r.results.find((x) => x.name === 'red-proof');
  assert.deepEqual(proof.baseRedFixed, ['test/a.test.js']);
  assert.match(stageLine(proof), /^PASS red-proof \(base-red-fixed: test\/a\.test\.js\)/);
  assert.deepEqual(readdirSync(cacheDir), [], 'a red baseline is never recorded');
});

test('REQ-GATE-52 a base red in a test file the card does not touch fails as baseline-not-green and names the files', () => {
  const { dir, base } = fixtureRepo({ ...BUGGY, 'test/a.test.js': RED_ON_BASE, 'test/b.test.js': RED_ON_BASE });
  commit(dir, { ...FIXED_SRC, 'test/a.test.js': `${RED_ON_BASE}assert.strictEqual(add(2, 3), 5);\n` });
  const r = gate({ repo: dir, base, card: card('kind: bug\nsize: S\nallowEdits: test/a.test.js'), config: fixtureConfig() });
  const proof = r.results.find((x) => x.name === 'red-proof');
  assert.deepEqual(proof.problems, [{ rule: 'baseline-not-green', files: ['test/a.test.js', 'test/b.test.js'] }]);
});

test('REQ-GATE-52 baseline-not-green names only the files that fail, not the passing files a runner lists', () => {
  // SUITE echoes every file it runs: test/0-failed.test.js passes on base, so only its echo names it.
  const { dir, base } = fixtureRepo({
    ...BUGGY,
    'test/0-failed.test.js': PASSING_TEST,
    'test/a.test.js': RED_ON_BASE,
    'test/b.test.js': RED_ON_BASE,
  });
  commit(dir, { ...FIXED_SRC, 'test/a.test.js': `${RED_ON_BASE}assert.strictEqual(add(2, 3), 5);\n` });
  const config = fixtureConfig({ testCommand: SUITE, checks: { test: SUITE } });
  const r = gate({ repo: dir, base, card: card('kind: bug\nsize: S\nallowEdits: test/a.test.js'), config });
  const proof = r.results.find((x) => x.name === 'red-proof');
  assert.deepEqual(proof.problems, [{ rule: 'baseline-not-green', files: ['test/a.test.js', 'test/b.test.js'] }]);
});

test('REQ-GATE-52 an inconclusive base baseline is never base-red-fixed, targeted or not', () => {
  // On base with test/a.test.js present the command exits 127 after naming the file; on head it runs the suite.
  const notFound = `grep -q "a - b" src/add.js && [ -f test/a.test.js ] && { echo test/a.test.js; exit 127; }; ${SUITE}`;
  for (const over of [
    { testCommand: notFound, checks: { test: notFound } },
    {
      testCommand: SUITE,
      checks: { test: SUITE },
      testFilesCommand: `grep -q "a - b" src/add.js && { echo {files}; exit 127; }; ${FILES}`,
    },
  ]) {
    const { dir, base } = fixtureRepo({ ...BUGGY, 'test/a.test.js': RED_ON_BASE });
    commit(dir, { ...FIXED_SRC, 'test/a.test.js': `${RED_ON_BASE}assert.strictEqual(add(2, 3), 5);\n` });
    const r = gate({ repo: dir, base, card: card('kind: bug\nsize: S\nallowEdits: test/a.test.js'), config: fixtureConfig(over) });
    assert.deepEqual(rules(r), ['baseline-not-green'], JSON.stringify(over));
  }
});

test('REQ-GATE-52 a targeted base baseline that fails without naming a file it ran fails as baseline-not-green', () => {
  const { dir, base } = fixtureRepo({ ...BUGGY, 'test/a.test.js': RED_ON_BASE });
  commit(dir, { ...FIXED_SRC, 'test/a.test.js': `${RED_ON_BASE}assert.strictEqual(add(2, 3), 5);\n` });
  const silent = `grep -q "a - b" src/add.js && exit 1; ${FILES}`;
  const config = fixtureConfig({ testCommand: SUITE, checks: { test: SUITE }, testFilesCommand: silent });
  const r = gate({ repo: dir, base, card: card('kind: bug\nsize: S\nallowEdits: test/a.test.js'), config });
  assert.equal(r.results.find((x) => x.name === 'targeted-on-head').targeted, true);
  assert.deepEqual(rules(r), ['baseline-not-green']);
});

test('REQ-GATE-52 a targeted base baseline counts a file as failing only on a line with a failure mark or location', () => {
  // On base the files command prints a line naming each file and exits 1; on head it runs them.
  for (const [line, rule] of [
    ['', 'baseline-not-green'],
    ['FAIL ', null],
  ]) {
    const { dir, base } = fixtureRepo({ ...BUGGY, 'test/a.test.js': RED_ON_BASE });
    commit(dir, { ...FIXED_SRC, 'test/a.test.js': `${RED_ON_BASE}assert.strictEqual(add(2, 3), 5);\n` });
    const files = `grep -q "a - b" src/add.js && { echo ${line}{files}; exit 1; }; ${FILES}`;
    const config = fixtureConfig({ testCommand: SUITE, checks: { test: SUITE }, testFilesCommand: files });
    const r = gate({ repo: dir, base, card: card('kind: bug\nsize: S\nallowEdits: test/a.test.js'), config });
    const proof = r.results.find((x) => x.name === 'red-proof');
    assert.deepEqual(
      proof.problems.map((p) => p.rule),
      rule ? [rule] : [],
      JSON.stringify(line),
    );
    if (!rule) assert.deepEqual(proof.baseRedFixed, ['test/a.test.js']);
  }
});

test('REQ-GATE-52 a targeted base baseline red only in the files the card fixes passes as base-red-fixed', () => {
  const { dir, base } = fixtureRepo({ ...BUGGY, 'test/a.test.js': RED_ON_BASE });
  commit(dir, { ...FIXED_SRC, 'test/a.test.js': `${RED_ON_BASE}assert.strictEqual(add(2, 3), 5);\n` });
  const config = fixtureConfig({ testCommand: SUITE, checks: { test: SUITE }, testFilesCommand: FILES });
  const r = gate({ repo: dir, base, card: card('kind: bug\nsize: S\nallowEdits: test/a.test.js'), config });
  assert.equal(r.pass, true, JSON.stringify(r.results, null, 2));
  const proof = r.results.find((x) => x.name === 'red-proof');
  assert.deepEqual([proof.targeted, proof.baseRedFixed], [true, ['test/a.test.js']]);
});

test('REQ-GATE-3 treats command-not-found and silent failures as no proof', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC });
  const notFound = fixtureConfig({ testCommand: 'grep -q "a - b" src/add.js && [ -f test/add.test.js ] && exit 127 || true' });
  assert.deepEqual(rules(gate({ repo: dir, base, card: card(), config: notFound })), ['inconclusive']);
  const silent = fixtureConfig({ testCommand: 'grep -q "a - b" src/add.js && [ -f test/add.test.js ] && { echo boom; exit 1; } || true' });
  assert.deepEqual(rules(gate({ repo: dir, base, card: card(), config: silent })), ['failure-not-in-new-tests']);
});

test('REQ-GATE-1 fails when a configured check exits non-zero and stops there', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, REGRESSION_TEST);
  const r = gate({ repo: dir, base, card: card(), config: fixtureConfig() });
  assert.deepEqual(failing(r), ['test']);
  assert.ok(!r.results.some((x) => x.name === 'red-proof'));
});

test('REQ-GATE-2 fails on a dirty tree before any check', () => {
  const { dir, base } = fixtureRepo();
  write(dir, FIXED_SRC);
  const r = gate({ repo: dir, base, card: card(), config: fixtureConfig() });
  assert.deepEqual(
    r.results.map((x) => x.name),
    ['clean-tree'],
  );
});

test('REQ-GATE-4 locks existing tests: modify, delete, and a vacuous rewrite all fail', () => {
  for (const change of [
    { 'test/basic.test.js': null },
    { 'test/basic.test.js': "import assert from 'node:assert';\nassert.equal(true, true);\n" },
  ]) {
    const { dir, base } = fixtureRepo();
    commit(dir, { ...change, ...REGRESSION_TEST, ...FIXED_SRC });
    const r = gate({ repo: dir, base, card: card(), config: fixtureConfig() });
    assert.deepEqual(rules(r), ['existing-test-changed']);
  }
});

test('REQ-GATE-4 allows an existing-test edit named in allowEdits', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, {
    'test/basic.test.js': "import assert from 'node:assert';\nassert.ok(1);\n",
    'src/add.js': '// tidy\n' + FIXED_SRC['src/add.js'],
  });
  const r = gate({ repo: dir, base, card: card('kind: chore\nsize: S\nallowEdits: test/basic.test.js'), config: fixtureConfig() });
  assert.equal(r.pass, true, JSON.stringify(r.results));
});

test('REQ-GATE-4 fails when verification files or package.json scripts change', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { 'vitest.config.js': 'export default {};\n', 'package.json': '{"type":"module","scripts":{"test":"true"}}\n' });
  const r = gate({ repo: dir, base, card: card('kind: chore\nsize: S'), config: fixtureConfig() });
  assert.deepEqual(rules(r).sort(), ['package-scripts-changed', 'verification-file-changed']);
});

test('REQ-PROJ-4 pyproject.toml dependency changes pass; tool-section changes are locked', () => {
  const before = '[project]\nname = "x"\ndependencies = ["requests"]\n\n[tool.pytest.ini_options]\naddopts = "-q"\n';
  const { dir, base } = fixtureRepo({ ...BUGGY, 'pyproject.toml': before });
  const depOnly = commit(dir, {
    'pyproject.toml': '[project]\nname = "x"\ndependencies = ["requests", "httpx"]\n\n[tool.pytest.ini_options]\naddopts = "-q"\n',
  });
  assert.equal(gate({ repo: dir, base, card: card('kind: chore\nsize: S'), config: fixtureConfig() }).pass, true);
  g(dir, 'reset', '--hard', depOnly);
  commit(dir, {
    'pyproject.toml': '[project]\nname = "x"\ndependencies = ["requests"]\n\n[tool.pytest.ini_options]\naddopts = "-q -x"\n',
  });
  const r = gate({ repo: dir, base: depOnly, card: card('kind: chore\nsize: S'), config: fixtureConfig() });
  assert.deepEqual(rules(r), ['verification-file-changed']);
});

test('REQ-GATE-4 the change under test cannot edit keel.json', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { 'keel.json': JSON.stringify({ checks: { test: 'true' } }) });
  assert.deepEqual(rules(gate({ repo: dir, base, card: card('kind: chore\nsize: S'), config: fixtureConfig() })), [
    'verification-file-changed',
  ]);
});

test('REQ-GATE-5 rejects a symlink added by the change', () => {
  const { dir, base } = fixtureRepo();
  symlinkSync('/etc/hosts', join(dir, 'src/link.js'));
  commit(dir, {});
  assert.deepEqual(rules(gate({ repo: dir, base, card: card('kind: chore\nsize: S'), config: fixtureConfig() })), ['unsupported-mode']);
});

test('REQ-GATE-6 fails when a skip marker is added to a test', () => {
  const { dir, base } = fixtureRepo();
  // Built from parts so Keel's own gate does not flag this fixture line.
  commit(dir, { 'test/add.test.js': `it.${'skip'}("adds", () => {});\n`, ...FIXED_SRC });
  const r = gate({ repo: dir, base, card: card(), config: fixtureConfig() });
  assert.deepEqual(failing(r), ['skip-markers']);
  assert.equal(r.results[1].problems[0].line, 1);
});

test('REQ-GATE-7 refactor cards need no red proof', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { 'src/add.js': 'export const add = (a, b) => (a) - (b);\n' });
  const r = gate({ repo: dir, base, card: card('kind: refactor\nsize: S'), config: fixtureConfig() });
  assert.equal(r.pass, true, JSON.stringify(r.results));
  assert.ok(!r.results.some((x) => x.name === 'red-proof'));
});

test('REQ-GATE-8 fails on an added bypass marker, ignores prose and bypassAllow files', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, {
    'src/add.js': '// eslint-disable-next-line\nexport const add = (a, b) => a - b;\n',
    'NOTES.md': 'never use eslint-disable\n',
  });
  const r = gate({ repo: dir, base, card: card('kind: chore\nsize: S'), config: fixtureConfig() });
  assert.deepEqual(
    r.results.find((x) => x.name === 'bypass').problems.map((p) => p.path),
    ['src/add.js'],
  );
  const allowed = gate({ repo: dir, base, card: card('kind: chore\nsize: S'), config: fixtureConfig({ bypassAllow: ['src/add.js'] }) });
  assert.equal(allowed.pass, true);
});

test('REQ-GATE-9 fails when a changed file is outside card paths', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC, 'README.md': 'x\n' });
  const r = gate({ repo: dir, base, card: card('kind: bug\nsize: S\npaths: src/**, test/**'), config: fixtureConfig() });
  assert.deepEqual(r.results.find((x) => x.name === 'scope').problems, [{ rule: 'out-of-scope', path: 'README.md' }]);
});

test('REQ-GATE-10 M bug cards require held-out tests; they run on head and never leak or overwrite', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC });
  assert.deepEqual(rules(gate({ repo: dir, base, card: card('kind: bug\nsize: M'), config: fixtureConfig() })), ['held-out-required']);

  const held = tmp('keel-held-');
  write(held, { 'test/held.test.js': HELD_PASS });
  const withHeld = card(`kind: bug\nsize: M\nheldOut: ${held}`);
  assert.equal(gate({ repo: dir, base, card: withHeld, config: fixtureConfig() }).pass, true);

  write(held, { 'test/held.test.js': HELD_FAIL });
  const bad = gate({ repo: dir, base, card: withHeld, config: fixtureConfig() });
  assert.deepEqual(failing(bad), ['held-out']);
  assert.match(failureSummary(bad, 4000), /held-out-fails-on-head \(details withheld\)/);
  assert.ok(!failureSummary(bad, 4000).includes('add(1, 1)'));
  assert.ok(!existsSync(join(dir, 'test/held.test.js')), 'held-out test must not leak into the repo');

  write(held, { 'test/held.test.js': null, 'src/add.js': 'export const add = () => 5;\n' });
  assert.deepEqual(rules(gate({ repo: dir, base, card: withHeld, config: fixtureConfig() })), ['held-out-overwrite']);
  assert.deepEqual(rules(gate({ repo: dir, base, card: card('kind: bug\nsize: M\nheldOut: rel/dir'), config: fixtureConfig() })), [
    'held-out-missing',
  ]);
});

test('REQ-GATE-11 writes a uniquely named receipt bound to card, base, and head', () => {
  const { dir, base } = fixtureRepo();
  const head = commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC });
  const receiptDir = tmp('keel-receipts-');
  gate({ repo: dir, base, card: card(), config: fixtureConfig(), receiptDir });
  gate({ repo: dir, base, card: card(), config: fixtureConfig(), receiptDir });
  const files = readdirSync(receiptDir);
  assert.equal(files.length, 2);
  assert.ok(files.every((f) => f.startsWith(`T-1-${head}-`)));
  const saved = JSON.parse(readFileSync(join(receiptDir, files[0]), 'utf8'));
  assert.deepEqual([saved.card, saved.base, saved.head, saved.pass], ['T-1', base, head, true]);
});

test('REQ-GATE-12 refuses writes through a symlink or outside the checkout', () => {
  const root = tmp('keel-root-');
  const outside = tmp('keel-outside-');
  symlinkSync(outside, join(root, 'evil'));
  const err = writeInside(root, 'evil/x.test.js', (t) => writeFileSync(t, 'pwned'));
  assert.match(err, /escapes checkout/);
  assert.ok(!existsSync(join(outside, 'x.test.js')));
  mkdirSync(join(root, 'test'));
  symlinkSync(join(outside, 'target'), join(root, 'test/link.js'));
  assert.match(
    writeInside(root, 'test/link.js', (t) => writeFileSync(t, 'pwned')),
    /symlink/,
  );
  assert.equal(
    writeInside(root, 'test/ok.js', (t) => writeFileSync(t, 'ok')),
    null,
  );
});

test('REQ-GATE-13 fails when a check mutates the candidate', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { 'src/add.js': 'export const add = (a, b) => (a) - (b);\n' });
  const config = fixtureConfig({ checks: { fixup: 'echo "// patched" >> src/add.js' } });
  const r = gate({ repo: dir, base, card: card('kind: refactor\nsize: S'), config });
  assert.deepEqual(failing(r), ['integrity']);
  assert.equal(g(dir, 'status', '--porcelain'), '', 'checks run in a fresh checkout, not in the repo');
});

test('REQ-GATE-13 does not fail integrity when a check leaves untracked cache files (e.g. __pycache__, node_modules/.cache)', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { 'src/add.js': 'export const add = (a, b) => (a) - (b);\n' });
  const config = fixtureConfig({ checks: { fixup: 'mkdir -p __pycache__ && echo cache > __pycache__/x' } });
  const r = gate({ repo: dir, base, card: card('kind: refactor\nsize: S'), config });
  assert.equal(r.pass, true, JSON.stringify(r.results));
});

test('REQ-RUN-3 failure summary lists only failing steps and is truncated', () => {
  const receipt = {
    results: [
      { name: 'a', pass: true, problems: [] },
      { name: 'b', pass: false, problems: [{ rule: 'x' }], output: 'y'.repeat(100) },
    ],
  };
  const s = failureSummary(receipt, 40);
  assert.match(s, /^## b/);
  assert.ok(!s.includes('## a'));
  assert.match(s, /truncated/);
});

test('REQ-GATE-3 the regression tests must pass on head in their own run, not only via checks', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, REGRESSION_TEST); // test added, bug not fixed
  const config = fixtureConfig({ checks: { syntax: 'node --check src/add.js' } });
  assert.deepEqual(rules(gate({ repo: dir, base, card: card(), config })), ['regression-fails-on-head']);
});

test('REQ-GATE-4 locks runner scripts that package.json scripts call', () => {
  const runner =
    "import { execSync } from 'node:child_process';\nexecSync('for f in test/*.js; do node $f || exit 1; done', { stdio: 'inherit', shell: '/bin/sh' });\n";
  const { dir, base } = fixtureRepo({
    ...BUGGY,
    'package.json': '{"type":"module","scripts":{"test":"node scripts/check.mjs"}}\n',
    'scripts/check.mjs': runner,
  });
  commit(dir, { 'scripts/check.mjs': '// tests disabled\n', ...REGRESSION_TEST });
  const config = fixtureConfig({ checks: { test: 'npm test' }, testCommand: 'npm test' });
  assert.deepEqual(rules(gate({ repo: dir, base, card: card(), config })), ['runner-script-changed']);
});

test('REQ-GATE-8 .gitattributes cannot hide added lines from the scanners', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { '.gitattributes': '*.js -diff\n', 'src/add.js': '// eslint-disable-next-line\nexport const add = (a, b) => a - b;\n' });
  const r = gate({ repo: dir, base, card: card('kind: chore\nsize: S'), config: fixtureConfig() });
  assert.deepEqual(rules(r).sort(), ['bypass-marker', 'verification-file-changed']);
});

test('REQ-GATE-10 held-out tests must actually run: empty or uncollected directories fail', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC });
  const empty = tmp('keel-held-');
  assert.deepEqual(rules(gate({ repo: dir, base, card: card(`kind: bug\nsize: M\nheldOut: ${empty}`), config: fixtureConfig() })), [
    'held-out-empty',
  ]);
  const uncollected = tmp('keel-held-');
  write(uncollected, { 'extra/held.test.js': HELD_FAIL });
  const r = gate({ repo: dir, base, card: card(`kind: bug\nsize: M\nheldOut: ${uncollected}/`), config: fixtureConfig() });
  assert.deepEqual(rules(r), ['held-out-not-executed']);
});

test('REQ-GATE-10 held-out problems never reveal the held-out path to the builder', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC });
  const r = gate({ repo: dir, base, card: card('kind: bug\nsize: M\nheldOut: /secret/held'), config: fixtureConfig() });
  assert.equal(r.pass, false);
  assert.ok(!failureSummary(r, 4000).includes('/secret/held'));
});

test('REQ-GATE-12 creates no directory outside the checkout before refusing', () => {
  const root = tmp('keel-root-');
  const outside = tmp('keel-outside-');
  symlinkSync(outside, join(root, 'evil'));
  assert.match(
    writeInside(root, 'evil/sub/x.test.js', (t) => writeFileSync(t, 'x')),
    /escapes checkout/,
  );
  assert.ok(!existsSync(join(outside, 'sub')));
});

test('REQ-GATE-14 checks run on a fresh checkout: ignored untracked files do not count', () => {
  const { dir, base } = fixtureRepo({ ...BUGGY, '.gitignore': 'src/gen.js\n' });
  write(dir, { 'src/gen.js': 'export const two = 2;\n' });
  commit(dir, {
    'src/add.js': "import { two } from './gen.js';\nexport const add = (a, b) => a + b + two - 2;\n",
    ...REGRESSION_TEST,
  });
  assert.deepEqual(failing(gate({ repo: dir, base, card: card(), config: fixtureConfig() })), ['test']);
});

test('REQ-GATE-3 when no new test file appears in the passing output, the failure says the test command may not run them', () => {
  const { dir, base } = fixtureRepo({ ...BUGGY, 'test/existing.test.js': "import assert from 'node:assert';\nassert.ok(1);\n" });
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC });
  const listed = fixtureConfig({ checks: { test: 'node test/existing.test.js' }, testCommand: 'node test/existing.test.js' });
  const red = gate({ repo: dir, base, card: card(), config: listed }).results.find((x) => x.name === 'red-proof');
  assert.equal(red.problems[0].rule, 'test-passes-on-base');
  assert.match(red.problems[0].hint, /may not run/);
});

test('REQ-GATE-3 a new test that runs and passes on base gets no not-run hint', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { 'test/trivial.test.js': "import assert from 'node:assert';\nassert.ok(1);\n", ...FIXED_SRC });
  const naming = 'for f in test/*.js; do echo "$f"; node "$f" || exit 1; done';
  const red = gate({
    repo: dir,
    base,
    card: card(),
    config: fixtureConfig({ checks: { test: naming }, testCommand: naming }),
  }).results.find((x) => x.name === 'red-proof');
  assert.equal(red.problems[0].rule, 'test-passes-on-base');
  assert.equal(red.problems[0].hint, undefined);
});

test('REQ-GATE-17 a green base test run is cached per base and reused by the next gate on the same base', () => {
  const { dir, base } = fixtureRepo();
  const count = join(tmp('keel-count-'), 'runs');
  const counting = `echo run >> "${count}"; ${FIXTURE_TEST}`;
  const config = fixtureConfig({ checks: { test: counting }, testCommand: counting });
  const cacheDir = tmp('keel-cache-');
  const runs = () => readFileSync(count, 'utf8').trim().split('\n').length;
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC });
  assert.equal(gate({ repo: dir, base, card: card(), config, cacheDir }).pass, true);
  const first = runs(); // head check + base baseline + overlay
  commit(dir, { 'src/extra.js': 'export const x = 1;\n' });
  assert.equal(gate({ repo: dir, base, card: card(), config, cacheDir }).pass, true);
  assert.equal(runs() - first, first - 1, 'the second gate skips only the base baseline run');
  const noCache = runs();
  gate({ repo: dir, base, card: card(), config });
  assert.equal(runs() - noCache, first, 'without a cache dir nothing is cached');
});

test('REQ-GATE-17 a red base is never cached', () => {
  const { dir, base } = fixtureRepo({ ...BUGGY, 'test/broken.test.js': 'process.exit(1);\n' });
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC, 'test/broken.test.js': null });
  const cacheDir = tmp('keel-cache-');
  for (let i = 0; i < 2; i++)
    assert.deepEqual(
      rules(
        gate({ repo: dir, base, card: card('kind: bug\nsize: S\nallowEdits: test/broken.test.js'), config: fixtureConfig(), cacheDir }),
      ),
      ['baseline-not-green'],
    );
  assert.deepEqual(readdirSync(cacheDir), []);
});

// Fails the first time it runs in a given marker dir, passes after: a stand-in for a load-induced timeout.
const flakyOnce = (marker) => `if [ -f "${marker}" ]; then ${FIXTURE_TEST}; else touch "${marker}"; exit 1; fi`;

test('REQ-GATE-18 a check that fails once and passes on an immediate retry passes as flaky, first failure kept', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC });
  const marker = join(tmp('keel-flaky-'), 'seen');
  const r = gate({ repo: dir, base, card: card(), config: fixtureConfig({ checks: { test: flakyOnce(marker) } }) });
  assert.equal(r.pass, true, JSON.stringify(r.results, null, 2));
  const stage = r.results.find((x) => x.name === 'test');
  assert.equal(stage.flaky, true);
  assert.match(stageLine(stage), /^PASS test \(flaky: failed once, passed on retry\)/);
});

test('REQ-GATE-18 a check that fails twice fails, and a steady pass is not flaky', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC });
  const count = join(tmp('keel-count-'), 'runs');
  const lintFails = fixtureConfig({ checks: { lint: `echo x >> "${count}"; exit 1` } });
  assert.deepEqual(failing(gate({ repo: dir, base, card: card(), config: lintFails })), ['lint']);
  assert.equal(readFileSync(count, 'utf8').trim().split('\n').length, 2, 'retried exactly once');
  const steady = gate({ repo: dir, base, card: card(), config: fixtureConfig() });
  assert.equal(steady.results.find((x) => x.name === 'test').flaky, undefined);
});

test('REQ-GATE-17 the base cache is shared by every worktree of the same repository', () => {
  const { dir, base } = fixtureRepo();
  const count = join(tmp('keel-count-'), 'runs');
  const counting = `echo run >> "${count}"; ${FIXTURE_TEST}`;
  const config = fixtureConfig({ checks: { test: counting }, testCommand: counting });
  const cacheDir = tmp('keel-cache-');
  const runs = () => readFileSync(count, 'utf8').trim().split('\n').length;
  const wtA = join(tmp('keel-wt-'), 'a');
  const wtB = join(tmp('keel-wt-'), 'b');
  for (const [wt, branch] of [
    [wtA, 'a'],
    [wtB, 'b'],
  ]) {
    g(dir, 'worktree', 'add', '-q', '-b', branch, wt, base);
    commit(wt, { ...REGRESSION_TEST, ...FIXED_SRC });
  }
  assert.equal(gate({ repo: wtA, base, card: card(), config, cacheDir }).pass, true);
  const first = runs();
  assert.equal(gate({ repo: wtB, base, card: card(), config, cacheDir }).pass, true);
  assert.equal(runs() - first, first - 1, 'the second worktree reuses the first one’s green base');
});

test('REQ-GATE-18 a base baseline that fails once and passes on retry is accepted as flaky', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC });
  const seen = join(tmp('keel-flaky-'), 'seen');
  const count = join(tmp('keel-count-'), 'runs');
  // Head check passes; the 2nd command run overall (the base baseline) fails once, then everything behaves.
  const cmd = `echo x >> "${count}"; if [ "$(wc -l < "${count}")" -eq 2 ] && [ ! -f "${seen}" ]; then touch "${seen}"; exit 1; fi; ${FIXTURE_TEST}`;
  const r = gate({ repo: dir, base, card: card(), config: fixtureConfig({ checks: { test: cmd }, testCommand: cmd }) });
  assert.equal(r.pass, true, JSON.stringify(r.results, null, 2));
  assert.equal(r.results.find((x) => x.name === 'red-proof').flaky, true);
});

test('REQ-GATE-19 a head with no change against base fails as no-change, whatever the card kind', () => {
  for (const kind of ['chore', 'bug']) {
    const { dir, base } = fixtureRepo();
    assert.deepEqual(rules(gate({ repo: dir, base, card: card(`kind: ${kind}\nsize: S`), config: fixtureConfig() })), ['no-change']);
  }
});

test('REQ-GATE-51 a test runner that hides file names under a coding agent still gets a targeted red proof', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC });
  // Like vitest 5 with std-env: it names each passing file only when no coding agent is detected.
  const suite = 'for f in test/*.js; do [ -n "$CLAUDECODE" ] || echo "$f"; node "$f" || exit 1; done';
  const config = fixtureConfig({
    checks: { test: suite },
    testCommand: suite,
    testFilesCommand: 'for f in {files}; do node "$f" || exit 1; done',
  });
  const saved = process.env.CLAUDECODE;
  process.env.CLAUDECODE = '1';
  try {
    const r = gate({ repo: dir, base, card: card(), config });
    assert.equal(r.pass, true, JSON.stringify(r.results, null, 2));
    const row = r.results.find((x) => x.name === 'targeted-on-head');
    assert.equal(row.targeted, true, JSON.stringify(row));
    assert.equal(row.unseen, undefined);
  } finally {
    if (saved === undefined) delete process.env.CLAUDECODE;
    else process.env.CLAUDECODE = saved;
  }
});

const scanCard = parseCard('# T-1: test card\nkind: chore\nsize: S\n');
const glStage = (r, name) => r.results.find((x) => x.name === name);
const GL_TOKEN = { 'src/token.js': 'export const token = "abcdefghijkl";\n' };
const GL_RULE =
  '[[rules]]\nid = "env-secret"\ndescription = "secret-shaped assignment"\nregex = \'\'\'(?i)(token|secret|password|api_key)\\s*=\\s*"[^"]{6,}"\'\'\'\n';
const glSavedPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = glSavedPath;
});

/** A `gitleaks` on PATH that reads the same arguments as the real one and flags `token = "` in the scanned range. */
function glFake() {
  const bin = tmp('keel-bin-');
  const file = join(bin, 'gitleaks');
  writeFileSync(
    file,
    `#!/bin/sh
for a in "$@"; do
  case "$a" in
    --log-opts=*) range="\${a#--log-opts=}" ;;
  esac
done
prev=""
for a in "$@"; do
  [ "$prev" = "--source" ] && source="$a"
  [ "$prev" = "--report-path" ] && report="$a"
  [ "$prev" = "--config" ] && config="$a"
  prev="$a"
done
[ -n "$GITLEAKS_ARGS_LOG" ] && echo "$*" >> "$GITLEAKS_ARGS_LOG"
if git -C "$source" log -p "$range" | grep -q 'token = "'; then
  printf '[{"RuleID":"env-secret","File":"src/token.js","StartLine":1,"Commit":"0123456789abcdef"}]' > "$report"
  exit 1
fi
printf '[]' > "$report"
`,
  );
  chmodSync(file, 0o755);
  process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
}

test('REQ-GATE-72 a head that adds a secret-shaped value fails the secrets stage when the repo has .gitleaks.toml', () => {
  glFake();
  const { dir, base } = fixtureRepo({ ...{ '.gitleaks.toml': GL_RULE }, 'src/a.js': 'export {};\n' });
  commit(dir, GL_TOKEN);
  const r = gate({ repo: dir, base, card: scanCard, config: fixtureConfig() });
  assert.equal(r.pass, false);
  const secrets = glStage(r, 'secrets');
  assert.equal(secrets.pass, false);
  assert.deepEqual(secrets.problems, [{ rule: 'secret-detected', path: 'src/token.js', line: 1, detail: 'env-secret in commit 01234567' }]);
  // The builder is told where, and what to change; the value itself never reaches the receipt.
  assert.match(failureSummary(r, 4000), /Fix: remove the secret-shaped value at src\/token\.js:1/);
  assert.equal(glStage(r, 'candidate'), undefined, 'a failed secrets stage stops the gate before the checks run');
});

test('REQ-GATE-72 a clean head passes the secrets stage, and a repo with no gitleaks has no such stage', () => {
  glFake();
  const withScan = fixtureRepo({ '.gitleaks.toml': GL_RULE, 'src/a.js': 'export {};\n' });
  commit(withScan.dir, { 'src/b.js': 'export const b = 1;\n' });
  const clean = gate({ repo: withScan.dir, base: withScan.base, card: scanCard, config: fixtureConfig() });
  assert.equal(glStage(clean, 'secrets').pass, true, JSON.stringify(clean.results));

  const without = fixtureRepo();
  commit(without.dir, GL_TOKEN);
  const r = gate({ repo: without.dir, base: without.base, card: scanCard, config: fixtureConfig() });
  assert.equal(glStage(r, 'secrets'), undefined);
  assert.equal(r.pass, true, JSON.stringify(r.results));
});

test('REQ-GATE-72 a pre-push hook, a workflow, or a script that names gitleaks turns the stage on', () => {
  glFake();
  for (const file of ['.husky/pre-push', '.github/workflows/ci.yml', 'scripts/run-gitleaks.sh', 'package.json']) {
    const { dir, base } = fixtureRepo({
      'src/a.js': 'export {};\n',
      [file]: file === 'package.json' ? '{"scripts":{"scan":"gitleaks detect"}}\n' : 'gitleaks detect\n',
    });
    commit(dir, GL_TOKEN);
    const r = gate({ repo: dir, base, card: scanCard, config: fixtureConfig() });
    assert.equal(glStage(r, 'secrets')?.pass, false, `${file}: ${JSON.stringify(r.results)}`);
  }
});

test('REQ-GATE-72 the scan covers the candidate range only, and uses the .gitleaks.toml of the base', () => {
  glFake();
  const log = join(tmp('keel-log-'), 'args');
  process.env.GITLEAKS_ARGS_LOG = log;
  try {
    // A secret already in the base history is not the candidate's; the candidate weakens the config in its own commit.
    const { dir, base } = fixtureRepo({ '.gitleaks.toml': GL_RULE, 'src/a.js': 'export {};\n' });
    commit(dir, { '.gitleaks.toml': '# allow everything\n', 'src/b.js': 'export const b = 1;\n' });
    const r = gate({ repo: dir, base, card: scanCard, config: fixtureConfig() });
    assert.equal(glStage(r, 'secrets').pass, true);
    const args = spawnSync('cat', [log], { encoding: 'utf8' }).stdout;
    assert.match(args, new RegExp(`--log-opts=${base}\\.\\.[0-9a-f]{40}`));
    assert.match(args, /--config \S+gitleaks\.toml/);
  } finally {
    delete process.env.GITLEAKS_ARGS_LOG;
  }
});

test('REQ-GATE-72 a repo that runs gitleaks fails visibly where gitleaks is not installed', () => {
  // A PATH with git and sh only: gitleaks is on none of it, wherever this machine keeps it.
  const bin = tmp('keel-bin-');
  for (const tool of ['git', 'sh']) symlinkSync(spawnSync('which', [tool], { encoding: 'utf8' }).stdout.trim(), join(bin, tool));
  process.env.PATH = bin;
  const { dir, base } = fixtureRepo({ '.gitleaks.toml': GL_RULE, 'src/a.js': 'export {};\n' });
  commit(dir, { 'src/b.js': 'export const b = 1;\n' });
  const r = gate({ repo: dir, base, card: scanCard, config: fixtureConfig({ checks: {}, testCommand: 'true' }) });
  const secrets = glStage(r, 'secrets');
  assert.equal(secrets.pass, false);
  assert.equal(secrets.problems[0].rule, 'gitleaks-unavailable');
  assert.match(secrets.problems[0].detail, /not installed/);
});

const glReal = spawnSync('gitleaks', ['version']).status === 0;
if (glReal) {
  test('REQ-GATE-72 the real gitleaks, with the repo .gitleaks.toml, fails a head that adds const token = "abcdefghijkl"', () => {
    const { dir, base } = fixtureRepo({ '.gitleaks.toml': GL_RULE, 'src/a.js': 'export {};\n' });
    commit(dir, { 'src/t.js': 'const token = "abcdefghijkl";\n' });
    const r = gate({ repo: dir, base, card: scanCard, config: fixtureConfig() });
    const secrets = glStage(r, 'secrets');
    assert.equal(secrets.pass, false, JSON.stringify(r.results));
    assert.equal(secrets.problems[0].rule, 'secret-detected');
    assert.equal(secrets.problems[0].path, 'src/t.js');
    assert.ok(!JSON.stringify(r).includes('abcdefghijkl'), 'the value is redacted');
  });
}

const prevReviewer = (script) => ({
  provider: 'exec',
  family: 'codex',
  model: 'exec-review',
  effort: 'high',
  command: ['node', '-e', `const p = require('fs').readFileSync(0, 'utf8'); ${script}`],
});

test('REQ-GATE-23 a head that carries a failed head uncommitted (continues) gets that head review, though it is no descendant', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC }, 'fix: add');
  const receiptDir = tmp('keel-receipts-');
  const config = fixtureConfig({ review: true });
  const blocker = prevReviewer("console.log('FINDING medium src/add.js:1 add ignores NaN'); console.log('VERDICT: block')");
  const first = gate({ repo: dir, base, card: card(), config, receiptDir, reviewer: blocker });
  assert.equal(first.pass, false);
  // What `keel run` does before the next attempt (REQ-RUN-69): the branch goes back to base, the diff stays, one new commit.
  g(dir, 'reset', '-q', '--mixed', base);
  commit(dir, { 'src/add.js': 'export const add = (a, b) => Number(a) + Number(b);\n' }, 'fix: add, attempt 2');
  assert.notEqual(g(dir, 'merge-base', base, 'HEAD'), first.head);
  const promptFile = join(tmp('keel-prompt-'), 'prompt.txt');
  const recorder = prevReviewer(`require('fs').writeFileSync(${JSON.stringify(promptFile)}, p); console.log('VERDICT: pass')`);
  // Each check reads a copy holding only the first receipt: a gate writes its own, and the newest one counts.
  const onlyFirst = () => {
    const copy = tmp('keel-receipts-');
    cpSync(receiptDir, copy, { recursive: true });
    return copy;
  };
  const plain = gate({ repo: dir, base, card: card(), config, receiptDir: onlyFirst(), reviewer: recorder });
  assert.equal(plain.pass, true, JSON.stringify(plain.results));
  assert.doesNotMatch(readFileSync(promptFile, 'utf8'), /Previous review/, 'no ancestry and no continues: plain prompt');
  const forged = ['--output=/tmp/x', 'HEAD', first.head.slice(0, 12)];
  gate({ repo: dir, base, card: card(), config, receiptDir: onlyFirst(), reviewer: recorder, continues: forged });
  assert.doesNotMatch(readFileSync(promptFile, 'utf8'), /Previous review/, 'only full commit SHAs count as continues');
  gate({ repo: dir, base, card: card(), config, receiptDir: onlyFirst(), reviewer: recorder, continues: [first.head] });
  const prompt = readFileSync(promptFile, 'utf8');
  assert.match(prompt, new RegExp(`# Previous review \\(at ${first.head.slice(0, 12)}\\)`));
  assert.match(prompt, /- medium src\/add\.js:1 add ignores NaN/);
  assert.match(prompt, /# Change since the previous review\n[\s\S]*Number\(a\) \+ Number\(b\)/);
});
