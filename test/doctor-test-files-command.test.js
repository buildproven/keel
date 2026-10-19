import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setupAdvice } from '../src/doctor.js';
import { commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const KEEL = fileURLToPath(new URL('../bin/keel.js', import.meta.url));

test('REQ-CLI-15 doctor advice names a missing testFilesCommand and the full-suite red proof it costs', () => {
  const advice = setupAdvice(fixtureConfig());
  assert.equal(advice.length, 1);
  assert.match(advice[0], /^testFilesCommand is not set: red proof reruns the whole test suite/);
});

test('REQ-CLI-15 doctor gives no testFilesCommand advice when it is set', () => {
  assert.deepEqual(setupAdvice(fixtureConfig({ testFilesCommand: 'node {files}' })), []);
});

test('REQ-CLI-15 keel doctor prints the testFilesCommand warning as WARN and exits 0', () => {
  const { dir } = fixtureRepo();
  const base = commit(dir, { 'keel.json': JSON.stringify({ testCommand: 'true', checks: { test: 'true' }, review: false }) });
  const r = spawnSync('node', [KEEL, 'doctor', '--repo', dir, '--base', base], {
    encoding: 'utf8',
    env: { ...process.env, KEEL_STATE_DIR: tmp() },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /WARN testFilesCommand is not set/);
});
