import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseCard } from '../src/config.js';
import { gate } from '../src/gate.js';
import { commandTestGlobs } from '../src/scan.js';
import { recordGateTimes } from '../src/timing.js';
import { FIXED_SRC, REGRESSION_TEST, commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

/**
 * The gate without NODE_TEST_CONTEXT: node --test marks its test processes with it, and a `node --test` they start then
 * skips every file and passes. The fixture suites must run for real, as they do under `keel gate`.
 */
function gateOutsideNodeTest(args) {
  const saved = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    return gate(args);
  } finally {
    if (saved !== undefined) process.env.NODE_TEST_CONTEXT = saved;
  }
}

const card = () => parseCard('# T-1: test card\nkind: bug\nsize: S\n');

// node:test files, so a passing `node --test` prints test names and no file names, as keel's own suite does.
const testFile = (name, body, src = '../src') =>
  `import assert from 'node:assert';\nimport { test } from 'node:test';\nimport { add } from '${src}/add.js';\ntest('${name}', () => { ${body} });\n`;
const ADD_TEST = { 'test/add.test.js': testFile('adds', 'assert.strictEqual(add(2, 3), 5);') };

/** A repo whose `npm test` runs `node --test` over explicit file globs, as keel's own package.json does. */
const nodeTestRepo = (script = 'node --test --test-concurrency=2 test/*.test.js') =>
  fixtureRepo({
    'src/add.js': 'export const add = (a, b) => a - b;\n',
    'test/basic.test.js': testFile('basic', 'assert.ok(add);'),
    'package.json': JSON.stringify({ type: 'module', scripts: { test: script } }),
  });
const nodeConfig = () => fixtureConfig({ checks: { test: 'npm test' }, testCommand: 'npm test', testFilesCommand: 'node --test {files}' });

test('REQ-GATE-33 a new test file that matches a node --test glob of the npm test script runs alone on base', () => {
  const { dir, base } = nodeTestRepo();
  commit(dir, { ...ADD_TEST, ...FIXED_SRC });
  const r = gateOutsideNodeTest({ repo: dir, base, card: card(), config: nodeConfig() });
  assert.equal(r.pass, true, JSON.stringify(r.results, null, 2));
  const targeted = r.results.find((x) => x.name === 'targeted-on-head');
  assert.equal(targeted.targeted, true, JSON.stringify(targeted));
  assert.equal(targeted.unseen, undefined);
  assert.equal(r.results.find((x) => x.name === 'red-proof').targeted, true);
});

test('REQ-GATE-33 a new test file outside every node --test glob falls back to the whole suite, with unseen naming it', () => {
  const { dir, base } = nodeTestRepo();
  commit(dir, { 'test/unit/add.test.js': testFile('adds', 'assert.strictEqual(add(2, 3), 5);', '../../src'), ...FIXED_SRC });
  const r = gateOutsideNodeTest({ repo: dir, base, card: card(), config: nodeConfig() });
  const targeted = r.results.find((x) => x.name === 'targeted-on-head');
  assert.equal(targeted.targeted, false);
  assert.deepEqual(targeted.unseen, ['test/unit/add.test.js']);
  assert.deepEqual(
    r.results.flatMap((x) => x.problems.map((p) => p.rule)),
    ['test-passes-on-base'],
  );
});

test('REQ-GATE-33 the node --test globs of testCommand: file arguments only, none when tests are filtered or the directory changes', () => {
  const pkg = (test) => JSON.stringify({ scripts: { test, unit: 'node --test "test/**/*.test.js"' } });
  const cases = [
    [pkg('PATH="$PWD/bin:$PATH" node --test --test-concurrency=4 --import tsx test/*.test.js'), ['npm test'], ['test/*.test.js']],
    [pkg('node --test test/**/*.test.js'), ['npm test'], ['test/*/*.test.js']], // the shell's ** stays in one directory
    [pkg('node --test'), ['npm run unit'], ['test/**/*.test.js']], // a quoted glob is node's own, which spans directories
    [pkg('node --test'), ['npm test'], []],
    [pkg('node --test --test-name-pattern=x test/*.test.js'), ['npm test'], []],
    [pkg('node --test test/*.test.js'), ['npm test -- --test-name-pattern=x'], []],
    [pkg('cd pkg && node --test test/*.test.js'), ['npm test'], []],
    [pkg('mocha test/*.js'), ['npm test'], []],
    [null, ['node --test --test-reporter spec t/*.mjs'], ['t/*.mjs']],
  ];
  for (const [pkgText, commands, globs] of cases) assert.deepEqual(commandTestGlobs(pkgText, commands), globs, `${pkgText} ${commands}`);
});

test('REQ-GATE-33 the value of a node option is not a node --test glob, so a file only coverage names is not targeted, and `--` or a flag hides no glob', () => {
  const cases = [
    ["node --test --test-coverage-include 'test/unit/**/*.test.js' test/*.test.js", ['test/*.test.js']],
    ['node --import ./test/setup.js --test test/*.test.js', ['test/*.test.js']],
    ['node --test --test-reporter-destination out/report.js test/*.test.js', ['test/*.test.js']],
    ['node --test --experimental-test-coverage --test-coverage-exclude=x/*.js test/*.test.js', ['test/*.test.js']],
    ['node --test --test-randomize --cpu-prof test/*.test.js', ['test/*.test.js']], // a flag takes no value
    ['node -r ./test/setup.js --test test/*.test.js', ['test/*.test.js']],
    ['node --loader ./test/loader.js --test test/*.test.js', ['test/*.test.js']], // an alias of --experimental-loader=...
    ['node --inspect --test test/*.test.js', ['test/*.test.js']], // --inspect[=port] takes its value only with =
    ['node --test --test-isolation none --debug-port 9230 test/*.test.js', ['test/*.test.js']],
    ['node --test -- test/*.test.js', ['test/*.test.js']], // -- ends the options
    ['node --test --unknown-option test/a/*.test.js test/*.test.js', []], // a flag, or an option and its value?
  ];
  for (const [command, globs] of cases) assert.deepEqual(commandTestGlobs(null, [command]), globs, command);
});

/** The red-proof IMPROVE line of a gate whose red proof took 5 minutes, after `targetedOnHead` (null: no testFilesCommand). */
const slowRedProof = (targetedOnHead) => {
  const repo = fixtureRepo().dir;
  const file = join(tmp('keel-times-'), 'gate-times.jsonl');
  const results = [
    { name: 'test', pass: true, problems: [], ms: 1000 },
    ...(targetedOnHead ? [{ name: 'targeted-on-head', pass: true, problems: [], ...targetedOnHead }] : []),
    { name: 'red-proof', pass: true, problems: [], ms: 300_000 },
  ];
  return recordGateTimes(file, { repo, card: 'T-1', head: 'h', pass: true, results }).find((l) => l.includes('red-proof'));
};

test('REQ-GATE-46 with testFilesCommand set and an unseen new file, the red-proof IMPROVE line says the suite output names no file', () => {
  const line = slowRedProof({ targeted: false, unseen: ['test/unit/add.test.js'] });
  assert.match(line, /^IMPROVE: red-proof took 5m00s/);
  assert.match(line, /suite output names no new test file \(test\/unit\/add\.test\.js\)/);
  assert.doesNotMatch(line, /set testFilesCommand/);
});

test('REQ-GATE-46 with testFilesCommand set and a files command that failed on head, the red-proof IMPROVE line says so', () => {
  const line = slowRedProof({ targeted: false });
  assert.match(line, /testFilesCommand failed on head/);
  assert.doesNotMatch(line, /set testFilesCommand/);
});

test('REQ-GATE-46 without testFilesCommand, the red-proof IMPROVE line still says to set it', () => {
  assert.match(slowRedProof(null), /set testFilesCommand so the red proof runs only the new test files on base/);
});

/**
 * Commands that log each run (REQ-GATE-17): the whole suite writes `full` and names each file it runs, so the files
 * command is trusted (REQ-GATE-33); the files command writes its file arguments as JSON.
 */
function loggedCommands() {
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
const ADD_ASSERT = "import assert from 'node:assert';\nimport { add } from '../src/add.js';\nassert.strictEqual(add(2, 3), 5);\n";

test('REQ-GATE-17 a targeted red proof runs its base baseline with testFilesCommand on only the proof files that exist on base', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { 'test/basic.test.js': ADD_ASSERT, ...REGRESSION_TEST, ...FIXED_SRC });
  const { full, files, runs } = loggedCommands();
  const r = gate({
    repo: dir,
    base,
    card: parseCard('# T-1: test card\nkind: bug\nsize: S\nallowEdits: test/basic.test.js\n'),
    config: fixtureConfig({ checks: { test: full }, testCommand: full, testFilesCommand: files }),
  });
  assert.equal(r.pass, true, JSON.stringify(r.results, null, 2));
  const proof = ['test/add.test.js', 'test/basic.test.js'];
  // head: the whole suite (check) and the files command; base: the baseline of the base version of basic.test.js, then the overlay
  assert.deepEqual(runs(), ['full', proof, ['test/basic.test.js'], proof]);
});

test('REQ-GATE-17 a targeted red proof whose proof files are all new on base runs no base baseline', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC });
  const { full, files, runs } = loggedCommands();
  const r = gate({
    repo: dir,
    base,
    card: card(),
    config: fixtureConfig({ checks: { test: full }, testCommand: full, testFilesCommand: files }),
  });
  assert.equal(r.pass, true, JSON.stringify(r.results, null, 2));
  assert.deepEqual(runs(), ['full', ['test/add.test.js'], ['test/add.test.js']]);
});

test('REQ-GATE-17 a targeted base baseline that fails on base fails the red proof as baseline-not-green', () => {
  const { dir, base } = fixtureRepo({
    'src/add.js': 'export const add = (a, b) => a - b;\n',
    'test/basic.test.js': "import assert from 'node:assert';\nassert.ok(false);\n",
  });
  commit(dir, { 'test/basic.test.js': ADD_ASSERT, ...FIXED_SRC });
  const { full, files } = loggedCommands();
  const r = gate({
    repo: dir,
    base,
    card: parseCard('# T-1: test card\nkind: bug\nsize: S\nallowEdits: test/basic.test.js\n'),
    config: fixtureConfig({ checks: { test: full }, testCommand: full, testFilesCommand: files }),
  });
  assert.deepEqual(
    r.results.flatMap((x) => x.problems.map((p) => p.rule)),
    ['baseline-not-green'],
  );
});

test('REQ-GATE-17 without testFilesCommand, or when the red proof is not targeted, the base baseline runs the whole testCommand', () => {
  for (const withFiles of [false, true]) {
    const { dir, base } = fixtureRepo();
    commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC });
    const { full, files, runs } = loggedCommands();
    // The quiet suite names no file, so with testFilesCommand set the red proof is not targeted (REQ-GATE-33).
    const quiet = full.replace('echo "$f"; ', '');
    const r = gate({
      repo: dir,
      base,
      card: card(),
      config: fixtureConfig({ checks: { test: quiet }, testCommand: quiet, ...(withFiles ? { testFilesCommand: files } : {}) }),
    });
    assert.equal(r.pass, true, JSON.stringify(r.results, null, 2));
    // head check, the whole-suite base baseline, the whole-suite overlay
    assert.deepEqual(runs(), ['full', 'full', 'full'], `testFilesCommand ${withFiles}`);
  }
});
