import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { humanTouch } from '../src/autonomy.js';
import { DEFAULTS, loadConfig } from '../src/config.js';
import { attemptedIssueIds, pendingFollowUps, pollLedgerFile, recordPollAttempt } from '../src/linear.js';
import { readJsonl } from '../src/ledger.js';
import { poll, pollExitCode } from '../src/poll.js';
import { FIXTURE_TEST, commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-hold-state-');
});

/** A Linear fake whose workspace holds `open` unarchived issues; each created issue adds one. */
function fakeClient(open) {
  const created = [];
  let reads = 0;
  return {
    created,
    reads: () => reads,
    listIssues: async () => [],
    comment: async () => {},
    stateType: async () => 'started',
    capacity: async () => {
      reads++;
      if (open instanceof Error) throw open;
      return { open: open + created.length, teams: [] };
    },
    createIssue: async (sourceId, fields) => {
      created.push({ sourceId, fields });
      return `BUI-${100 + created.length}`;
    },
  };
}

const queue = (dir, titles) =>
  recordPollAttempt(dir, { issue: null, outcome: 'found', detail: titles.map((title) => ({ kind: 'bug', title, detail: 'a.js:1' })) });

const fileOnly = (dir, client, over = {}) => {
  const logs = [];
  const r = poll({
    repo: dir,
    project: 'x',
    client,
    config: fixtureConfig({ followUpsPerDay: 5, ...over }),
    runFn: () => assert.fail('file-only must not build'),
    fileOnly: true,
    capacityFn: () => client.capacity(),
    log: (l) => logs.push(l),
  });
  return r.then((results) => ({ results, logs }));
};

test('REQ-LINEAR-37 follow-ups wait in the queue when the workspace is at the hold count', async () => {
  const { dir } = fixtureRepo();
  queue(dir, ['finding one', 'finding two']);
  const client = fakeClient(200);
  const { results, logs } = await fileOnly(dir, client);
  assert.deepEqual(client.created, []);
  assert.equal(pollExitCode(results), 0, 'a hold is not an error');
  assert.deepEqual(
    pendingFollowUps(dir).map((f) => f.title),
    ['finding one', 'finding two'],
  );
  assert.deepEqual(logs, ['follow-ups held: 200 unarchived issues >= 200 (followUpHoldAt); 2 wait in the queue']);
  const held = readJsonl(pollLedgerFile()).filter((r) => r.outcome === 'held');
  assert.equal(held.length, 1);
  assert.deepEqual(held[0].detail, { open: 200, holdAt: 200, waiting: 2 });
});

test('REQ-LINEAR-37 filing stops when the issues it files reach the hold count, and the rest wait', async () => {
  const { dir } = fixtureRepo();
  queue(dir, ['a one', 'a two', 'a three']);
  const client = fakeClient(198);
  const { logs } = await fileOnly(dir, client);
  assert.equal(client.created.length, 2);
  assert.equal(client.reads(), 1, 'the count is read once per filing pass');
  assert.deepEqual(
    pendingFollowUps(dir).map((f) => f.title),
    ['a three'],
  );
  assert.ok(logs.includes('follow-ups held: 200 unarchived issues >= 200 (followUpHoldAt); 1 wait in the queue'), logs.join('\n'));
});

test('REQ-LINEAR-37 an unreadable issue count holds follow-ups and fails the poll', async () => {
  const { dir } = fixtureRepo();
  queue(dir, ['finding three']);
  const client = fakeClient(new Error('HTTP 500'));
  const { results, logs } = await fileOnly(dir, client);
  assert.deepEqual(client.created, []);
  assert.equal(results[0].outcome, 'followUpsFailed');
  assert.match(results[0].detail, /HTTP 500/);
  assert.equal(pollExitCode(results), 1);
  assert.ok(
    logs.some((l) => /follow-ups not filed: .*HTTP 500/.test(l)),
    logs.join('\n'),
  );
  const [item] = pendingFollowUps(dir, 3);
  assert.equal(item.title, 'finding three');
  assert.equal(item.tries, 0, 'an unread count is not a try against the item');
});

test('REQ-LINEAR-37 followUpHoldAt 0 turns the hold off and the count is not read', async () => {
  const { dir } = fixtureRepo();
  queue(dir, ['finding four']);
  const client = fakeClient(300);
  await fileOnly(dir, client, { followUpHoldAt: 0 });
  assert.equal(client.created.length, 1);
  assert.equal(client.reads(), 0);
});

test('REQ-LINEAR-37 a real poll reads the count from the Linear client', async () => {
  const { dir } = fixtureRepo();
  queue(dir, ['finding five']);
  const client = fakeClient(250);
  const logs = [];
  // No injected runFn: the real run is the default, so the client's count is read and the item is held.
  await poll({ repo: dir, project: 'x', client, config: fixtureConfig({ followUpsPerDay: 5 }), fileOnly: true, log: (l) => logs.push(l) });
  assert.equal(client.reads(), 1);
  assert.deepEqual(client.created, []);
});

test('REQ-LINEAR-37 with nothing queued the count is not read', async () => {
  const { dir } = fixtureRepo();
  const client = fakeClient(10);
  await fileOnly(dir, client);
  assert.equal(client.reads(), 0);
});

test('REQ-LINEAR-37 followUpHoldAt defaults to 200 and must be an integer >= 0', () => {
  assert.equal(DEFAULTS.followUpHoldAt, 200);
  const { dir } = fixtureRepo();
  const at = (cfg) => commit(dir, { 'keel.json': JSON.stringify({ checks: { test: FIXTURE_TEST }, testCommand: FIXTURE_TEST, ...cfg }) });
  for (const bad of [-1, 1.5, '200', null]) assert.throws(() => loadConfig(dir, at({ followUpHoldAt: bad })), /followUpHoldAt/);
  assert.equal(loadConfig(dir, at({ followUpHoldAt: 0 })).followUpHoldAt, 0);
});

test('REQ-LINEAR-37 a held row is not a run: no issue is attempted or counted by the human touch rate', async () => {
  const { dir } = fixtureRepo();
  queue(dir, ['finding six']);
  await fileOnly(dir, fakeClient(220));
  const rows = readJsonl(pollLedgerFile());
  assert.ok(rows.some((r) => r.outcome === 'held'));
  assert.deepEqual([...attemptedIssueIds(dir)], []);
  assert.equal(humanTouch({ pollRows: rows, ledgerRows: [], prsFor: () => [] }).issues, 0);
});

const unbuiltIssue = (n) => ({ id: `u${n}`, title: `old ${n}`, description: 'Found by keel while building BUI-1.' });

test('REQ-LINEAR-42 follow-ups wait while the project holds followUpOpenMax unbuilt follow-ups', async () => {
  const { dir } = fixtureRepo();
  queue(dir, ['finding one', 'finding two']);
  const client = { ...fakeClient(10), listIssues: async (_p, o) => (o?.stateTypes ? [1, 2, 3].map(unbuiltIssue) : []) };
  const { results, logs } = await fileOnly(dir, client, { followUpOpenMax: 3 });
  assert.deepEqual(client.created, []);
  assert.equal(pollExitCode(results), 0, 'a wait is not an error');
  assert.ok(
    logs.some((l) => /3 unbuilt follow-ups >= 3 \(followUpOpenMax\)/.test(l)),
    logs.join('\n'),
  );
  const held = readJsonl(pollLedgerFile()).find((r) => r.outcome === 'held');
  assert.equal(held.detail.reason, 'unbuilt');
  assert.equal(pendingFollowUps(dir, 3).length, 2, 'the queue keeps both');
});

test('REQ-LINEAR-42 filing stops at followUpOpenMax within one pass, and cards not filed by Keel do not count', async () => {
  const { dir } = fixtureRepo();
  queue(dir, ['finding one', 'finding two', 'finding three']);
  const hand = { id: 'h', title: 'by hand', description: 'My own backlog card.' };
  const client = { ...fakeClient(10), listIssues: async (_p, o) => (o?.stateTypes ? [unbuiltIssue(1), hand] : []) };
  const { logs } = await fileOnly(dir, client, { followUpOpenMax: 2 });
  assert.equal(client.created.length, 1, 'one slot was free: 1 unbuilt + the new one = 2');
  assert.ok(logs.some((l) => /followUpOpenMax/.test(l)));
});

test('REQ-LINEAR-42 followUpOpenMax 0 means no limit', async () => {
  const { dir } = fixtureRepo();
  queue(dir, ['finding one', 'finding two']);
  const client = {
    ...fakeClient(10),
    listIssues: async (_p, o) => (o?.stateTypes ? Array.from({ length: 50 }, (_, i) => unbuiltIssue(i)) : []),
  };
  await fileOnly(dir, client, { followUpOpenMax: 0 });
  assert.equal(client.created.length, 2);
});

test('REQ-LINEAR-42 the defaults are 20 a day and 8 unbuilt, and followUpOpenMax is validated', () => {
  assert.equal(DEFAULTS.followUpsPerDay, 20);
  assert.equal(DEFAULTS.followUpOpenMax, 8);
  const { dir } = fixtureRepo();
  const ref = commit(dir, {
    'keel.json': JSON.stringify({ checks: { test: FIXTURE_TEST }, testCommand: FIXTURE_TEST, followUpOpenMax: -1 }),
  });
  assert.throws(() => loadConfig(dir, ref), /followUpOpenMax/);
});
