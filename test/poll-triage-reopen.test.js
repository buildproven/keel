import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { poll } from '../src/poll.js';
import { fixtureRepo, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-triage-reopen-state-');
});

const issue = (over = {}) => ({
  id: 'BUI-1',
  title: 'fix the thing',
  description: '- REQ-1: it shall be fixed.',
  priority: 2,
  createdAt: '2026-09-01',
  labels: ['Bug'],
  estimate: null,
  blockedBy: [],
  ...over,
});

const runner =
  (ran) =>
  ({ card }) => {
    ran.push(card.id);
    return { pass: true, tier: 0, attempt: 1, branch: `keel/${card.id}`, needsReview: false, worktree: '/wt' };
  };

/** An in-memory Linear: the listed issues are open; comments are recorded. */
const fakeClient = (issues) => {
  const comments = [];
  return {
    comments,
    listIssues: async () => issues,
    comment: async (id, body) => comments.push({ id, body }),
    review: async () => {},
    stateType: async () => 'started',
  };
};

test('REQ-LINEAR-25 a notKeel issue that gains a keel block is built by the next poll', async () => {
  const { dir } = fixtureRepo();
  const ran = [];
  const triaged = issue({ id: 'BUI-2', priority: 1, title: 'Run the first five-player playtest' });
  const client = fakeClient([triaged]);
  await poll({ repo: dir, project: 'x', client, config: {}, runFn: runner(ran) });
  assert.deepEqual(ran, [], 'triaged, not built');
  triaged.description = `\`\`\`keel\nkind: chore\n\`\`\`\n\n${triaged.description}`;
  const r = await poll({ repo: dir, project: 'x', client, config: {}, runFn: runner(ran) });
  assert.deepEqual(ran, ['BUI-2'], 'the keel block overrides triage');
  assert.equal(r[0].outcome, 'inReview');
  await poll({ repo: dir, project: 'x', client, config: {}, runFn: runner(ran) });
  assert.deepEqual(ran, ['BUI-2'], 'built once: the new outcome is an attempt');
});

test('REQ-LINEAR-25 a notKeel issue whose text still reads as human work stays suppressed', async () => {
  const { dir } = fixtureRepo();
  const ran = [];
  const triaged = issue({ id: 'BUI-2', priority: 1, title: 'Run the first five-player playtest' });
  const client = fakeClient([triaged]);
  await poll({ repo: dir, project: 'x', client, config: {}, runFn: runner(ran) });
  triaged.description = 'Edited, but still no keel block.';
  await poll({ repo: dir, project: 'x', client, config: {}, runFn: runner(ran) });
  assert.deepEqual(ran, []);
  assert.equal(client.comments.length, 1, 'no second comment');
});
