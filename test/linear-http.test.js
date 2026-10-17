import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { linearHttpClient } from '../src/linear-http.js';

let calls;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  process.env.LINEAR_API_KEY = 'lin_api_test';
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.LINEAR_API_KEY;
});

function stubFetch(responses) {
  let i = 0;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body), headers: opts.headers });
    const body = responses[i++];
    return { ok: true, json: async () => body };
  };
}

test('REQ-LINEAR-7 throws clearly when LINEAR_API_KEY is not set, before any request', async () => {
  delete process.env.LINEAR_API_KEY;
  globalThis.fetch = async () => assert.fail('must not call fetch without a key');
  const client = linearHttpClient();
  await assert.rejects(() => client.listIssues('agent-kit'), /LINEAR_API_KEY/);
});

test('REQ-LINEAR-1 listIssues sends the API key and project filter, and maps GraphQL fields to the plain shape pickIssue expects', async () => {
  stubFetch([
    {
      data: {
        issues: {
          nodes: [
            {
              identifier: 'BUI-545',
              title: 'fix the thing',
              description: 'x',
              priority: 2,
              createdAt: '2026-09-01T00:00:00Z',
              estimate: 3,
              labels: { nodes: [{ name: 'Bug' }] },
            },
          ],
        },
      },
    },
  ]);
  const issues = await linearHttpClient().listIssues('agent-kit');
  assert.deepEqual(issues, [
    {
      id: 'BUI-545',
      title: 'fix the thing',
      description: 'x',
      priority: 2,
      createdAt: '2026-09-01T00:00:00Z',
      estimate: 3,
      labels: ['Bug'],
      blockedBy: [],
    },
  ]);
  assert.equal(calls[0].headers.Authorization, 'lin_api_test');
  assert.match(calls[0].body.query, /issues\(/);
});

test('REQ-LINEAR-4 comment posts a comment mutation for the given issue identifier', async () => {
  stubFetch([{ data: { commentCreate: { success: true } } }]);
  await linearHttpClient().comment('BUI-545', 'hello');
  assert.match(calls[0].body.query, /commentCreate/);
  assert.equal(calls[0].body.variables.issueId, 'BUI-545');
  assert.equal(calls[0].body.variables.body, 'hello');
});

const statesReply = (nodes) => ({ data: { issue: { team: { states: { nodes } } } } });
const moved = { data: { issueUpdate: { success: true } } };

test('REQ-LINEAR-13 review prefers a started-type state named like "review", never a completed one', async () => {
  stubFetch([
    statesReply([
      { id: 'st-1', name: 'In Progress', type: 'started' },
      { id: 'st-2', name: 'In Review', type: 'started' },
      { id: 'st-3', name: 'Done', type: 'completed' },
    ]),
    moved,
  ]);
  await linearHttpClient().review('BUI-545');
  assert.match(calls[0].body.query, /states/);
  assert.match(calls[1].body.query, /issueUpdate/);
  assert.equal(calls[1].body.variables.stateId, 'st-2');
});

test('REQ-LINEAR-13 with no review-named state, review uses the first started-type state', async () => {
  stubFetch([
    statesReply([
      { id: 'st-0', name: 'Backlog', type: 'backlog' },
      { id: 'st-1', name: 'In Progress', type: 'started' },
      { id: 'st-3', name: 'Done', type: 'completed' },
    ]),
    moved,
  ]);
  await linearHttpClient().review('BUI-545');
  assert.equal(calls[1].body.variables.stateId, 'st-1');
});

test('REQ-LINEAR-13 with no started-type state, review fails visibly and moves nothing', async () => {
  stubFetch([statesReply([{ id: 'st-3', name: 'Done', type: 'completed' }])]);
  await assert.rejects(() => linearHttpClient().review('BUI-545'), /started/);
  assert.equal(calls.length, 1, 'no issueUpdate was sent');
});

test('REQ-LINEAR-7 a non-OK HTTP response or a GraphQL error is surfaced, not swallowed', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ errors: [{ message: 'unauthorized' }] }) });
  await assert.rejects(() => linearHttpClient().listIssues('x'), /401|unauthorized/);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ errors: [{ message: 'bad query' }] }) });
  await assert.rejects(() => linearHttpClient().listIssues('x'), /bad query/);
});

test('REQ-LINEAR-16 stateType reads the issue’s current state type', async () => {
  stubFetch([{ data: { issue: { state: { type: 'completed' } } } }]);
  assert.equal(await linearHttpClient().stateType('BUI-9'), 'completed');
  assert.match(calls[0].body.query, /state\s*{\s*type\s*}/);
  assert.deepEqual(calls[0].body.variables, { id: 'BUI-9' });
});
