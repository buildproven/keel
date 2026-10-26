import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { attemptedIssueIds, cardFromIssue } from '../src/linear.js';
import { poll } from '../src/poll.js';
import { run } from '../src/run.js';
import { fixtureConfig, fixtureRepo, g, tmp } from './helpers.js';

const FAKE = fileURLToPath(new URL('./fake-worker.js', import.meta.url));
const builder = { provider: 'exec', family: 'claude', model: 'exec-good', effort: 'low', command: ['node', FAKE, 'good'] };
const author = (mode) => ({
  provider: 'exec',
  family: 'codex',
  model: 'exec-author',
  effort: 'high',
  command:
    mode === 'good'
      ? [
          'node',
          '-e',
          "const fs=require('fs');fs.mkdirSync('test',{recursive:true});fs.writeFileSync('test/held.test.js',\"import assert from 'node:assert';\\nimport { add } from '../src/add.js';\\nassert.strictEqual(add(2, 3), 5);\\n\");console.log(JSON.stringify({total_cost_usd:0.01,usage:{input_tokens:1,output_tokens:1}}));",
        ]
      : ['node', FAKE, mode],
});
const reviewer = (passes) => ({
  provider: 'exec',
  family: 'codex',
  model: 'exec-review',
  effort: 'high',
  command: ['node', '-e', `require('fs').readFileSync(0);${passes ? "console.log('VERDICT: pass')" : ''}`],
});
const config = (mode, review = null) =>
  fixtureConfig({
    tiers: [builder, author(mode), ...(review === null ? [] : [reviewer(review === 'up')])],
    heldOutAuthorTier: 1,
    review: review !== null,
    reviewFallback: false,
  });
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

test('REQ-RUN-41 a quota-limited re-author preserves a kept head for the next poll', async () => {
  const { dir } = fixtureRepo();
  const card = cardFromIssue(issue);
  const first = run({ repo: dir, card, config: config('good', 'down') });
  assert.equal(first.stopped, 'review-unavailable');
  assert.equal(first.pendingReview, true);
  const keptHead = g(first.worktree, 'rev-parse', 'HEAD');
  rmSync(join(process.env.KEEL_STATE_DIR, 'heldout', basename(first.worktree)), { recursive: true, force: true });
  const comments = [];
  const client = {
    listIssues: async () => [issue],
    comment: async (id, body) => comments.push({ id, body }),
    review: async () => {},
    stateType: async () => 'started',
  };

  const [deferred] = await poll({
    repo: dir,
    project: 'x',
    client,
    config: config('quota', 'down'),
    runFn: (args) => run(args),
  });

  assert.equal(deferred.result.stopped, 'quota');
  assert.equal(deferred.result.pendingReview, true);
  assert.equal(deferred.outcome, 'deferred');
  assert.ok(existsSync(first.worktree), 'poll removed the certified kept worktree');
  assert.equal(g(dir, 'rev-parse', first.branch), keptHead);
  assert.match(comments[0].body, /build passed every other stage and is kept/);

  const resumed = run({ repo: dir, card, config: config('good', 'up') });
  assert.equal(resumed.pass, true, resumed.failure);
  assert.equal(resumed.receipt.head, keptHead);
  const calls = readFileSync(process.env.KEEL_FAKE_LOG, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(calls.filter((call) => call.env.model === builder.model).length, 1, 'the kept head was rebuilt');
});
