import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCard } from '../src/config.js';
import { gate } from '../src/gate.js';
import { FIXED_SRC, REGRESSION_TEST, commit, fixtureConfig, fixtureRepo, g } from './helpers.js';

const card = parseCard('# T-1: test card\nkind: bug\nsize: S\n');

/** A branch made from main, and main moving on after it with a new test and a new package.json script. */
function behindMain() {
  const { dir } = fixtureRepo();
  g(dir, 'checkout', '-q', '-b', 'fix');
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC }, 'fix: add');
  g(dir, 'checkout', '-q', 'main');
  commit(dir, { 'test/later.test.js': "import assert from 'node:assert';\nassert.ok(true);\n" }, 'test: later');
  g(dir, 'checkout', '-q', 'fix');
  return dir;
}

test('REQ-GATE-40 a branch behind its base is judged on what it changed since it left the base, not on the base moving', () => {
  const dir = behindMain();
  const r = gate({ repo: dir, base: 'main', card, config: fixtureConfig() });
  const rules = r.results.flatMap((x) => x.problems.map((p) => p.rule));
  assert.ok(!rules.includes('existing-test-changed'), `main's newer test is not the branch's deletion: ${JSON.stringify(rules)}`);
  assert.equal(r.pass, true, JSON.stringify(r.results, null, 2));
});

test('REQ-GATE-40 an existing test the branch itself deletes still fails, measured from where it left the base', () => {
  const dir = behindMain();
  commit(dir, { 'test/basic.test.js': null }, 'chore: drop');
  const r = gate({ repo: dir, base: 'main', card, config: fixtureConfig() });
  assert.ok(r.results.flatMap((x) => x.problems.map((p) => p.rule)).includes('existing-test-changed'));
});

test('REQ-GATE-40 a runner file the base newly calls from an npm script stays locked for a branch made before it', () => {
  const { dir } = fixtureRepo({
    'src/add.js': 'export const add = (a, b) => a - b;\n',
    'test/basic.test.js': "import assert from 'node:assert';\nassert.ok(true);\n",
    'scripts/t.sh': 'for f in test/*.js; do node "$f" || exit 1; done\n',
    'package.json': JSON.stringify({ scripts: { test: 'echo none' } }),
  });
  g(dir, 'checkout', '-q', '-b', 'fix');
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC, 'scripts/t.sh': 'exit 0\n' }, 'fix: add');
  g(dir, 'checkout', '-q', 'main');
  commit(dir, { 'package.json': JSON.stringify({ scripts: { test: 'sh scripts/t.sh' } }) }, 'chore: run tests through t.sh');
  g(dir, 'checkout', '-q', 'fix');
  const r = gate({ repo: dir, base: 'main', card, config: fixtureConfig({ checks: { test: 'npm test' }, testCommand: 'npm test' }) });
  assert.ok(r.results.flatMap((x) => x.problems.map((p) => p.rule)).includes('runner-script-changed'), JSON.stringify(r.results));
});
