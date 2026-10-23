import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
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

test('REQ-LINEAR-22 a queued title with trailing space matches the trimmed title Linear stores, so it is a dup', async () => {
  const { dir } = fixtureRepo();
  const created = [];
  const client = {
    listIssues: async () => [issue('BUI-7', 't'), issue('BUI-5', 'Review: add(-0, 0) returns 0, not -0.')],
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
    followUps: [{ kind: 'bug', title: 'Review: add(-0, 0) returns 0, not -0. ', detail: 'low src/add.js:1' }],
  });
  await poll({ repo: dir, project: 'x', client, config: { ...DEFAULTS }, runFn });
  assert.deepEqual(created, []);
});
