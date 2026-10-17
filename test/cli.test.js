import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { commit, fixtureRepo } from './helpers.js';

const keel = (...args) => spawnSync(process.execPath, ['bin/keel.js', ...args], { encoding: 'utf8' });

test('REQ-CLI-1 --help, -h, and no command print usage to stdout and exit 0', () => {
  for (const args of [['--help'], ['-h'], []]) {
    const r = keel(...args);
    assert.equal(r.status, 0, `keel ${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stdout, /keel gate \[--base <ref>\] \[--card <card.md>\]/);
    assert.equal(r.stderr, '');
  }
});

test('REQ-CLI-2 an unknown option prints one keel: line and usage, exits 2, no stack trace', () => {
  const r = keel('gate', '--bogus');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^keel: .*--bogus/m);
  assert.match(r.stderr, /keel gate \[--base/);
  assert.doesNotMatch(r.stderr, /\n\s+at /);
});

test('REQ-CLI-2 an unknown command exits 2 with usage on stderr', () => {
  const r = keel('frobnicate');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^keel: unknown command "frobnicate"/m);
  assert.equal(r.stdout, '');
});

test('REQ-CLI-2 a missing required argument exits 2 without a stack trace', () => {
  // poll reads keel.json from the repo it runs in, so give it a fixture with no linearProject
  // instead of whatever repo the tests happen to run from.
  const { dir } = fixtureRepo();
  commit(dir, { 'keel.json': JSON.stringify({ checks: { test: 'true' }, testCommand: 'true' }) }, 'cfg');
  for (const args of [['gate', '--repo', dir], ['run'], ['poll', '--repo', dir]]) {
    const r = keel(...args);
    assert.equal(r.status, 2, `keel ${args.join(' ')}`);
    assert.match(r.stderr, /^keel: /m);
    assert.doesNotMatch(r.stderr, /\n\s+at /);
  }
});
