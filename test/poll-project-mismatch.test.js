import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { beforeEach, test } from 'node:test';
import { poll, resolveProject } from '../src/poll.js';
import { UsageError } from '../src/usage.js';
import { commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-poll-mismatch-state-');
});

// Every client method fails the test: a mismatch must stop before Linear is called.
const untouchedClient = () =>
  new Proxy({}, { get: (_, name) => () => assert.fail(`Linear client ${String(name)} called despite a project mismatch`) });

test('REQ-LINEAR-34 resolveProject refuses a --project that differs from keel.json linearProject, naming both and the repo', () => {
  assert.throws(
    () => resolveProject('keel', { linearProject: 'dead-man-working' }, '/repos/dead-man-working'),
    (e) =>
      e instanceof UsageError &&
      /keel/.test(e.message) &&
      /dead-man-working/.test(e.message) &&
      e.message.includes('/repos/dead-man-working'),
  );
  assert.throws(() => resolveProject('keel', { linearProject: 'dead-man-working' }), UsageError);
});

test('REQ-LINEAR-34 poll with a mismatched project makes no Linear call and runs no card', async () => {
  const { dir } = fixtureRepo();
  await assert.rejects(
    () =>
      poll({
        repo: dir,
        project: 'keel',
        client: untouchedClient(),
        config: fixtureConfig({ linearProject: 'dead-man-working' }),
        runFn: () => assert.fail('runFn called despite a project mismatch'),
        refineFn: () => assert.fail('refineFn called despite a project mismatch'),
      }),
    (e) => e instanceof UsageError && e.message.includes(dir),
  );
  await assert.rejects(
    () =>
      poll({
        repo: dir,
        project: 'keel',
        client: untouchedClient(),
        config: fixtureConfig({ linearProject: 'dead-man-working' }),
        runFn: () => assert.fail('runFn called despite a project mismatch'),
        refineFn: () => assert.fail('refineFn called despite a project mismatch'),
        issue: 'BUI-1325',
      }),
    UsageError,
  );
});

test('REQ-LINEAR-34 keel poll --project against a repo with another linearProject exits 2 naming both', () => {
  const { dir } = fixtureRepo();
  commit(dir, { 'keel.json': JSON.stringify({ checks: { test: 'true' }, testCommand: 'true', linearProject: 'dead-man-working' }) }, 'cfg');
  const bin = new URL('../bin/keel.js', import.meta.url).pathname;
  const r = spawnSync(process.execPath, [bin, 'poll', '--repo', dir, '--project', 'keel', '--issue', 'BUI-1325'], {
    encoding: 'utf8',
    env: { ...process.env, LINEAR_API_KEY: '' },
  });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^keel: .*keel.*dead-man-working|^keel: .*dead-man-working.*keel/m);
  assert.doesNotMatch(r.stderr, /\n\s+at /);
});

test('REQ-LINEAR-35 resolveProject keeps --project when it equals linearProject or keel.json sets none', () => {
  assert.equal(resolveProject('keel', { linearProject: 'keel' }), 'keel');
  assert.equal(resolveProject('keel', { linearProject: null }), 'keel');
  assert.equal(resolveProject('keel', {}), 'keel');
  assert.equal(resolveProject(undefined, { linearProject: 'keel' }), 'keel');
});
