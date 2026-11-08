import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS, parseCard } from '../src/config.js';
import { gate, proofFiles } from '../src/gate.js';
import { FIXED_SRC, commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const card = () => parseCard('# T-1: test card\nkind: bug\nsize: S\n');
const added = (...paths) => paths.map((path) => ({ status: 'A', path }));
const proof = (...paths) => proofFiles({ changed: added(...paths), config: structuredClone(DEFAULTS) });

/** Fixture commands that log each run: the full suite writes `full`, the files command writes its argv as JSON. */
function logged() {
  const log = join(tmp('keel-log-'), 'runs');
  const full = `echo full >> '${log}'; for f in test/*.js; do echo "$f"; node "$f" || exit 1; done`;
  const files = `node -e "require('fs').appendFileSync('${log}', JSON.stringify(process.argv.slice(1)) + '\\n')" -- {files}; for f in {files}; do node "$f" || exit 1; done`;
  const runs = () =>
    readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => (l === 'full' ? 'full' : JSON.parse(l)));
  return { full, files, runs };
}

/** A new test that reads its fixture, so it needs the fixture on base too. */
const fixtureTest = (expected) => ({
  'test/add.test.js': `import assert from 'node:assert';\nimport { readFileSync } from 'node:fs';\nimport { add } from '../src/add.js';\nconst { a, b } = JSON.parse(readFileSync(new URL('./fixtures/x.json', import.meta.url)));\nassert.strictEqual(add(a, b), ${expected});\n`,
  'test/fixtures/x.json': '{ "a": 2, "b": 3 }\n',
});

test('REQ-GATE-64 a diff adding tests/a.test.js and tests/fixtures/x.json gives a proof set of tests/a.test.js only', () => {
  assert.deepEqual(proof('tests/a.test.js', 'tests/fixtures/x.json'), ['tests/a.test.js']);
});

test('REQ-GATE-64 runnable test-file names stay in the proof set; data and support files under a test glob do not', () => {
  const runnable = [
    'test/a.spec.ts',
    'tests/test_x.py',
    'tests/x_test.py',
    'pkg/x_test.go',
    'spec/x_spec.rb',
    'src/__tests__/a.js',
    'src/__tests__/deep/b.tsx',
    'src/test/java/FooTest.java',
    'src/test/java/FooTests.java',
    'src/test/kotlin/FooTest.kt',
    'Tests/FooTest.cs',
  ];
  const support = [
    'tests/fixtures/trigger-events/a.json',
    'tests/conftest.py',
    'tests/__init__.py',
    'src/__tests__/fixtures/x.json',
    'src/__tests__/__snapshots__/a.js.snap',
    'test/data.yaml',
    'tests/fixtures/payload_test.json',
    'test/helpers/test_data.json',
  ];
  assert.deepEqual(proof(...runnable, ...support), runnable);
});

test('REQ-GATE-64 when no added file has a runnable test-file name, every added test-glob file stays in the proof set', () => {
  // A runner that takes any file in its directory (cargo's tests/*.rs, `node --test test/`) keeps the old proof set.
  assert.deepEqual(proof('tests/integration.rs', 'tests/fixtures/x.json'), ['tests/integration.rs', 'tests/fixtures/x.json']);
  assert.deepEqual(proofFiles({ changed: [{ status: 'D', path: 'tests/a.test.js' }], config: structuredClone(DEFAULTS) }), []);
});

test('REQ-GATE-65 a diff that adds fixtures beside its new test runs only the new test on base, with no unseen entry', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...fixtureTest(5), ...FIXED_SRC });
  const { full, files, runs } = logged();
  const r = gate({
    repo: dir,
    base,
    card: card(),
    config: fixtureConfig({ checks: { test: full }, testCommand: full, testFilesCommand: files }),
  });
  assert.equal(r.pass, true, JSON.stringify(r.results, null, 2));
  const targeted = r.results.find((x) => x.name === 'targeted-on-head');
  assert.equal(targeted.targeted, true);
  assert.equal(Object.hasOwn(targeted, 'unseen'), false);
  const red = r.results.find((x) => x.name === 'red-proof');
  assert.equal(red.targeted, true);
  assert.deepEqual(red.files, ['test/add.test.js']);
  // full suite on head (check); the files command on head and on the base overlay; never the whole suite on base
  assert.deepEqual(runs(), ['full', ['test/add.test.js'], ['test/add.test.js']]);
});

test('REQ-GATE-65 the fixtures a new test reads are overlaid on base too, so a missing fixture never fakes a red proof', () => {
  // The test expects add(2, 3) to be -1, true on buggy base: it must pass on base and fail the red proof. Without its
  // fixture on base it would throw there instead, a false "fails on base".
  const { dir, base } = fixtureRepo();
  commit(dir, { ...fixtureTest(-1) });
  const { full, files } = logged();
  const r = gate({
    repo: dir,
    base,
    card: card(),
    config: fixtureConfig({ checks: { test: full }, testCommand: full, testFilesCommand: files }),
  });
  assert.deepEqual(
    r.results.flatMap((x) => x.problems.map((p) => p.rule)),
    ['test-passes-on-base'],
  );
});
