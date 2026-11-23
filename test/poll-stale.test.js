import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { DEFAULTS, loadConfig } from '../src/config.js';
import { linearHttpClient } from '../src/linear-http.js';
import { poll, pollExitCode } from '../src/poll.js';
import { FIXTURE_TEST, commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-stale-state-');
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.LINEAR_API_KEY;
});

/** A Linear fake: `issues` are the open issues the stale read returns; comments and cancels are recorded in order. */
function fakeClient(issues, { cancelFails = new Set(), readFails = null } = {}) {
  const events = [];
  const reads = [];
  return {
    events,
    reads,
    listIssues: async () => [],
    comment: async (id, body) => events.push(['comment', id, body]),
    stateType: async () => 'started',
    staleIssues: async (days) => {
      reads.push(days);
      if (readFails) throw readFails;
      return issues;
    },
    cancel: async (id) => {
      if (cancelFails.has(id)) throw new Error(`Linear did not cancel ${id}`);
      events.push(['cancel', id]);
    },
  };
}

const issue = (id, over) => ({ id, title: `Work ${id}`, stateType: 'backlog', project: 'keel', updatedAt: ago(1), openPr: false, ...over });

async function pollWith(client, over = {}, fileOnly = false) {
  const { dir } = fixtureRepo();
  const logs = [];
  const results = await poll({
    repo: dir,
    project: 'keel',
    client,
    config: fixtureConfig({ linearProject: 'keel', ...over }),
    runFn: () => assert.fail('no issue should run'),
    capacityFn: null,
    archiveFn: null,
    fileOnly,
    log: (l) => logs.push(l),
  });
  return { results, logs };
}

test('REQ-LINEAR-57 keel poll cancels a stale issue and an unbuilt stale follow-up with a comment; the rest stay open', async () => {
  const client = fakeClient([
    issue('BUI-1', { updatedAt: ago(15) }), // 15-day-old Backlog issue
    issue('BUI-2', { title: 'Review: a finding', stateType: 'unstarted', updatedAt: ago(8) }), // 8-day-old follow-up
    issue('BUI-3', { updatedAt: ago(2) }), // fresh
    issue('BUI-4', { stateType: 'started', updatedAt: ago(30), openPr: true }), // In Review with an open PR
    issue('BUI-5', { project: 'kept', updatedAt: ago(30) }), // skipped project
    issue('BUI-6', { updatedAt: ago(8) }), // 8 days, not a follow-up: under staleDays
    issue('BUI-7', { title: 'Audit #12: a finding', updatedAt: ago(10), stateType: 'triage' }),
    issue('BUI-8', { title: 'Review: being built', stateType: 'started', updatedAt: ago(10) }), // not unbuilt, under 14
    issue('BUI-9', { stateType: 'started', updatedAt: ago(20) }), // In Progress with no PR
    issue('BUI-10', { updatedAt: 'not a date' }), // no readable activity date: never canceled
  ]);
  const { results, logs } = await pollWith(client, { staleSkipProjects: ['kept'] });
  const cancels = client.events.filter((e) => e[0] === 'cancel').map((e) => e[1]);
  assert.deepEqual(cancels, ['BUI-1', 'BUI-2', 'BUI-7', 'BUI-9']);
  for (const id of cancels) {
    const at = client.events.findIndex((e) => e[0] === 'cancel' && e[1] === id);
    const note = client.events.findIndex((e) => e[0] === 'comment' && e[1] === id);
    assert.ok(note >= 0 && note < at, `${id} gets its comment before it is canceled`);
    assert.match(client.events[note][2], /reopen/i);
  }
  assert.match(client.events.find((e) => e[1] === 'BUI-1')[2], /no activity for 15 days \(staleDays 14\)/);
  assert.match(client.events.find((e) => e[1] === 'BUI-2')[2], /unbuilt follow-up.*no activity for 8 days \(followUpStaleDays 7\)/);
  assert.deepEqual(client.reads, [7], 'one read of issues idle for the shorter of the two ages');
  assert.ok(logs.includes('canceled 4 stale issue(s): BUI-1, BUI-2, BUI-7, BUI-9'), logs.join('\n'));
  assert.notEqual(pollExitCode(results), 1);
});

test('REQ-LINEAR-57 --file-only polls cancel stale issues too; none stale logs nothing', async () => {
  const stale = fakeClient([issue('BUI-1', { updatedAt: ago(20) })]);
  const { logs } = await pollWith(stale, {}, true);
  assert.ok(logs.includes('canceled 1 stale issue(s): BUI-1'), logs.join('\n'));
  const fresh = fakeClient([issue('BUI-2')]);
  const quiet = await pollWith(fresh, {}, true);
  assert.deepEqual(fresh.events, []);
  assert.ok(!quiet.logs.some((l) => /canceled/.test(l)), quiet.logs.join('\n'));
});

test('REQ-LINEAR-57 staleDays 0 and followUpStaleDays 0 turn the step off; one at 0 leaves the other rule', async () => {
  const off = fakeClient([issue('BUI-1', { updatedAt: ago(90) })]);
  await pollWith(off, { staleDays: 0, followUpStaleDays: 0 });
  assert.deepEqual(off.reads, [], 'nothing is read');
  assert.deepEqual(off.events, []);
  const onlyFollowUps = fakeClient([issue('BUI-1', { updatedAt: ago(90) }), issue('BUI-2', { title: 'Review: x', updatedAt: ago(9) })]);
  await pollWith(onlyFollowUps, { staleDays: 0 });
  assert.deepEqual(onlyFollowUps.reads, [7]);
  assert.deepEqual(
    onlyFollowUps.events.filter((e) => e[0] === 'cancel'),
    [['cancel', 'BUI-2']],
  );
  const onlyStale = fakeClient([issue('BUI-1', { updatedAt: ago(90) }), issue('BUI-2', { title: 'Review: x', updatedAt: ago(9) })]);
  await pollWith(onlyStale, { followUpStaleDays: 0 });
  assert.deepEqual(onlyStale.reads, [14]);
  assert.deepEqual(
    onlyStale.events.filter((e) => e[0] === 'cancel'),
    [['cancel', 'BUI-1']],
  );
});

test('REQ-LINEAR-57 a Linear error fails the poll without stopping it; one issue that cannot be canceled does not hold the rest', async () => {
  const broken = fakeClient([], { readFails: new Error('HTTP 500') });
  const read = await pollWith(broken);
  assert.ok(read.logs.includes('stale issues not canceled: HTTP 500'), read.logs.join('\n'));
  assert.equal(pollExitCode(read.results), 1);
  assert.ok(
    read.results.some((r) => r.outcome === 'none'),
    'the poll went on',
  );
  const client = fakeClient([issue('BUI-1', { updatedAt: ago(20) }), issue('BUI-2', { updatedAt: ago(20) })], {
    cancelFails: new Set(['BUI-1']),
  });
  const { results, logs } = await pollWith(client);
  assert.ok(logs.includes('canceled 1 stale issue(s): BUI-2'), logs.join('\n'));
  assert.ok(logs.includes('stale issue BUI-1 not canceled: Linear did not cancel BUI-1'), logs.join('\n'));
  assert.equal(pollExitCode(results), 1);
});

test('REQ-LINEAR-57 a network failure stops the poll', async () => {
  const down = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND', hostname: 'api.linear.app' } });
  const client = fakeClient([], { readFails: down });
  await assert.rejects(pollWith(client), /fetch failed/);
});

test('REQ-LINEAR-57 followUpHoldAt defaults to 50; the config rejects a negative staleDays and checks the new keys', () => {
  assert.equal(DEFAULTS.followUpHoldAt, 50);
  assert.equal(DEFAULTS.staleDays, 14);
  assert.equal(DEFAULTS.followUpStaleDays, 7);
  assert.deepEqual(DEFAULTS.staleSkipProjects, []);
  const { dir } = fixtureRepo();
  const at = (cfg) => commit(dir, { 'keel.json': JSON.stringify({ checks: { test: FIXTURE_TEST }, testCommand: FIXTURE_TEST, ...cfg }) });
  for (const bad of [-1, 1.5, '14', null]) {
    assert.throws(() => loadConfig(dir, at({ staleDays: bad })), /staleDays/);
    assert.throws(() => loadConfig(dir, at({ followUpStaleDays: bad })), /followUpStaleDays/);
  }
  for (const bad of ['keel', [1], null]) assert.throws(() => loadConfig(dir, at({ staleSkipProjects: bad })), /staleSkipProjects/);
  const ok = loadConfig(dir, at({ staleDays: 0, followUpStaleDays: 3, staleSkipProjects: ['starknet'] }));
  assert.deepEqual([ok.staleDays, ok.followUpStaleDays, ok.staleSkipProjects], [0, 3, ['starknet']]);
});

function stubFetch(responses) {
  const calls = [];
  let i = 0;
  globalThis.fetch = async (_url, opts) => {
    calls.push(JSON.parse(opts.body));
    return { ok: true, json: async () => responses[i++] };
  };
  return calls;
}

test('REQ-LINEAR-57 staleIssues reads every page of open issues idle for the days given, workspace-wide, with PR links', async () => {
  process.env.LINEAR_API_KEY = ['lin', 'api', 'stale'].join('_');
  const node = (identifier, over) => ({
    identifier,
    title: `T ${identifier}`,
    updatedAt: '2026-11-01T00:00:00.000Z',
    state: { type: 'started' },
    project: { name: 'keel' },
    attachments: { nodes: [] },
    ...over,
  });
  const calls = stubFetch([
    {
      data: {
        issues: {
          pageInfo: { hasNextPage: true, endCursor: 'c1' },
          nodes: [node('BUI-1', { attachments: { nodes: [{ url: 'https://github.com/o/r/pull/12' }] } })],
        },
      },
    },
    {
      data: {
        issues: {
          pageInfo: { hasNextPage: false },
          nodes: [node('BUI-2', { project: null, attachments: { nodes: [{ url: 'https://github.com/o/r/issues/3' }] } })],
        },
      },
    },
  ]);
  assert.deepEqual(await linearHttpClient().staleIssues(7), [
    { id: 'BUI-1', title: 'T BUI-1', stateType: 'started', project: 'keel', updatedAt: '2026-11-01T00:00:00.000Z', openPr: true },
    { id: 'BUI-2', title: 'T BUI-2', stateType: 'started', project: null, updatedAt: '2026-11-01T00:00:00.000Z', openPr: false },
  ]);
  assert.deepEqual(calls[0].variables.filter, { state: { type: { nin: ['completed', 'canceled'] } }, updatedAt: { lt: '-P7D' } });
  assert.equal(calls[1].variables.after, 'c1');
});

test('REQ-LINEAR-57 cancel moves the issue to its team canceled state, and fails visibly when the team has none', async () => {
  process.env.LINEAR_API_KEY = ['lin', 'api', 'stale'].join('_');
  const states = (nodes) => ({ data: { issue: { team: { states: { nodes } } } } });
  const calls = stubFetch([
    states([
      { id: 's1', name: 'Backlog', type: 'backlog' },
      { id: 's2', name: 'Canceled', type: 'canceled' },
    ]),
    { data: { issueUpdate: { success: true } } },
    states([{ id: 's1', name: 'Backlog', type: 'backlog' }]),
  ]);
  await linearHttpClient().cancel('BUI-1');
  assert.deepEqual(calls[1].variables, { id: 'BUI-1', stateId: 's2' });
  await assert.rejects(linearHttpClient().cancel('BUI-2'), /no "canceled"-type state/);
  assert.equal(calls.length, 3, 'no move without a canceled state');
});

test('REQ-LINEAR-57 cancel fails visibly when Linear refuses the move', async () => {
  process.env.LINEAR_API_KEY = ['lin', 'api', 'stale'].join('_');
  stubFetch([
    { data: { issue: { team: { states: { nodes: [{ id: 's2', name: 'Canceled', type: 'canceled' }] } } } } },
    { data: { issueUpdate: { success: false } } },
  ]);
  await assert.rejects(linearHttpClient().cancel('BUI-1'), /Linear did not cancel BUI-1/);
});
