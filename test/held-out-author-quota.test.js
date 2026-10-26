import assert from 'node:assert/strict';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { attemptedIssueIds, cardFromIssue } from '../src/linear.js';
import { poll } from '../src/poll.js';
import { run } from '../src/run.js';
import { fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const FAKE = fileURLToPath(new URL('./fake-worker.js', import.meta.url));
const builder = { provider: 'exec', model: 'exec-good', effort: 'low', command: ['node', FAKE, 'good'] };
const author = (mode) => ({ provider: 'exec', model: 'exec-author', effort: 'high', command: ['node', FAKE, mode] });
const config = (mode) => fixtureConfig({ tiers: [builder, author(mode)], heldOutAuthorTier: 1 });
const issue = {
  id: 'BUI-1538',
  title: 'Defer a quota-limited held-out author',
  description: '- REQ-RUN-41: When the held-out author is out of quota, the run shall be deferred.\n',
  priority: 2,
  createdAt: '2026-10-21',
  labels: ['Bug'],
  estimate: 3,
};

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-held-out-quota-');
  process.env.KEEL_FAKE_LOG = join(tmp('keel-log-'), 'calls.jsonl');
});

test('REQ-RUN-41 a quota-limited held-out author stops as quota and poll records the issue as deferred', async () => {
  const { dir } = fixtureRepo();
  const comments = [];
  const client = {
    listIssues: async () => [issue],
    comment: async (id, body) => comments.push({ id, body }),
    review: async () => {},
    stateType: async () => 'started',
  };

  const [result] = await poll({
    repo: dir,
    project: 'x',
    client,
    config: config('quota'),
    runFn: (args) => run(args),
  });

  assert.equal(result.result.stopped, 'quota');
  assert.match(result.result.failure, /author worker quota:[\s\S]*usage limit reached/);
  assert.equal(result.outcome, 'deferred');
  assert.equal(attemptedIssueIds(dir).has(issue.id), false);
  assert.match(comments[0].body, /deferred \(quota\)[\s\S]*next poll/);
});

test('REQ-RUN-41 a crashing held-out author still stops as held-out-author', () => {
  const { dir } = fixtureRepo();
  const result = run({ repo: dir, card: cardFromIssue(issue), config: config('crash') });

  assert.equal(result.pass, false);
  assert.equal(result.stopped, 'held-out-author');
  assert.match(result.failure, /author worker error/);
});
