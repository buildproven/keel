import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { linearHttpClient } from '../src/linear-http.js';
import { pendingFollowUps, pollLedgerFile } from '../src/linear.js';
import { poll, queueFollowUps } from '../src/poll.js';
import { readJsonl } from '../src/ledger.js';
import { commit, fixtureRepo, g, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

/** An in-memory Linear: `states` maps an issue to its state type; createIssue keeps its `blockedBy` on the new issue. */
function fakeClient({ open = [], states = {} } = {}) {
  const created = [];
  let next = 300;
  return {
    created,
    comments: [],
    listIssues: async () => [...open, ...created.map((c) => c.issue)],
    comment: async function (id, body) {
      this.comments.push({ id, body });
    },
    review: async () => {},
    stateType: async (id) => states[id] ?? 'started',
    createIssue: async (sourceId, fields) => {
      const id = `BUI-${next++}`;
      created.push({
        sourceId,
        fields,
        issue: {
          id,
          title: fields.title,
          description: fields.description,
          priority: 4,
          createdAt: '2026-10-14',
          labels: [],
          estimate: null,
          blockedBy: fields.blockedBy ?? [],
        },
      });
      return id;
    },
  };
}

const config = { ...DEFAULTS };
// limit 0: the poll only files the queue (it files before it picks), so no filed issue is built here.
const noRun = () => assert.fail('no issue should run');
const rows = (outcome) => readJsonl(pollLedgerFile()).filter((r) => r.outcome === outcome);

/** A repo with `src/sub.js`; returns its dir and the commit an audit reviewed. */
function audited() {
  const { dir } = fixtureRepo({ 'src/sub.js': 'export const sub = (a, b) => b - a;\nexport const two = 2;\n' });
  return { dir, merged: g(dir, 'rev-parse', 'HEAD') };
}

const finding = (detail, title = 'Audit #9: sub() subtracts in the wrong order') => ({ kind: 'bug', title, detail });

test('REQ-LINEAR-27 a finding whose cited line was changed on the base since is dropped as stale and recorded', async () => {
  const { dir, merged } = audited();
  queueFollowUps(dir, null, [finding('high src/sub.js:1')], merged);
  commit(dir, { 'src/sub.js': 'export const sub = (a, b) => a - b;\nexport const two = 2;\n' }, 'fix sub');
  const client = fakeClient();
  await poll({ repo: dir, project: 'x', client, config, runFn: noRun, limit: 0 });
  assert.equal(client.created.length, 0);
  const [stale] = rows('stale');
  assert.equal(stale.detail.title, 'Audit #9: sub() subtracts in the wrong order');
  assert.match(stale.detail.reason, /src\/sub\.js:1 no longer reads/);
  assert.deepEqual(pendingFollowUps(dir), [], 'a stale item leaves the queue');
});

test('REQ-LINEAR-27 a finding whose file is gone from the base is dropped as stale', async () => {
  const { dir, merged } = audited();
  queueFollowUps(dir, null, [finding('high src/sub.js:2')], merged);
  g(dir, 'rm', '-q', 'src/sub.js');
  g(dir, 'commit', '-q', '-m', 'drop sub');
  const client = fakeClient();
  await poll({ repo: dir, project: 'x', client, config, runFn: noRun, limit: 0 });
  assert.equal(client.created.length, 0);
  assert.match(rows('stale')[0].detail.reason, /src\/sub\.js no longer exists/);
});

test('REQ-LINEAR-27 a finding whose cited line still stands is filed, also when other lines moved it', async () => {
  const { dir, merged } = audited();
  queueFollowUps(dir, null, [finding('high src/sub.js:1')], merged);
  commit(dir, { 'src/sub.js': '// header\nexport const sub = (a, b) => b - a;\nexport const two = 2;\n' }, 'add header');
  const client = fakeClient();
  await poll({ repo: dir, project: 'x', client, config, runFn: noRun, limit: 0 });
  assert.equal(client.created.length, 1);
  assert.equal(rows('stale').length, 0);
});

test('REQ-LINEAR-27 a line an unmerged branch added is not stale just because the base lacks it', async () => {
  const { dir } = audited();
  g(dir, 'checkout', '-q', '-b', 'keel/BUI-7');
  commit(dir, { 'src/new.js': 'export const three = 2;\n' }, 'branch work');
  g(dir, 'checkout', '-q', 'main');
  queueFollowUps(dir, 'BUI-7', [finding('src/new.js:1', 'three() returns 2')], 'keel/BUI-7');
  const client = fakeClient();
  await poll({ repo: dir, project: 'x', client, config, runFn: noRun, limit: 0 });
  assert.equal(client.created.length, 1);
});

test('REQ-LINEAR-27 queueFollowUps stores the cited line text and commit, so filing can compare it later', () => {
  const { dir, merged } = audited();
  queueFollowUps(dir, null, [finding('high src/sub.js:1'), finding('no citation here', 'other')], merged);
  const [cited, plain] = pendingFollowUps(dir);
  assert.deepEqual(cited.cite, { path: 'src/sub.js', line: 1, text: 'export const sub = (a, b) => b - a;', ref: merged });
  assert.equal(plain.cite, undefined);
});

test('REQ-LINEAR-28 a follow-up whose source issue is open is filed blocked by it; a closed source adds no relation', async () => {
  const { dir } = fixtureRepo();
  queueFollowUps(dir, 'BUI-7', [finding('x', 'first thing')]);
  queueFollowUps(dir, 'BUI-8', [finding('x', 'second thing')]);
  const client = fakeClient({ states: { 'BUI-7': 'started', 'BUI-8': 'completed' } });
  await poll({ repo: dir, project: 'x', client, config, runFn: noRun, limit: 0 });
  const [a, b] = client.created;
  assert.deepEqual(a.fields.blockedBy, ['BUI-7']);
  assert.equal(b.fields.blockedBy, undefined);
});

test('REQ-LINEAR-28 the HTTP client links a new follow-up to its blocker with a blocks relation', async () => {
  process.env.LINEAR_API_KEY = 'lin_api_test';
  const calls = [];
  const responses = [
    { data: { issue: { team: { id: 'team-1' }, project: { id: 'proj-1' } } } },
    { data: { issueCreate: { success: true, issue: { identifier: 'BUI-201' } } } },
    { data: { issueRelationCreate: { success: true } } },
  ];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return { ok: true, json: async () => responses[calls.length - 1] };
  };
  try {
    const id = await linearHttpClient().createIssue('BUI-7', { title: 'T', description: 'D', priority: 4, blockedBy: ['BUI-7'] });
    assert.equal(id, 'BUI-201');
    assert.deepEqual(calls[1].variables.input, { teamId: 'team-1', projectId: 'proj-1', title: 'T', description: 'D', priority: 4 });
    assert.match(calls[2].query, /issueRelationCreate/);
    assert.deepEqual(calls[2].variables, { input: { issueId: 'BUI-7', relatedIssueId: 'BUI-201', type: 'blocks' } });
  } finally {
    globalThis.fetch = saved;
  }
});

test('REQ-LINEAR-28 a rejected relation deletes the new issue and is a visible filing error, so a retry files it whole', async () => {
  process.env.LINEAR_API_KEY = 'lin_api_test';
  const responses = [
    { data: { issue: { team: { id: 'team-1' }, project: { id: 'proj-1' } } } },
    { data: { issueCreate: { success: true, issue: { identifier: 'BUI-202' } } } },
    { data: { issueRelationCreate: { success: false } } },
    { data: { issueDelete: { success: true } } },
  ];
  const calls = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return { ok: true, json: async () => responses[calls.length - 1] };
  };
  try {
    await assert.rejects(
      linearHttpClient().createIssue('BUI-7', { title: 'T', description: 'D', priority: 4, blockedBy: ['BUI-7'] }),
      /BUI-202 blocked by BUI-7.*deleted BUI-202/,
    );
    assert.match(calls[3].query, /issueDelete/);
    assert.deepEqual(calls[3].variables, { id: 'BUI-202' });
  } finally {
    globalThis.fetch = saved;
  }
});

test('REQ-LINEAR-29 a finding on a file the gate locks is filed with allowEdits for that path and says no check may go', async () => {
  const { dir } = fixtureRepo({ '.github/workflows/quality.yml': 'jobs:\n  test:\n    timeout-minutes: 10\n' });
  const head = g(dir, 'rev-parse', 'HEAD');
  queueFollowUps(dir, null, [finding('medium .github/workflows/quality.yml:3', 'Audit #4: timeout too short')], head);
  queueFollowUps(dir, null, [finding('low src/add.js:1', 'Audit #4: add is wrong')], head);
  const client = fakeClient();
  await poll({ repo: dir, project: 'x', client, config, runFn: noRun, limit: 0 });
  const [locked, free] = client.created.map((c) => c.fields.description);
  assert.match(locked, /```keel\nkind: bug\nsize: S\npaths: [^\n]+\nallowEdits: \.github\/workflows\/quality\.yml\n```/);
  assert.match(locked, /must not remove or weaken any check/);
  assert.doesNotMatch(free, /allowEdits/);
});

test('REQ-LINEAR-27 a duplicate line an unmerged branch added is not stale when the base drops the older copy', async () => {
  const { dir } = audited();
  g(dir, 'checkout', '-q', '-b', 'keel/BUI-7');
  commit(dir, { 'src/sub.js': 'export const sub = (a, b) => b - a;\nexport const two = 2;\nexport const two = 2;\n' }, 'branch work');
  g(dir, 'checkout', '-q', 'main');
  commit(dir, { 'src/sub.js': 'export const sub = (a, b) => b - a;\n' }, 'drop two');
  queueFollowUps(dir, 'BUI-7', [finding('src/sub.js:3', 'two is declared twice')], 'keel/BUI-7');
  const client = fakeClient();
  await poll({ repo: dir, project: 'x', client, config, runFn: noRun, limit: 0 });
  assert.equal(rows('stale').length, 0);
  assert.equal(client.created.length, 1);
});

test('REQ-LINEAR-27 an older cited line between two branch edits still goes stale, whatever diff.interHunkContext says', async () => {
  const { dir } = fixtureRepo({ 'src/sub.js': 'a\nb\nexport const two = 2;\nc\nd\n' });
  g(dir, 'config', 'diff.interHunkContext', '10');
  g(dir, 'checkout', '-q', '-b', 'keel/BUI-7');
  commit(dir, { 'src/sub.js': 'a\nB\nexport const two = 2;\nC\nd\n' }, 'branch work');
  g(dir, 'checkout', '-q', 'main');
  commit(dir, { 'src/sub.js': 'a\nb\nc\nd\n' }, 'drop two');
  queueFollowUps(dir, 'BUI-7', [finding('src/sub.js:3', 'two is wrong')], 'keel/BUI-7');
  const client = fakeClient();
  await poll({ repo: dir, project: 'x', client, config, runFn: noRun, limit: 0 });
  assert.equal(client.created.length, 0);
  assert.match(rows('stale')[0].detail.reason, /src\/sub\.js:3 no longer reads/);
});

test('REQ-LINEAR-27 a line a branch added after a blank line is the branch own, whatever diff.suppressBlankEmpty says', async () => {
  const { dir } = fixtureRepo({ 'src/sub.js': 'a\n\nc\n' });
  g(dir, 'config', 'diff.interHunkContext', '10');
  g(dir, 'config', 'diff.suppressBlankEmpty', 'true');
  g(dir, 'checkout', '-q', '-b', 'keel/BUI-7');
  commit(dir, { 'src/sub.js': 'A\n\nc\nexport const two = 9;\n' }, 'branch work');
  g(dir, 'checkout', '-q', 'main');
  queueFollowUps(dir, 'BUI-7', [finding('src/sub.js:4', 'two is 9')], 'keel/BUI-7');
  const client = fakeClient();
  await poll({ repo: dir, project: 'x', client, config, runFn: noRun, limit: 0 });
  assert.equal(rows('stale').length, 0);
  assert.equal(client.created.length, 1);
});
