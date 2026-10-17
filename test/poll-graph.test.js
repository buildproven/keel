import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { attemptedIssueIds, pickIssue } from '../src/linear.js';
import { linearHttpClient } from '../src/linear-http.js';
import { poll } from '../src/poll.js';
import { fixtureRepo, tmp } from './helpers.js';

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

const originalFetch = globalThis.fetch;
beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-graph-state-');
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.LINEAR_API_KEY;
});

test('REQ-LINEAR-20 pickIssue passes over an issue an open issue still blocks and takes the next one, without skipping it for good', () => {
  const waits = [];
  const skips = [];
  const issues = [issue({ id: 'BUI-2', priority: 1, blockedBy: ['BUI-3'] }), issue({ id: 'BUI-3', priority: 3 })];
  const picked = pickIssue(
    issues,
    new Set(),
    (id, reason) => skips.push({ id, reason }),
    (id, blockers) => waits.push({ id, blockers }),
  );
  assert.equal(picked.id, 'BUI-3', 'the blocker runs first');
  assert.deepEqual(waits, [{ id: 'BUI-2', blockers: ['BUI-3'] }]);
  assert.deepEqual(skips, []);
});

test('REQ-LINEAR-20 keel poll never runs, comments on, or records a blocked issue; it becomes eligible once its blocker closes', async () => {
  const { dir } = fixtureRepo();
  const comments = [];
  const ran = [];
  const logs = [];
  let issues = [issue({ id: 'BUI-2', priority: 1, blockedBy: ['BUI-9'] })];
  const client = {
    listIssues: async () => issues,
    comment: async (id, body) => comments.push({ id, body }),
    review: async () => {},
    stateType: async () => 'started',
  };
  const runFn = ({ card }) => {
    ran.push(card.id);
    return { pass: true, tier: 0, attempt: 1, branch: `keel/${card.id}`, needsReview: false, worktree: '/wt' };
  };
  const first = await poll({ repo: dir, project: 'x', client, config: {}, runFn, log: (l) => logs.push(l) });
  assert.deepEqual(first, [{ outcome: 'none' }]);
  assert.deepEqual(ran, []);
  assert.deepEqual(comments, []);
  assert.equal(attemptedIssueIds(dir).has('BUI-2'), false);
  assert.ok(
    logs.some((l) => /BUI-2 waits for BUI-9/.test(l)),
    logs.join('\n'),
  );
  issues = [issue({ id: 'BUI-2', priority: 1 })];
  const second = await poll({ repo: dir, project: 'x', client, config: {}, runFn });
  assert.equal(second[0].outcome, 'inReview');
  assert.deepEqual(ran, ['BUI-2']);
});

test('REQ-LINEAR-20 listIssues reads open blocking relations into blockedBy; closed blockers and other relation types do not count', async () => {
  process.env.LINEAR_API_KEY = 'lin_api_test';
  let query;
  globalThis.fetch = async (url, opts) => {
    query = JSON.parse(opts.body).query;
    const rel = (type, id, state) => ({ type, issue: { identifier: id, state: { type: state } } });
    const node = {
      identifier: 'BUI-2',
      title: 't',
      description: 'd',
      priority: 1,
      createdAt: '2026-09-01',
      estimate: null,
      labels: { nodes: [] },
      inverseRelations: {
        nodes: [
          rel('blocks', 'BUI-3', 'started'),
          rel('blocks', 'BUI-4', 'completed'),
          rel('blocks', 'BUI-6', 'canceled'),
          rel('related', 'BUI-5', 'backlog'),
        ],
      },
    };
    return { ok: true, json: async () => ({ data: { issues: { nodes: [node] } } }) };
  };
  const [got] = await linearHttpClient().listIssues('x');
  assert.deepEqual(got.blockedBy, ['BUI-3']);
  assert.match(query, /inverseRelations/);
});

test('REQ-LINEAR-20 the issue query bounds every nested connection, so it stays under Linear complexity limits', async () => {
  process.env.LINEAR_API_KEY = 'lin_api_test';
  let query;
  globalThis.fetch = async (url, opts) => {
    query = JSON.parse(opts.body).query;
    return { ok: true, json: async () => ({ data: { issues: { nodes: [] } } }) };
  };
  await linearHttpClient().listIssues('x');
  assert.match(query, /labels\(first: \d+\)/);
  assert.match(query, /inverseRelations\(first: \d+\)/);
});
