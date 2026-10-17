import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { attemptedIssueIds } from '../src/linear.js';
import { poll } from '../src/poll.js';
import { fixtureRepo, tmp } from './helpers.js';

const issue = (over = {}) => ({
  id: 'BUI-1',
  title: 'fix the thing',
  description: '- REQ-1: it shall be fixed.',
  priority: 2,
  createdAt: '2026-09-01',
  labels: ['Bug'],
  estimate: null,
  ...over,
});

function fakeClient(issues, comments) {
  return {
    listIssues: async () => issues,
    comment: async (id, body) => comments.push({ id, body }),
    review: async (id) => comments.push({ id, action: 'review' }),
    stateType: async () => 'started',
  };
}

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-poll-state-');
});

test('REQ-LINEAR-4 REQ-LINEAR-5 REQ-LINEAR-13 a passing, non-review run comments the branch and moves the issue to review', async () => {
  const { dir } = fixtureRepo();
  const comments = [];
  const client = fakeClient([issue()], comments);
  const runFn = () => ({ pass: true, tier: 0, attempt: 1, branch: 'keel/BUI-1', needsReview: false, worktree: '/wt' });
  const results = await poll({ repo: dir, project: 'x', client, config: {}, runFn });
  const result = results[0];
  assert.equal(result.outcome, 'inReview');
  assert.deepEqual(
    comments.map((c) => c.action),
    [undefined, 'review'],
  );
  assert.match(comments[0].body, /keel\/BUI-1/);
  assert.match(comments[0].body, /tier 0/);
});

test('REQ-LINEAR-5 a passing run that needs human review comments but changes no state', async () => {
  const { dir } = fixtureRepo();
  const comments = [];
  const client = fakeClient([issue()], comments);
  const runFn = () => ({ pass: true, tier: 2, attempt: 1, branch: 'keel/BUI-1', needsReview: true, worktree: '/wt' });
  const results = await poll({ repo: dir, project: 'x', client, config: {}, runFn });
  const result = results[0];
  assert.equal(result.outcome, 'needsReview');
  assert.deepEqual(
    comments.map((c) => c.action),
    [undefined],
  );
  assert.match(comments[0].body, /review/i);
});

test('REQ-LINEAR-4 a failing run comments the failure summary and leaves the issue open', async () => {
  const { dir } = fixtureRepo();
  const comments = [];
  const client = fakeClient([issue()], comments);
  const runFn = () => ({ pass: false, stopped: 'max-attempts', failure: 'red-proof: test-passes-on-base', worktree: '/wt' });
  const results = await poll({ repo: dir, project: 'x', client, config: {}, runFn });
  const result = results[0];
  assert.equal(result.outcome, 'failed');
  assert.deepEqual(
    comments.map((c) => c.action),
    [undefined],
  );
  assert.match(comments[0].body, /test-passes-on-base/);
  assert.match(comments[0].body, /\/wt/);
});

test('REQ-LINEAR-3 an unmappable issue is skipped (commented, not run) and polling continues to the next', async () => {
  const { dir } = fixtureRepo();
  const comments = [];
  const client = fakeClient([issue({ id: 'BUI-1', description: '' }), issue({ id: 'BUI-2', priority: 3 })], comments);
  let ran = null;
  const runFn = (args) => {
    ran = args.card.id;
    return { pass: true, tier: 0, attempt: 1, branch: 'keel/BUI-2', needsReview: false, worktree: '/wt' };
  };
  const results = await poll({ repo: dir, project: 'x', client, config: {}, runFn });
  const result = results[0];
  assert.equal(result.outcome, 'inReview');
  assert.equal(ran, 'BUI-2');
  assert.deepEqual(comments[0], { id: 'BUI-1', body: 'Skipped by keel poll: no description' });
});

test('REQ-LINEAR-1 REQ-LINEAR-6 no issue left to attempt returns none, and an issue moved to review is not attempted again', async () => {
  const { dir } = fixtureRepo();
  const client = fakeClient([issue()], []);
  const runFn = () => ({ pass: true, tier: 0, attempt: 1, branch: 'keel/BUI-1', needsReview: false, worktree: '/wt' });
  const first = (await poll({ repo: dir, project: 'x', client, config: {}, runFn }))[0];
  assert.equal(first.outcome, 'inReview');
  const second = (await poll({ repo: dir, project: 'x', client, config: {}, runFn: () => assert.fail('should not run again') }))[0];
  assert.equal(second.outcome, 'none');
  assert.deepEqual(attemptedIssueIds(dir), new Set(['BUI-1']));
});

test('REQ-LINEAR-8 --limit caps how many issues are attempted per invocation', async () => {
  const { dir } = fixtureRepo();
  const client = fakeClient([issue({ id: 'BUI-1' }), issue({ id: 'BUI-2', priority: 3 })], []);
  let count = 0;
  const runFn = () => {
    count += 1;
    return { pass: true, tier: 0, attempt: 1, branch: `keel/x${count}`, needsReview: false, worktree: '/wt' };
  };
  const results = await poll({ repo: dir, project: 'x', client, config: {}, runFn, limit: 2 });
  assert.equal(results.length, 2);
  assert.equal(count, 2);
});

test('REQ-LINEAR-10 resolveProject prefers --project, then keel.json linearProject, else fails naming both', async () => {
  const { resolveProject } = await import('../src/poll.js');
  assert.equal(resolveProject('cli-proj', { linearProject: 'cfg-proj' }), 'cli-proj');
  assert.equal(resolveProject(undefined, { linearProject: 'cfg-proj' }), 'cfg-proj');
  assert.throws(() => resolveProject(undefined, { linearProject: null }), /--project.*linearProject|linearProject.*--project/);
});

test('REQ-LINEAR-10 keel.json linearProject defaults to none and must be a non-empty string', async () => {
  const { DEFAULTS, loadConfig } = await import('../src/config.js');
  const { commit, fixtureRepo } = await import('./helpers.js');
  assert.equal(DEFAULTS.linearProject, null);
  const { dir } = fixtureRepo();
  const at = (extra) => {
    commit(dir, { 'keel.json': JSON.stringify({ checks: { test: 'true' }, testCommand: 'true', ...extra }) }, 'cfg');
    return 'HEAD';
  };
  assert.throws(() => loadConfig(dir, at({ linearProject: '' })), /linearProject/);
  assert.throws(() => loadConfig(dir, at({ linearProject: 7 })), /linearProject/);
  assert.equal(loadConfig(dir, at({ linearProject: 'keel' })).linearProject, 'keel');
});

test('REQ-LINEAR-10 keel poll with no project anywhere is a usage error, not a stack trace', async () => {
  const { spawnSync } = await import('node:child_process');
  const { commit, fixtureRepo } = await import('./helpers.js');
  const { dir } = fixtureRepo();
  commit(dir, { 'keel.json': JSON.stringify({ checks: { test: 'true' }, testCommand: 'true' }) }, 'cfg');
  const r = spawnSync(process.execPath, [new URL('../bin/keel.js', import.meta.url).pathname, 'poll', '--repo', dir], { encoding: 'utf8' });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^keel: .*linearProject/m);
  assert.doesNotMatch(r.stderr, /\n\s+at /);
});

test('REQ-LINEAR-15 a blocked card comments the worker reason, leaves the issue open, and is outcome blocked', async () => {
  const { dir } = fixtureRepo();
  const comments = [];
  const client = fakeClient([issue()], comments);
  const runFn = () => ({ pass: false, stopped: 'blocked', failure: 'schema has no such column', worktree: '/wt' });
  const [result] = await poll({ repo: dir, project: 'x', client, config: {}, runFn });
  assert.equal(result.outcome, 'blocked');
  assert.equal(comments.length, 1, 'one comment, no state change');
  assert.match(comments[0].body, /worker reported the card blocked/);
  assert.match(comments[0].body, /schema has no such column/);
  assert.match(comments[0].body, /\/wt/);
});

test('REQ-LINEAR-16 an issue closed while Keel ran is not moved: one comment, outcome closedMeanwhile', async () => {
  const { dir } = fixtureRepo();
  const comments = [];
  const client = { ...fakeClient([issue()], comments), stateType: async () => 'completed' };
  const runFn = () => ({ pass: true, tier: 0, attempt: 1, branch: 'keel/BUI-1', needsReview: false, worktree: '/wt' });
  const [result] = await poll({ repo: dir, project: 'x', client, config: {}, runFn });
  assert.equal(result.outcome, 'closedMeanwhile');
  assert.deepEqual(
    comments.map((c) => c.action),
    [undefined],
    'commented once, never moved to review',
  );
  assert.match(comments[0].body, /closed while keel ran/i);
  assert.match(comments[0].body, /keel\/BUI-1/);
});
