import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { doctor } from '../src/doctor.js';
import { commit, fixtureConfig, fixtureRepo } from './helpers.js';

const BIN = new URL('../bin/keel.js', import.meta.url).pathname;
const line = (rows, name) => rows.find((r) => r.name === name);

test('REQ-CLI-3 doctor reports each check and the test command as pass or fail on a fresh checkout of base', () => {
  const { dir, base } = fixtureRepo();
  const config = fixtureConfig({ checks: { lint: 'true', build: 'exit 3' }, testCommand: 'exit 0' });
  const rows = doctor({ repo: dir, base, config });
  assert.equal(line(rows, 'lint').pass, true);
  assert.equal(line(rows, 'build').pass, false);
  assert.equal(line(rows, 'test').kind, 'test');
  assert.equal(line(rows, 'test').pass, true);
});

test('REQ-CLI-3 the test command is not run twice when a check already is the test command', () => {
  const { dir, base } = fixtureRepo();
  const rows = doctor({ repo: dir, base, config: fixtureConfig({ checks: { test: 'true' }, testCommand: 'true' }) });
  assert.deepEqual(
    rows.map((r) => r.name),
    ['test'],
  );
});

test('REQ-CLI-3 doctor prepares the checkout the way the gate does: install runs and shared dirs are not linked', () => {
  const { dir, base } = fixtureRepo();
  const config = fixtureConfig({ install: 'touch installed.marker', checks: { seen: 'test -f installed.marker' }, testCommand: 'true' });
  const rows = doctor({ repo: dir, base, config });
  assert.equal(line(rows, 'install').pass, true);
  assert.equal(line(rows, 'seen').pass, true);
});

test('REQ-CLI-3 a failing install is reported and no check runs', () => {
  const { dir, base } = fixtureRepo();
  const config = fixtureConfig({ install: 'exit 9', checks: { lint: 'true' }, testCommand: 'true' });
  const rows = doctor({ repo: dir, base, config });
  assert.deepEqual(
    rows.map((r) => [r.name, r.pass]),
    [['install', false]],
  );
});

test('REQ-CLI-3 acceptance commands are informational: green or red, never a failure', () => {
  const { dir, base } = fixtureRepo();
  const config = fixtureConfig({ checks: { lint: 'true' }, testCommand: 'true', acceptance: { ok: 'true', audit: 'exit 1' } });
  const rows = doctor({ repo: dir, base, config });
  assert.equal(line(rows, 'ok').kind, 'acceptance');
  assert.equal(line(rows, 'ok').pass, true);
  assert.equal(line(rows, 'audit').pass, false);
});

function cli(dir, keelJson) {
  commit(dir, { 'keel.json': JSON.stringify(keelJson) }, 'cfg');
  return spawnSync(process.execPath, [BIN, 'doctor', '--repo', dir, '--base', 'HEAD'], { encoding: 'utf8' });
}

test('REQ-CLI-3 keel doctor exits 0 with PASS lines when every check passes, and INFO for acceptance', () => {
  const { dir } = fixtureRepo();
  const r = cli(dir, { checks: { lint: 'true' }, testCommand: 'exit 0', acceptance: { audit: 'exit 1' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /PASS check lint/);
  assert.match(r.stderr, /PASS test test/);
  assert.match(r.stderr, /INFO acceptance audit \(red\)/);
});

test('REQ-CLI-3 keel doctor exits 1 and names the failing check', () => {
  const { dir } = fixtureRepo();
  const r = cli(dir, { checks: { lint: 'true', build: 'exit 3' }, testCommand: 'exit 0' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /FAIL check build/);
});
