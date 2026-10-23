import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeEach, test } from 'node:test';
import { pendingFollowUps, recordPollAttempt } from '../src/linear.js';
import { poll, pollExitCode } from '../src/poll.js';
import { fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const BIN = fileURLToPath(new URL('../bin/keel.js', import.meta.url));

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-file-only-state-');
});

const open = {
  id: 'BUI-7',
  title: 'build me',
  description: '- REQ-1: it shall work.',
  priority: 1,
  createdAt: '2026-09-01',
  labels: ['Bug'],
  estimate: null,
  blockedBy: [],
};

function fakeClient({ fail = false } = {}) {
  const created = [];
  const comments = [];
  return {
    created,
    comments,
    listIssues: async () => [open],
    comment: async (id, body) => comments.push({ id, body }),
    review: async () => {},
    stateType: async () => 'started',
    capacity: async () => ({ open: 0, teams: [] }), // room in the workspace: no hold (REQ-LINEAR-37)
    createIssue: async (sourceId, fields) => {
      if (fail) throw new Error('Linear API error: rate limited');
      created.push({ sourceId, fields });
      return `BUI-${100 + created.length}`;
    },
  };
}

test('REQ-LINEAR-31 poll --file-only files the queued follow-ups and builds, comments on, and records no issue', async () => {
  const { dir } = fixtureRepo();
  recordPollAttempt(dir, { issue: null, outcome: 'found', detail: [{ kind: 'bug', title: 'audit finding one', detail: 'a.js:1' }] });
  const client = fakeClient();
  const runFn = () => assert.fail('file-only must not build');
  const r = await poll({ repo: dir, project: 'x', client, config: fixtureConfig({ followUpsPerDay: 5 }), runFn, fileOnly: true });
  assert.deepEqual(r, []);
  assert.equal(pollExitCode(r), 0);
  assert.equal(client.created.length, 1);
  assert.equal(client.created[0].fields.title, 'audit finding one');
  assert.deepEqual(client.comments, [], 'no source issue, no comment');
  assert.deepEqual(pendingFollowUps(dir), []);
});

test('REQ-LINEAR-31 a filing error under --file-only exits 1', async () => {
  const { dir } = fixtureRepo();
  recordPollAttempt(dir, { issue: null, outcome: 'found', detail: [{ kind: 'bug', title: 'audit finding two', detail: 'b.js:1' }] });
  const r = await poll({
    repo: dir,
    project: 'x',
    client: fakeClient({ fail: true }),
    config: fixtureConfig({ followUpsPerDay: 5 }),
    runFn: () => assert.fail('file-only must not build'),
    fileOnly: true,
  });
  assert.equal(r[0].outcome, 'followUpsFailed');
  assert.equal(pollExitCode(r), 1);
});

test('REQ-LINEAR-31 --file-only with --issue is a usage error', () => {
  const { dir } = fixtureRepo();
  const r = spawnSync(process.execPath, [BIN, 'poll', '--project', 'x', '--file-only', '--issue', 'BUI-1', '--repo', dir], {
    encoding: 'utf8',
    env: { ...process.env, LINEAR_API_KEY: '' },
  });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--file-only.*--issue|--issue.*--file-only/);
});
