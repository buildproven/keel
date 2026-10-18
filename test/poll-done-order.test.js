import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { attemptedIssueIds } from '../src/linear.js';
import { poll } from '../src/poll.js';
import { commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-done-order-state-');
});

const issue = {
  id: 'BUI-1018',
  title: 'post the first comment',
  description: '- REQ-1: post it.',
  priority: 2,
  createdAt: '2026-09-01',
  labels: ['Feature'],
  estimate: null,
  blockedBy: [],
};

/** A Linear whose move to Done fails; `calls` records each comment and done call in order. */
function failingDoneClient() {
  const calls = [];
  return {
    calls,
    listIssues: async () => [issue],
    comment: async (id, body) => calls.push({ op: 'comment', id, body }),
    done: async (id) => {
      calls.push({ op: 'done', id });
      throw new Error('Linear API error: no "completed"-type state found on the team');
    },
    review: async () => {},
    stateType: async () => 'started',
  };
}

const closedComments = (calls) => calls.filter((c) => c.op === 'comment' && /closed without a build/.test(c.body));

test('REQ-LINEAR-30 when moving a proven-done issue to Done fails, Keel posts no "closed" comment and says the issue stays open', async () => {
  const { dir } = fixtureRepo();
  const sha = commit(dir, { 'src/post.js': 'export const post = () => 1;\n' }, 'feat: first comment');
  const client = failingDoneClient();
  const runFn = () => ({
    pass: false,
    stopped: 'blocked',
    failure: `already satisfied: commit ${sha.slice(0, 7)} added it.`,
    branch: 'keel/BUI-1018',
    worktree: '/nonexistent/wt',
  });
  await assert.rejects(poll({ repo: dir, project: 'x', client, config: fixtureConfig(), runFn }), /completed/);
  assert.equal(client.calls[0].op, 'done', 'the issue is moved to Done before any comment claims it');
  assert.deepEqual(closedComments(client.calls), []);
  const [said] = client.calls.filter((c) => c.op === 'comment');
  assert.match(said.body, /could not move it to Done[^\n]*completed/);
  assert.match(said.body, /stays open/);
  // The run was paid for, so it is recorded and not built again (REQ-LINEAR-6).
  assert.ok(attemptedIssueIds(dir).has('BUI-1018'));
});

test('REQ-LINEAR-33 when an ALREADY_DONE refine answer holds but moving to Done fails, Keel posts no "closed" comment', async () => {
  const { dir, base } = fixtureRepo();
  const client = failingDoneClient();
  const refineFn = () => ({
    tier: 0,
    output: '',
    parsed: { kind: 'done', evidence: `commit ${base.slice(0, 10)}` },
  });
  let built = 0;
  const runFn = () => {
    built++;
    return { pass: true, tier: 0, attempt: 1, branch: 'keel/BUI-1018', worktree: '/nonexistent', followUps: [] };
  };
  const vague = { ...issue, description: 'The first comment is wrong sometimes.' };
  client.listIssues = async () => [vague];
  await assert.rejects(poll({ repo: dir, project: 'x', client, config: fixtureConfig(), runFn, refineFn }), /completed/);
  assert.equal(built, 0);
  assert.equal(client.calls[0].op, 'done', 'the issue is moved to Done before any comment claims it');
  assert.deepEqual(closedComments(client.calls), []);
  const [said] = client.calls.filter((c) => c.op === 'comment');
  assert.match(said.body, /could not move it to Done[^\n]*completed/);
});
