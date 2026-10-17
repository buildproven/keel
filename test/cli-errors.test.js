import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { tmp } from './helpers.js';

const BIN = new URL('../bin/keel.js', import.meta.url).pathname;
const keel = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });

test('REQ-CLI-2 keel init on a directory with no project marker is a usage error, not a stack trace', () => {
  const r = keel('init', '--repo', tmp('keel-empty-'));
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^keel: no project marker found/m);
  assert.doesNotMatch(r.stderr, /\n\s+at /);
});

test('REQ-CLI-2 a --repo that is not a directory is a usage error for every repo command', () => {
  for (const cmd of [['init'], ['gate', '--base', 'HEAD', '--card', 'c.md'], ['run', 'c.md'], ['poll', '--project', 'p']]) {
    const r = keel(...cmd, '--repo', '/nonexistent/keel-test-dir');
    assert.equal(r.status, 2, `${cmd[0]}: ${r.stderr}`);
    assert.match(r.stderr, /^keel: .*--repo .*not a directory/m);
    assert.doesNotMatch(r.stderr, /\n\s+at /);
  }
});
