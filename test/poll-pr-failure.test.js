import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { poll } from '../src/poll.js';
import { fixtureRepo, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-poll-pr-');
});

test('REQ-LINEAR-18 a pass whose PR step failed is reported as prFailed, with the reason, and is not moved to review', async () => {
  const { dir } = fixtureRepo();
  const comments = [];
  const client = {
    listIssues: async () => [
      {
        id: 'BUI-1',
        title: 't',
        description: '- REQ-1: it shall work.',
        priority: 2,
        createdAt: '2026-09-01',
        labels: ['Bug'],
        estimate: null,
      },
    ],
    comment: async (id, body) => comments.push({ id, body }),
    review: async (id) => comments.push({ id, action: 'review' }),
    stateType: async () => 'started',
  };
  const runFn = () => ({
    pass: true,
    tier: 1,
    attempt: 2,
    branch: 'keel/BUI-1',
    needsReview: false,
    worktree: '/wt',
    pr: { ok: false, out: 'husky - pre-push script failed (code 1)' },
  });
  const [result] = await poll({ repo: dir, project: 'x', client, config: {}, runFn, pr: true });
  assert.equal(result.outcome, 'prFailed');
  assert.equal(comments.length, 1);
  assert.equal(comments[0].action, undefined, 'not moved to review');
  assert.match(comments[0].body, /the PR step failed[\s\S]*husky - pre-push script failed[\s\S]*keel\/BUI-1/);
});
