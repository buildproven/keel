import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
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
