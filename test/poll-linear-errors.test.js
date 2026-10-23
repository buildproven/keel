import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { attemptedIssueIds, pendingFollowUps, recordPollAttempt } from '../src/linear.js';
import { poll, pollExitCode } from '../src/poll.js';
import { fixtureRepo, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

const issue = (id) => ({ id, title: 't', description: '- REQ-1: x.', priority: 2, createdAt: '2026-09-01', labels: ['Bug'] });

const client = (issues, overrides = {}) => ({
  listIssues: async () => issues,
  comment: async () => {},
  review: async () => {},
  stateType: async () => 'started',
  capacity: async () => ({ open: 0, teams: [] }), // room in the workspace: no hold (REQ-LINEAR-37)
  createIssue: async () => 'BUI-99',
  ...overrides,
});

const passing = (id, followUps = []) => ({
  pass: true,
  tier: 0,
  attempt: 1,
  branch: `keel/${id}`,
  needsReview: false,
  worktree: '/wt',
  followUps,
});

test('REQ-LINEAR-6 a Linear error after a run records the attempt, so the next poll does not build the issue again', async () => {
  const { dir } = fixtureRepo();
  let runs = 0;
  const c = client([issue('BUI-1')], {
    review: async () => {
      throw new Error('no "started"-type state found on the team');
    },
  });
  const runFn = () => {
    runs++;
    return passing('BUI-1');
  };
  for (let i = 0; i < 2; i++)
    await poll({ repo: dir, project: 'x', client: c, config: { ...DEFAULTS }, runFn }).catch((e) => assert.match(e.message, /started/));
  assert.equal(runs, 1);
  assert.ok(attemptedIssueIds(dir).has('BUI-1'));
});

test('REQ-LINEAR-22 a Linear error after a run keeps the run follow-ups in the queue', async () => {
  const { dir } = fixtureRepo();
  const c = client([issue('BUI-1')], {
    comment: async () => {
      throw new Error('Linear API error: rate limited');
    },
  });
  const runFn = () => passing('BUI-1', [{ kind: 'bug', title: 'found thing', detail: 'a:1' }]);
  await assert.rejects(poll({ repo: dir, project: 'x', client: c, config: { ...DEFAULTS, followUpsPerDay: 0 }, runFn }), /rate limited/);
  assert.deepEqual(
    pendingFollowUps(dir).map((f) => f.title),
    ['found thing'],
  );
});

test('REQ-LINEAR-22 a failed source comment while filing follow-ups does not stop the poll; it fails visibly', async () => {
  const { dir } = fixtureRepo();
  recordPollAttempt(dir, { issue: 'BUI-1', outcome: 'found', detail: [{ kind: 'bug', title: 'found thing', detail: 'a:1' }] });
  let runs = 0;
  const c = client([issue('BUI-2')], {
    comment: async (id) => {
      if (id === 'BUI-1') throw new Error('Linear API error: Entity not found');
    },
  });
  const runFn = () => {
    runs++;
    return passing('BUI-2');
  };
  const results = await poll({ repo: dir, project: 'x', client: c, config: { ...DEFAULTS }, runFn, limit: 2 });
  assert.equal(runs, 1);
  assert.ok(results.some((r) => r.outcome === 'followUpsFailed' && /Entity not found/.test(r.detail)));
  assert.equal(pollExitCode(results), 1);
  assert.deepEqual(pendingFollowUps(dir), [], 'the issue was created, so the item left the queue');
});
