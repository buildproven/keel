import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { gate } from '../src/gate.js';
import { scriptsAppendOnly } from '../src/scan.js';
import { commit, fixtureConfig, fixtureRepo } from './helpers.js';

const pkg = (scripts) => `${JSON.stringify({ type: 'module', scripts }, null, 2)}\n`;
const globs = DEFAULTS.testGlobs;
const check = (before, after, command = 'npm test') => scriptsAppendOnly(pkg(before), pkg(after), [command], globs);

test('REQ-GATE-42 a test script that only gains test files at its end is append-only', () => {
  assert.equal(check({ test: 'node --test test/a.test.js' }, { test: 'node --test test/a.test.js test/b.test.js' }), null);
  assert.equal(
    check({ test: "node --test 'test/a.test.js'" }, { test: "node --test 'test/a.test.js' 'test/**/*.test.js' test/c.test.js" }),
    null,
  );
  // A script the test command runs through `npm run` counts too.
  assert.equal(
    check(
      { test: 'npm run unit', unit: 'node --test test/a.test.js' },
      { test: 'npm run unit', unit: 'node --test test/a.test.js test/b.test.js' },
    ),
    null,
  );
});

test('REQ-GATE-42 a removal, flag, shell operator, or non-test file in the test script stays locked', () => {
  const base = { test: 'node --test test/a.test.js test/b.test.js' };
  assert.match(check(base, { test: 'node --test test/b.test.js' }), /append/);
  assert.match(check(base, { test: 'node --test test/a.test.js' }), /append/);
  assert.match(check(base, { test: 'node --test test/a.test.js test/b.test.js --test-only' }), /test file/);
  assert.match(check(base, { test: 'node --test test/a.test.js test/b.test.js || true' }), /test file/);
  assert.match(check(base, { test: 'node --test test/a.test.js test/b.test.js;true' }), /test file/);
  assert.match(check(base, { test: 'node --test test/a.test.js test/b.test.js src/setup.js' }), /test file/);
  assert.match(check(base, { test: 'node --test test/a.test.js test/b.test.js $(echo x.test.js)' }), /test file/);
  assert.match(check(base, { test: 'node --test test/a.test.js test/b.test.js lib/*' }), /test file/);
  assert.match(check(base, { test: 'node   --test test/a.test.js test/b.test.js test/c.test.js' }), /append/);
});

test('REQ-GATE-42 a runner that discovered every test is not narrowed by a first file argument', () => {
  // `node --test` alone runs every test; `node --test x.test.js` runs only x. The base must already list files.
  assert.match(check({ test: 'node --test' }, { test: 'node --test test/b.test.js' }), /does not end with a test file/);
  assert.match(check({ test: 'vitest run' }, { test: 'vitest run test/b.test.js' }), /does not end with a test file/);
});

test('REQ-GATE-42 a new script, a removed script, or a script the test command does not run stays locked', () => {
  const base = { test: 'node --test test/a.test.js', lint: 'eslint test/a.test.js' };
  assert.match(check(base, { ...base, pretest: 'node test/a.test.js' }), /added or removed/);
  assert.match(check(base, { test: base.test }), /added or removed/);
  assert.match(check(base, { ...base, lint: 'eslint test/a.test.js test/b.test.js' }), /lint.*test command/);
  assert.match(scriptsAppendOnly(null, pkg(base), ['npm test'], globs), /new/);
});

test('REQ-GATE-42 the gate passes an append-only test script edit and records why; any other script edit stays locked', () => {
  const card = { id: 'c1', kind: 'chore', size: 'S', paths: [], allowEdits: [], acceptance: [], heldOut: null, text: '# c1\n' };
  const config = fixtureConfig({ checks: {}, testCommand: 'npm test' });
  const { dir, base } = fixtureRepo({ 'package.json': pkg({ test: 'node --test test/a.test.js' }), 'test/a.test.js': '\n' });
  commit(dir, { 'package.json': pkg({ test: 'node --test test/a.test.js test/b.test.js' }), 'test/b.test.js': '\n' });
  const ok = gate({ repo: dir, base, card, config });
  assert.equal(ok.pass, true, JSON.stringify(ok.results));
  const locked = ok.results.find((r) => r.name === 'locked');
  assert.deepEqual(locked.relaxed, [{ path: 'package.json', rule: 'package-scripts-changed', proof: 'append-only test files' }]);

  commit(dir, { 'package.json': pkg({ test: 'node --test test/b.test.js' }) });
  const bad = gate({ repo: dir, base, card, config });
  assert.equal(bad.pass, false);
  const problem = bad.results.find((r) => r.name === 'locked').problems[0];
  assert.equal(problem.rule, 'package-scripts-changed');
  assert.match(problem.why, /append/);
});
