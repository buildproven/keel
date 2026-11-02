import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { poll } from '../src/poll.js';
import { pollLedgerFile } from '../src/linear.js';
import { readJsonl } from '../src/ledger.js';
import { fixtureRepo, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-skipped-repick-state-');
});

const MALFORMED = '```keel\nkind: bug\npaths:\n- lib/campaign/repository.ts\n```\n\n- REQ-1: it shall be fixed.';
const VALID = '```keel\nkind: bug\npaths: lib/campaign/**\n```\n\n- REQ-1: it shall be fixed.';

const issue = (over = {}) => ({
  id: 'BUI-1467',
  title: 'workspace lock waits its full budget',
  description: MALFORMED,
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

const rowsFor = (id) => readJsonl(pollLedgerFile()).filter((r) => r.issue === id);

test('REQ-LINEAR-46 a skipped issue whose keel block is fixed is picked and built by the next poll', async () => {
  const { dir } = fixtureRepo();
  const ran = [];
  const skipped = issue();
  const client = fakeClient([skipped]);
  await poll({ repo: dir, project: 'x', client, config: {}, runFn: runner(ran) });
  assert.deepEqual(ran, [], 'malformed: skipped, not built');
  assert.deepEqual(
    rowsFor('BUI-1467').map((r) => r.outcome),
    ['skipped'],
  );
  skipped.description = VALID;
  const r = await poll({ repo: dir, project: 'x', client, config: {}, runFn: runner(ran) });
  assert.deepEqual(ran, ['BUI-1467'], 'the fixed keel block makes it a card again');
  assert.equal(r[0].outcome, 'inReview');
  await poll({ repo: dir, project: 'x', client, config: {}, runFn: runner(ran) });
  assert.deepEqual(ran, ['BUI-1467'], 'built once: the new outcome is an attempt');
});

test('REQ-LINEAR-46 a skipped issue whose text still maps to no card is not commented on or recorded again', async () => {
  const { dir } = fixtureRepo();
  const ran = [];
  const skipped = issue();
  const client = fakeClient([skipped]);
  await poll({ repo: dir, project: 'x', client, config: {}, runFn: runner(ran) });
  assert.equal(client.comments.length, 1, 'one skip comment');
  skipped.description = `${MALFORMED}\n\nEdited, still malformed.`;
  const r = await poll({ repo: dir, project: 'x', client, config: {}, runFn: runner(ran) });
  assert.deepEqual(r, [{ outcome: 'none' }]);
  assert.deepEqual(ran, []);
  assert.equal(client.comments.length, 1, 'no second comment');
  assert.equal(rowsFor('BUI-1467').length, 1, 'no second ledger row');
});
