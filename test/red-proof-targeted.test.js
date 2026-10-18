import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, parseCard } from '../src/config.js';
import { gate } from '../src/gate.js';
import { detectProject, proposeConfig } from '../src/init.js';
import { FIXED_SRC, REGRESSION_TEST, commit, fixtureConfig, fixtureRepo, tmp, write } from './helpers.js';

const card = () => parseCard('# T-1: test card\nkind: bug\nsize: S\n');

/** Fixture commands that log each run: the full suite writes `full`, the files command writes its argv as JSON. */
function logged() {
  const log = join(tmp('keel-log-'), 'runs');
  // Like FIXTURE_TEST, but it names each file it runs, as most runners do (REQ-GATE-33 needs that to trust the files command).
  const full = `echo full >> '${log}'; for f in test/*.js; do echo "$f"; node "$f" || exit 1; done`;
  const files = `node -e "require('fs').appendFileSync('${log}', JSON.stringify(process.argv.slice(1)) + '\\n')" -- {files}; for f in {files}; do node "$f" || exit 1; done`;
  const runs = () =>
    readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => (l === 'full' ? 'full' : JSON.parse(l)));
  return { full, files, runs };
}

test('REQ-GATE-33 with testFilesCommand, the red-proof overlay runs only the new test files, not the whole suite', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC });
  const { full, files, runs } = logged();
  const r = gate({
    repo: dir,
    base,
    card: card(),
    config: fixtureConfig({ checks: { test: full }, testCommand: full, testFilesCommand: files }),
  });
  assert.equal(r.pass, true, JSON.stringify(r.results, null, 2));
  // full suite on head (check); the files command on head and on the base overlay; no base baseline, as the file is new (REQ-GATE-17)
  assert.deepEqual(runs(), ['full', ['test/add.test.js'], ['test/add.test.js']]);
  assert.equal(r.results.find((x) => x.name === 'red-proof').targeted, true);
});

test('REQ-GATE-33 a targeted overlay that passes on base still fails the red proof', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { 'test/trivial.test.js': "import assert from 'node:assert';\nassert.ok(1);\n", ...FIXED_SRC });
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

test('REQ-GATE-33 file names reach the files command as single literal arguments, never as shell code', () => {
  const { dir, base } = fixtureRepo();
  const name = "test/it's $(echo x) `echo y`.test.js";
  commit(dir, { [name]: REGRESSION_TEST['test/add.test.js'], ...FIXED_SRC });
  const { full, files, runs } = logged();
  const r = gate({
    repo: dir,
    base,
    card: card(),
    config: fixtureConfig({ checks: { test: full }, testCommand: full, testFilesCommand: files }),
  });
  assert.equal(r.results.find((x) => x.name === 'targeted-on-head').targeted, true, JSON.stringify(r.results, null, 2));
  assert.deepEqual(runs().slice(1), [[name], [name]]); // on head, then on the base overlay
});

test('REQ-GATE-33 when the files command fails on head, the red proof falls back to the whole suite', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC });
  const { full, runs } = logged();
  const r = gate({
    repo: dir,
    base,
    card: card(),
    config: fixtureConfig({ checks: { test: full }, testCommand: full, testFilesCommand: 'exit 4 # {files}' }),
  });
  assert.equal(r.pass, true, JSON.stringify(r.results, null, 2));
  assert.deepEqual(runs(), ['full', 'full', 'full']);
  assert.equal(r.results.find((x) => x.name === 'red-proof').targeted, undefined);
  assert.equal(r.results.find((x) => x.name === 'targeted-on-head').targeted, false);
});

test('REQ-GATE-33 testFilesCommand must be null or a command with a {files} placeholder', () => {
  const { dir } = fixtureRepo();
  for (const value of ['pytest -q', '', 3]) {
    commit(dir, { 'keel.json': JSON.stringify({ checks: { test: 'true' }, testCommand: 'true', testFilesCommand: value }) });
    assert.throws(() => loadConfig(dir, 'HEAD'), /testFilesCommand/);
  }
  commit(dir, { 'keel.json': JSON.stringify({ checks: { test: 'true' }, testCommand: 'true', testFilesCommand: 'pytest -q {files}' }) });
  assert.equal(loadConfig(dir, 'HEAD').testFilesCommand, 'pytest -q {files}');
});

test('REQ-GATE-33 keel init proposes testFilesCommand for vitest and jest, whose passing output names files, for node --test over explicit globs, and none for the others', () => {
  const cases = [
    [{ 'pyproject.toml': '[project]\nname = "x"\n', 'uv.lock': '' }, undefined],
    [
      { 'package.json': JSON.stringify({ scripts: { test: 'node --test test/*.test.js' } }), 'package-lock.json': '{}' },
      'node --test {files}',
    ],
    [{ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }), 'pnpm-lock.yaml': '' }, 'pnpm exec vitest run {files}'],
    [{ 'package.json': JSON.stringify({ scripts: { test: 'jest --ci' } }), 'package-lock.json': '{}' }, 'npx jest {files}'],
    [{ 'go.mod': 'module x\n' }, undefined],
    [{ Makefile: 'test:\n\tpytest\n', 'pyproject.toml': '[project]\nname = "x"\n' }, undefined],
  ];
  for (const [files, expected] of cases) {
    const d = tmp();
    write(d, files);
    assert.equal(proposeConfig(detectProject(d)).testFilesCommand, expected, JSON.stringify(files));
  }
});

test('REQ-GATE-33 a new test file the whole suite does not run gets no targeted proof: the full overlay shows it never runs', () => {
  const { dir, base } = fixtureRepo();
  // testCommand runs test/*.js only, so test/unit/add.test.js never runs in the suite (or in CI)
  commit(dir, { 'test/unit/add.test.js': REGRESSION_TEST['test/add.test.js'].replace('../src', '../../src'), ...FIXED_SRC });
  const { full, files } = logged();
  const r = gate({
    repo: dir,
    base,
    card: card(),
    config: fixtureConfig({ checks: { test: full }, testCommand: full, testFilesCommand: files }),
  });
  assert.equal(r.results.find((x) => x.name === 'targeted-on-head').targeted, false);
  assert.deepEqual(r.results.find((x) => x.name === 'targeted-on-head').unseen, ['test/unit/add.test.js']);
  assert.deepEqual(
    r.results.flatMap((x) => x.problems.map((p) => p.rule)),
    ['test-passes-on-base'],
  );
});

test('REQ-GATE-33 a suite that runs another file with the same base name does not count as running the new file', () => {
  const { dir, base } = fixtureRepo(); // the suite runs test/basic.test.js
  commit(dir, { 'test/unit/basic.test.js': REGRESSION_TEST['test/add.test.js'].replace('../src', '../../src'), ...FIXED_SRC });
  const { full, files } = logged();
  const r = gate({
    repo: dir,
    base,
    card: card(),
    config: fixtureConfig({ checks: { test: full }, testCommand: full, testFilesCommand: files }),
  });
  assert.deepEqual(r.results.find((x) => x.name === 'targeted-on-head').unseen, ['test/unit/basic.test.js']);
  assert.deepEqual(
    r.results.flatMap((x) => x.problems.map((p) => p.rule)),
    ['test-passes-on-base'],
  );
});

test('REQ-GATE-33 a files command that passes on head only on a retry is not trusted: the red proof runs the whole suite', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC });
  const { full, runs } = logged();
  const seen = join(tmp('keel-flaky-'), 'seen');
  const flaky = `if [ -e '${seen}' ]; then exit 0; fi; touch '${seen}'; exit 1 # {files}`;
  const r = gate({
    repo: dir,
    base,
    card: card(),
    config: fixtureConfig({ checks: { test: full }, testCommand: full, testFilesCommand: flaky }),
  });
  assert.equal(r.pass, true, JSON.stringify(r.results, null, 2));
  assert.equal(r.results.find((x) => x.name === 'targeted-on-head').targeted, false);
  assert.deepEqual(runs(), ['full', 'full', 'full']);
});
