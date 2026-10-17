import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS, linkedDirs, loadConfig, parseCard } from '../src/config.js';
import { gate } from '../src/gate.js';
import { BUGGY, FIXED_SRC, FIXTURE_TEST, REGRESSION_TEST, commit, fixtureConfig, fixtureRepo } from './helpers.js';

const chore = () => parseCard('# T-1: install\nkind: chore\nsize: S\n');
const bug = () => parseCard('# T-2: install\nkind: bug\nsize: S\n');
const names = (r) => r.results.map((x) => x.name);

/** A repo whose ignored node_modules holds a file, like a real checkout after npm install. */
function repoWithModules(files = BUGGY) {
  const { dir, base } = fixtureRepo({ ...files, '.gitignore': 'node_modules/\ninstalled.marker\n' });
  mkdirSync(join(dir, 'node_modules'));
  writeFileSync(join(dir, 'node_modules', 'pkg.txt'), 'x\n');
  return { dir, base };
}

test('REQ-GATE-16 with install set, the candidate checkout runs it before the checks, as stage install', () => {
  const { dir, base } = repoWithModules();
  commit(dir, { 'notes.txt': 'x\n' });
  const config = fixtureConfig({ install: 'touch installed.marker', checks: { seen: 'test -f installed.marker' }, testCommand: 'true' });
  const r = gate({ repo: dir, base, card: chore(), config });
  assert.equal(r.pass, true, JSON.stringify(r.results));
  assert.ok(names(r).indexOf('install') < names(r).indexOf('seen'));
});

test('REQ-GATE-16 with install set, shared dependency dirs are not linked into the checkout', () => {
  const { dir, base } = repoWithModules();
  commit(dir, { 'notes.txt': 'x\n' });
  const check = { seen: 'test ! -e node_modules' };
  const withInstall = gate({
    repo: dir,
    base,
    card: chore(),
    config: fixtureConfig({ install: 'true', checks: check, testCommand: 'true' }),
  });
  assert.equal(withInstall.pass, true, JSON.stringify(withInstall.results));
  const without = gate({
    repo: dir,
    base,
    card: chore(),
    config: fixtureConfig({ checks: { seen: 'test -e node_modules' }, testCommand: 'true' }),
  });
  assert.equal(without.pass, true, 'control: without install the dir is still linked');
});

test('REQ-GATE-16 a failing install fails the gate as install-failed and runs no check', () => {
  const { dir, base } = repoWithModules();
  commit(dir, { 'notes.txt': 'x\n' });
  const config = fixtureConfig({ install: 'exit 7', checks: { touched: 'touch installed.marker' }, testCommand: 'true' });
  const r = gate({ repo: dir, base, card: chore(), config });
  assert.equal(r.pass, false);
  assert.deepEqual(
    r.results.flatMap((x) => x.problems.map((p) => p.rule)),
    ['install-failed'],
  );
  assert.deepEqual(
    names(r).filter((n) => n === 'touched'),
    [],
  );
});

test('REQ-GATE-16 the red-proof base checkout is installed too', () => {
  const { dir, base } = repoWithModules();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC });
  const testCommand = `test -f installed.marker && ${FIXTURE_TEST}`;
  const config = fixtureConfig({ install: 'touch installed.marker', checks: { test: testCommand }, testCommand });
  const r = gate({ repo: dir, base, card: bug(), config });
  assert.equal(r.pass, true, JSON.stringify(r.results));
  assert.ok(names(r).includes('red-proof'));
});

test('REQ-GATE-16 linkedDirs is empty when install is set and shareDirs otherwise', () => {
  assert.deepEqual(linkedDirs({ install: 'npm ci', shareDirs: ['node_modules'] }), []);
  assert.deepEqual(linkedDirs({ install: null, shareDirs: ['node_modules'] }), ['node_modules']);
});

test('REQ-CFG-1 install defaults to none and must be a non-empty string', () => {
  assert.equal(DEFAULTS.install, null);
  const { dir } = fixtureRepo();
  const at = (extra) => {
    commit(dir, { 'keel.json': JSON.stringify({ checks: { test: 'true' }, testCommand: 'true', ...extra }) }, 'cfg');
    return 'HEAD';
  };
  for (const bad of ['', 5, ['npm', 'ci']]) assert.throws(() => loadConfig(dir, at({ install: bad })), /install/);
  assert.equal(loadConfig(dir, at({ install: 'npm ci' })).install, 'npm ci');
  assert.ok(existsSync(join(dir, 'keel.json')));
});
