import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { poll } from '../src/poll.js';
import { fixtureRepo, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-poll-mutants-state-');
});

test('REQ-LINEAR-4 poll without pr or merge options asks the run not to open a PR', async () => {
  const { dir } = fixtureRepo();
  const seen = [];
  const runFn = (opts) => {
    seen.push(opts);
    return { pass: true, tier: 0, attempt: 1, branch: 'keel/BUI-1', needsReview: false, worktree: '/wt' };
  };
  const client = {
    listIssues: async () => [
      {
        id: 'BUI-1',
        title: 'fix the thing',
        description: '- REQ-1: it shall be fixed.',
        priority: 2,
        createdAt: '2026-09-01',
        labels: ['Bug'],
        estimate: null,
      },
    ],
    comment: async () => {},
    review: async () => {},
    stateType: async () => 'started',
  };
  await poll({ repo: dir, project: 'x', client, config: {}, runFn });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].pr, false);
  assert.equal(seen[0].merge, false);
});
