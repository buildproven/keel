import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { attemptedIssueIds } from '../src/linear.js';
import { poll } from '../src/poll.js';
import { fixtureRepo, g, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-poll-defer-');
});

const issue = {
  id: 'BUI-7',
  title: 't',
  description: '- REQ-1: it shall work.',
  priority: 2,
  createdAt: '2026-09-01',
  labels: ['Bug'],
  estimate: null,
};

for (const stopped of ['quota', 'review-unavailable']) {
  test(`REQ-LINEAR-19 a run stopped by ${stopped} is deferred: its clean worktree goes, and the next poll retries the issue`, async () => {
    const { dir } = fixtureRepo();
    const comments = [];
    const client = {
      listIssues: async () => [issue],
      comment: async (id, body) => comments.push({ id, body }),
      review: async (id) => comments.push({ id, action: 'review' }),
      stateType: async () => 'started',
    };
    let calls = 0;
    const runFn = () => {
      calls += 1;
      const wt = join(tmp('keel-wt-'), 'wt');
      g(dir, 'worktree', 'add', '-q', '-b', `keel/BUI-7-${calls}`, wt);
      return { pass: false, stopped, branch: `keel/BUI-7-${calls}`, worktree: wt, failure: 'You have hit your usage limit' };
    };
    const [first] = await poll({ repo: dir, project: 'x', client, config: {}, runFn });
    assert.equal(first.outcome, 'deferred');
    assert.equal(existsSync(first.result.worktree), false, 'the parked worktree would block a retry');
    assert.equal(attemptedIssueIds(dir).has('BUI-7'), false);
    assert.match(comments[0].body, new RegExp(`deferred \\(${stopped}\\)[\\s\\S]*next poll`));
    const [second] = await poll({ repo: dir, project: 'x', client, config: {}, runFn });
    assert.equal(second.outcome, 'deferred');
    assert.equal(calls, 2, 'the issue was picked again');
  });
}
