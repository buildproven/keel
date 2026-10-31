import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { readJsonl } from '../src/ledger.js';
import { attemptedIssueIds, pollLedgerFile, recordPollAttempt } from '../src/linear.js';
import { poll } from '../src/poll.js';
import { fixtureRepo, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-report-retry-');
});

const mk = (id, over = {}) => ({
  id,
  title: `t ${id}`,
  description: '- REQ-1: it shall work.',
  priority: 2,
  createdAt: '2026-09-01',
  labels: ['Bug'],
  estimate: null,
  blockedBy: [],
  ...over,
});

const passed = (id) => ({
  pass: true,
  tier: 1,
  attempt: 1,
  branch: `keel/${id}`,
  worktree: '/nonexistent/wt',
  followUps: [],
  receipt: { head: 'abc123' },
});

/** A fake Linear client: `failWith` makes every write throw it; the issue list drops an issue once it left Todo. */
function fakeClient(issues, { failWith = null, state = 'started' } = {}) {
  const calls = [];
  const moved = new Set();
  const write =
    (name) =>
    async (id, ...rest) => {
      if (failWith) throw failWith;
      calls.push({ name, id, rest });
      if (name === 'review') moved.add(id);
    };
  return {
    calls,
    setFail: (e) => (failWith = e),
    listIssues: async () => issues.filter((i) => !moved.has(i.id)),
    stateType: async () => {
      if (failWith) throw failWith;
      return state;
    },
    comment: write('comment'),
    review: write('review'),
  };
}

test('REQ-LINEAR-6 a report that failed with fetch failed is recorded with its result and reported by the next poll, without a build', async () => {
  const { dir } = fixtureRepo();
  const client = fakeClient([mk('BUI-1')], { failWith: new TypeError('fetch failed') });
  let builds = 0;
  const runFn = () => {
    builds += 1;
    return passed('BUI-1');
  };
  await assert.rejects(poll({ repo: dir, project: 'x', client, config: {}, runFn }), /fetch failed/);
  const [row] = readJsonl(pollLedgerFile()).filter((r) => r.outcome === 'reportFailed');
  assert.equal(row.result.branch, 'keel/BUI-1');
  assert.equal(row.result.pass, true);
  assert.equal(row.result.receipt.head, 'abc123');
  assert.equal(attemptedIssueIds(dir).has('BUI-1'), true, 'still not built again');

  client.setFail(null);
  const results = await poll({ repo: dir, project: 'x', client, config: {}, runFn });
  assert.equal(builds, 1, 'no new build');
  assert.deepEqual(
    results.map((r) => r.outcome),
    ['inReview', 'none'],
  );
  assert.deepEqual(
    client.calls.map((c) => c.name),
    ['comment', 'review'],
    'comment posted and state moved',
  );
  assert.match(client.calls[0].rest[0], /keel\/BUI-1/);
  const rows = readJsonl(pollLedgerFile()).filter((r) => r.issue === 'BUI-1');
  assert.equal(rows.at(-1).outcome, 'inReview', 'the retry outcome is the latest');

  await poll({ repo: dir, project: 'x', client, config: {}, runFn });
  assert.equal(client.calls.length, 2, 'a reported run is not reported again');
});

test('REQ-LINEAR-6 a retried report that fails again stays reportFailed, is logged by issue and branch, and the poll builds the next issue', async () => {
  const { dir } = fixtureRepo();
  const issues = [mk('BUI-1'), mk('BUI-2', { priority: 3 })];
  const client = fakeClient(issues, { failWith: new TypeError('fetch failed') });
  const built = [];
  const runFn = ({ card }) => {
    built.push(card.id);
    return passed(card.id);
  };
  await assert.rejects(poll({ repo: dir, project: 'x', client, config: {}, runFn }), /fetch failed/);
  assert.deepEqual(built, ['BUI-1']);

  // The retry fails with a Linear error that is not a network failure; BUI-2 then reports fine.
  const writes = [];
  const flaky = {
    ...client,
    stateType: async (id) => {
      if (id === 'BUI-1') throw new Error('Linear API error: rate limited');
      return 'started';
    },
    comment: async (id) => writes.push(id),
    review: async () => {},
  };
  const logs = [];
  const results = await poll({ repo: dir, project: 'x', client: flaky, config: {}, runFn, log: (m) => logs.push(m) });
  assert.deepEqual(built, ['BUI-1', 'BUI-2'], 'the next issue was built');
  assert.deepEqual(writes, ['BUI-2']);
  assert.ok(results.some((r) => r.issue === 'BUI-2' && r.outcome === 'inReview'));
  assert.equal(
    logs.filter((l) => l.includes('BUI-1') && l.includes('keel/BUI-1') && l.includes('rate limited')).length,
    1,
    logs.join('\n'),
  );
  const latest = readJsonl(pollLedgerFile())
    .filter((r) => r.issue === 'BUI-1')
    .at(-1);
  assert.equal(latest.outcome, 'reportFailed');
  assert.ok(latest.result, 'the result is kept for the next retry');
});

test('REQ-LINEAR-6 a retried report on an issue closed meanwhile does not reopen it and is recorded as done', async () => {
  const { dir } = fixtureRepo();
  const client = fakeClient([mk('BUI-1')], { failWith: new TypeError('fetch failed') });
  const runFn = () => passed('BUI-1');
  await assert.rejects(poll({ repo: dir, project: 'x', client, config: {}, runFn }), /fetch failed/);

  const closed = fakeClient([], { state: 'completed' });
  await poll({ repo: dir, project: 'x', client: closed, config: {}, runFn });
  assert.deepEqual(
    closed.calls.map((c) => c.name),
    ['comment'],
    'no state move',
  );
  const latest = readJsonl(pollLedgerFile())
    .filter((r) => r.issue === 'BUI-1')
    .at(-1);
  assert.equal(latest.outcome, 'closedMeanwhile');
  await poll({ repo: dir, project: 'x', client: closed, config: {}, runFn });
  assert.equal(closed.calls.length, 1, 'not reported a third time');
});

test('REQ-LINEAR-6 a reportFailed row from before results were kept is left alone', async () => {
  const { dir } = fixtureRepo();
  const client = fakeClient([]);
  recordPollAttempt(dir, { issue: 'BUI-9', outcome: 'reportFailed', detail: 'fetch failed' });
  const results = await poll({ repo: dir, project: 'x', client, config: {}, runFn: () => assert.fail('no build') });
  assert.deepEqual(results, [{ outcome: 'none' }]);
  assert.deepEqual(client.calls, []);
});
