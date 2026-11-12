// BUI-1699 review follow-ups: helper files must not count as tests, by name or in a stack frame.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { parseCard } from '../src/config.js';
import { gate, heldOutTestCommand, proofFiles } from '../src/gate.js';
import { FIXED_SRC, commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

const SUITE = 'for f in test/*.js; do echo "$f"; node "$f" || exit 1; done';
const FILES = 'for f in {files}; do node "$f" || exit 1; done';

test('REQ-GATE-52 with no runnable test name on base, a helper in a targeted stack frame does not block base-red-fixed', () => {
  // Neither file has a runnable name (as with cargo's tests/*.rs); test/a.js fails on base inside test/helpers.js.
  const helper = "import assert from 'node:assert';\nexport const same = (a, b) => assert.strictEqual(a, b);\n";
  const red = "import { add } from '../src/add.js';\nimport { same } from './helpers.js';\nsame(add(1, 1), 2);\n";
  const { dir, base } = fixtureRepo({ 'src/add.js': 'export const add = (a, b) => a - b;\n', 'test/helpers.js': helper, 'test/a.js': red });
  commit(dir, { ...FIXED_SRC, 'test/a.js': `${red}same(add(2, 3), 5);\n` });
  const config = fixtureConfig({ testCommand: SUITE, checks: { test: SUITE }, testFilesCommand: FILES });
  const r = gate({ repo: dir, base, card: parseCard('# T-1: c\nkind: bug\nsize: S\nallowEdits: test/a.js\n'), config });
  assert.equal(r.pass, true, JSON.stringify(r.results, null, 1));
  const proof = r.results.find((x) => x.name === 'red-proof');
  assert.deepEqual([proof.targeted, proof.baseRedFixed], [true, ['test/a.js']]);
});

test('REQ-GATE-64 a test-*.js named for a helper is not a runnable test file; other test-*.js names are', () => {
  const helpers = ['test/test-utils.js', 'test-helpers.mjs', 'test/test-setup.cjs', 'test/test-util.js', 'test/test-fixtures.js'];
  const tests = ['test/test-add.js', 'test-utilsmore.js'];
  const ctx = {
    changed: [...helpers, ...tests].map((path) => ({ path, status: 'A' })),
    config: { testGlobs: ['**/*.js', '**/*.mjs', '**/*.cjs'] },
  };
  assert.deepEqual(proofFiles(ctx).sort(), [...tests].sort());
  const command = heldOutTestCommand({ heldOutFilesCommand: 'run {files}' }, ['test/test-add.js', 'test/test-utils.js']);
  assert.match(command, /test-add\.js/);
  assert.doesNotMatch(command, /test-utils/);
});
