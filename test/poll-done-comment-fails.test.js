import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { readJsonl } from '../src/ledger.js';
import { pollLedgerFile } from '../src/linear.js';
import { poll } from '../src/poll.js';
import { commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-done-comment-state-');
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

test('REQ-LINEAR-30 when moving to Done and the "stays open" comment both fail, the error and the reportFailed row name the failed move', async () => {
  const { dir } = fixtureRepo();
  const sha = commit(dir, { 'src/post.js': 'export const post = () => 1;\n' }, 'feat: first comment');
  const client = {
    listIssues: async () => [issue],
    comment: async () => {
      throw new Error('Linear API error: rate limited');
    },
    done: async () => {
      throw new Error('Linear API error: no "completed"-type state found on the team');
    },
    review: async () => {},
    stateType: async () => 'started',
  };
  const runFn = () => ({
    pass: false,
    stopped: 'blocked',
    failure: `already satisfied: commit ${sha.slice(0, 7)} added it.`,
    branch: 'keel/BUI-1018',
    worktree: '/nonexistent/wt',
  });
  const err = await poll({ repo: dir, project: 'x', client, config: fixtureConfig(), runFn }).then(
    () => assert.fail('the poll must fail visibly'),
    (e) => e,
  );
  assert.match(err.message, /"completed"-type state/);
  assert.match(err.message, /rate limited/, 'the failed comment is named too');
  const [row] = readJsonl(pollLedgerFile()).filter((r) => r.outcome === 'reportFailed');
  assert.match(row.detail, /"completed"-type state/);
});
