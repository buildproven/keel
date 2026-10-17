import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { linearHttpClient } from '../src/linear-http.js';
import { poll } from '../src/poll.js';
import { fixtureRepo, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

const issue = (id, title) => ({
  id,
  title,
  description: '- REQ-1: it shall work.',
  priority: 2,
  createdAt: '2026-09-01',
  labels: [],
  estimate: null,
});

test('REQ-LINEAR-22 a follow-up whose title a recently closed issue has is marked dup, not filed again', async () => {
  const { dir } = fixtureRepo();
  const created = [];
  const closed = [issue('BUI-5', 'Sub() subtracts in the wrong order')];
  const client = {
    listIssues: async (p, opts) => [issue('BUI-7', 't'), ...(opts?.closedWithinDays ? closed : [])],
    comment: async () => {},
    review: async () => {},
    stateType: async () => 'started',
    createIssue: async (sourceId, fields) => {
      created.push(fields.title);
      return `BUI-${100 + created.length}`;
    },
  };
  const runFn = () => ({
    pass: true,
    tier: 0,
    attempt: 1,
    branch: 'keel/BUI-7',
    worktree: '/tmp/x',
    followUps: [{ kind: 'bug', title: 'sub() subtracts in the wrong order', detail: 'src/sub.js:1' }],
  });
  await poll({ repo: dir, project: 'x', client, config: { ...DEFAULTS }, runFn });
  assert.deepEqual(created, []);
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.LINEAR_API_KEY;
});

test('REQ-LINEAR-22 listIssues with closedWithinDays also asks for issues completed or canceled in that many days', async () => {
  process.env.LINEAR_API_KEY = 'lin_api_test';
  const sent = [];
  globalThis.fetch = async (url, opts) => {
    sent.push(JSON.parse(opts.body).variables);
    return { ok: true, json: async () => ({ data: { issues: { pageInfo: { hasNextPage: false }, nodes: [] } } }) };
  };
  await linearHttpClient().listIssues('x', { closedWithinDays: 30 });
  await linearHttpClient().listIssues('x');
  const [withClosed, open] = sent.map((v) => v.filter);
  assert.deepEqual(withClosed.project, { name: { eq: 'x' } });
  assert.deepEqual(withClosed.or, [
    { state: { type: { nin: ['completed', 'canceled'] } } },
    { completedAt: { gt: '-P30D' } },
    { canceledAt: { gt: '-P30D' } },
  ]);
  assert.deepEqual(open.state, { type: { nin: ['completed', 'canceled'] } });
  assert.equal(open.or, undefined);
});
