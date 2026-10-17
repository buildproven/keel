import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { beforeEach, test } from 'node:test';
import { poll } from '../src/poll.js';
import { recordPollAttempt } from '../src/linear.js';
import { commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const issue = (over = {}) => ({
  id: 'BUI-1',
  title: 't',
  description: '- REQ-1: x shall y.',
  priority: 3,
  createdAt: '2026-09-01',
  labels: ['Bug'],
  estimate: null,
  ...over,
});

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-pollissue-state-');
});

function harness(issues) {
  const events = [];
  const ran = [];
  return {
    events,
    ran,
    client: {
      listIssues: async () => issues,
      comment: async (id, body) => events.push({ id, body }),
      review: async (id) => events.push({ id, action: 'review' }),
      stateType: async () => 'started',
    },
    runFn: ({ card }) => {
      ran.push(card.id);
      return { pass: true, tier: 0, attempt: 1, branch: `keel/${card.id}`, needsReview: false, worktree: '/wt' };
    },
  };
}

test('REQ-LINEAR-14 --issue runs the named issue even if already decided and outranked', async () => {
  const { dir } = fixtureRepo();
  recordPollAttempt(dir, { issue: 'BUI-2', outcome: 'failed' });
  const h = harness([issue({ id: 'BUI-1', priority: 1 }), issue({ id: 'BUI-2', priority: 4 })]);
  const results = await poll({ repo: dir, project: 'p', client: h.client, config: fixtureConfig(), runFn: h.runFn, issue: 'BUI-2' });
  assert.deepEqual(h.ran, ['BUI-2']);
  assert.equal(results[0].outcome, 'inReview');
});

test('REQ-LINEAR-14 --issue never overrides the no-keel label', async () => {
  const { dir } = fixtureRepo();
  const h = harness([issue({ labels: ['Bug', 'no-keel'] })]);
  const results = await poll({ repo: dir, project: 'p', client: h.client, config: fixtureConfig(), runFn: h.runFn, issue: 'BUI-1' });
  assert.deepEqual(h.ran, []);
  assert.deepEqual(h.events, []);
  assert.equal(results[0].outcome, 'none');
});

test('REQ-LINEAR-14 an ID that is not an open issue runs nothing and comments nowhere', async () => {
  const { dir } = fixtureRepo();
  const h = harness([issue({ id: 'BUI-1' })]);
  const results = await poll({ repo: dir, project: 'p', client: h.client, config: fixtureConfig(), runFn: h.runFn, issue: 'BUI-99' });
  assert.deepEqual(h.ran, []);
  assert.deepEqual(h.events, []);
  assert.equal(results[0].outcome, 'none');
});

test('REQ-LINEAR-14 an invalid card for the named issue raises its reason instead of skipping', async () => {
  const { dir } = fixtureRepo();
  const h = harness([issue({ description: '```keel\nallowEdit: x\n```\n- REQ-1: x.' })]);
  await assert.rejects(
    () => poll({ repo: dir, project: 'p', client: h.client, config: fixtureConfig(), runFn: h.runFn, issue: 'BUI-1' }),
    /unknown header "allowEdit"/,
  );
  assert.deepEqual(h.events, []);
});

test('REQ-LINEAR-14 a malformed --issue value is a usage error', () => {
  const { dir } = fixtureRepo();
  commit(dir, { 'keel.json': JSON.stringify({ checks: { test: 'true' }, testCommand: 'true', linearProject: 'p' }) }, 'cfg');
  const bin = new URL('../bin/keel.js', import.meta.url).pathname;
  const r = spawnSync(process.execPath, [bin, 'poll', '--repo', dir, '--issue', 'not an id'], { encoding: 'utf8' });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^keel: .*--issue/m);
});

test('REQ-LINEAR-14 REQ-LINEAR-9 --issue still stops at the daily budget ceiling', async () => {
  const { dir } = fixtureRepo();
  const { appendAttempt } = await import('../src/ledger.js');
  appendAttempt({ run: 'r1', card: 'X-1', repo: dir, cost: 9, workerStatus: 'ok', gatePass: true, usage: null });
  const h = harness([issue()]);
  const results = await poll({
    repo: dir,
    project: 'p',
    client: h.client,
    config: fixtureConfig({ dailyBudgetUsd: 5 }),
    runFn: h.runFn,
    issue: 'BUI-1',
  });
  assert.deepEqual(h.ran, []);
  assert.equal(results[0].outcome, 'budget');
});
