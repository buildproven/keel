import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { recordPollAttempt } from '../src/linear.js';
import { OPEN_PR_LIMIT, poll } from '../src/poll.js';
import { fixtureRepo, g, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

const issue = (id, createdAt) => ({
  id,
  title: id,
  description: '- REQ-1: it shall work.',
  priority: 2,
  createdAt,
  labels: [],
  estimate: null,
});

/** A fake gh: `pr list` prints `prs`; every call is logged. */
function fakeGh(prs) {
  const bin = tmp('keel-bin-');
  const log = join(bin, 'calls.jsonl');
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env node
const a = process.argv.slice(2);
require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
if (a[0] === 'pr' && a[1] === 'list') console.log(${JSON.stringify(JSON.stringify(prs))});
`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l))
      : [];
  return { bin, calls };
}

test('REQ-LINEAR-23 a poll closes its own conflicting PR and builds the issue again on the current base', async () => {
  const { dir } = fixtureRepo();
  g(dir, 'remote', 'add', 'origin', tmp('keel-remote-'));
  g(dir, 'branch', 'keel/BUI-7');
  recordPollAttempt(dir, { issue: 'BUI-7', outcome: 'autoMerge' });
  const gh = fakeGh([
    { number: 5, headRefName: 'keel/BUI-7', mergeable: 'CONFLICTING' },
    { number: 6, headRefName: 'feat/mine', mergeable: 'CONFLICTING' },
    { number: 7, headRefName: 'keel/BUI-9', mergeable: 'MERGEABLE' },
    { number: 8, headRefName: 'keel/BUI-10', mergeable: 'UNKNOWN' },
  ]);
  const comments = [];
  const client = {
    listIssues: async () => [issue('BUI-7', '2026-09-01')],
    comment: async (id, body) => comments.push({ id, body }),
    review: async () => {},
    stateType: async () => 'started',
  };
  const seen = [];
  const runFn = ({ card: c }) => (seen.push(c.id), { pass: true, tier: 0, attempt: 1, branch: `keel/${c.id}`, worktree: '/tmp/x' });
  const old = process.env.PATH;
  process.env.PATH = `${gh.bin}:${old}`;
  try {
    await poll({ repo: dir, project: 'x', client, config: {}, runFn });
  } finally {
    process.env.PATH = old;
  }
  const closes = gh.calls().filter((a) => a[0] === 'pr' && a[1] === 'close');
  assert.equal(closes.length, 1);
  assert.equal(closes[0][2], '5');
  assert.ok(closes[0].includes('--delete-branch'));
  assert.match(closes[0][closes[0].indexOf('--comment') + 1], /conflicts with the base branch/);
  assert.equal(g(dir, 'branch', '--list', 'keel/BUI-7'), '', 'the local branch is gone, so the build can start fresh');
  assert.deepEqual(seen, ['BUI-7']);
  assert.ok(comments.some((c) => c.id === 'BUI-7' && /PR #5 conflicted with the base branch; building again/.test(c.body)));
});

test('REQ-LINEAR-23 a conflicting branch checked out in a worktree is cleaned first; a failed comment still leaves the issue deferred; branch names match exactly', async () => {
  const { dir } = fixtureRepo();
  g(dir, 'remote', 'add', 'origin', tmp('keel-remote-'));
  const wt = join(tmp('keel-wt-'), 'wt');
  g(dir, 'worktree', 'add', '-q', '-b', 'keel/BUI-7', wt);
  const other = join(tmp('keel-wt-'), 'other');
  g(dir, 'worktree', 'add', '-q', '-b', 'keel/BUI-70', other);
  writeFileSync(join(other, 'dirty.txt'), 'x');
  recordPollAttempt(dir, { issue: 'BUI-7', outcome: 'autoMerge' });
  const gh = fakeGh([{ number: 5, headRefName: 'keel/BUI-7', mergeable: 'CONFLICTING' }]);
  const client = {
    listIssues: async () => [],
    comment: async () => {
      throw new Error('Linear API error: 502');
    },
    review: async () => {},
    stateType: async () => 'started',
  };
  const old = process.env.PATH;
  process.env.PATH = `${gh.bin}:${old}`;
  try {
    await assert.rejects(() => poll({ repo: dir, project: 'x', client, config: {}, runFn: () => ({}) }), /502/);
  } finally {
    process.env.PATH = old;
  }
  assert.equal(existsSync(wt), false, 'the BUI-7 worktree is removed before gh deletes the branch');
  assert.equal(existsSync(other), true, 'keel/BUI-70 is not keel/BUI-7');
  const rows = readFileSync(join(process.env.KEEL_STATE_DIR, 'poll-ledger.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.equal(rows.at(-1).outcome, 'deferred');
});

test('REQ-LINEAR-41 a poll rebuilds its own PR that is behind its base with auto-merge armed; one without auto-merge stays', async () => {
  const { dir } = fixtureRepo();
  g(dir, 'remote', 'add', 'origin', tmp('keel-remote-'));
  g(dir, 'branch', 'keel/BUI-7');
  g(dir, 'branch', 'keel/BUI-8');
  recordPollAttempt(dir, { issue: 'BUI-7', outcome: 'autoMerge' });
  recordPollAttempt(dir, { issue: 'BUI-8', outcome: 'autoMerge' });
  const armed = { mergeMethod: 'SQUASH' };
  const gh = fakeGh([
    { number: 5, headRefName: 'keel/BUI-7', mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND', autoMergeRequest: armed },
    { number: 6, headRefName: 'keel/BUI-8', mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND', autoMergeRequest: null },
    { number: 7, headRefName: 'keel/BUI-9', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', autoMergeRequest: armed },
    { number: 8, headRefName: 'feat/mine', mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND', autoMergeRequest: armed },
  ]);
  const comments = [];
  const client = {
    listIssues: async () => [issue('BUI-7', '2026-09-01'), issue('BUI-8', '2026-09-02')],
    comment: async (id, body) => comments.push({ id, body }),
    review: async () => {},
    stateType: async () => 'started',
  };
  const seen = [];
  const runFn = ({ card: c }) => (seen.push(c.id), { pass: true, tier: 0, attempt: 1, branch: `keel/${c.id}`, worktree: '/tmp/x' });
  const old = process.env.PATH;
  process.env.PATH = `${gh.bin}:${old}`;
  try {
    await poll({ repo: dir, project: 'x', client, config: {}, runFn });
  } finally {
    process.env.PATH = old;
  }
  const list = gh.calls().find((a) => a[0] === 'pr' && a[1] === 'list');
  assert.match(list[list.indexOf('--json') + 1], /mergeStateStatus/);
  assert.match(list[list.indexOf('--json') + 1], /autoMergeRequest/);
  assert.ok(Number(list[list.indexOf('--limit') + 1]) >= 1000, 'older PRs past the first 100 are checked too');
  const closes = gh.calls().filter((a) => a[0] === 'pr' && a[1] === 'close');
  assert.deepEqual(
    closes.map((c) => c[2]),
    ['5'],
  );
  assert.match(closes[0][closes[0].indexOf('--comment') + 1], /behind the base branch/);
  assert.equal(g(dir, 'branch', '--list', 'keel/BUI-7'), '');
  assert.notEqual(g(dir, 'branch', '--list', 'keel/BUI-8'), '', 'a PR without auto-merge waits for a human');
  assert.deepEqual(seen, ['BUI-7']);
  assert.ok(comments.some((c) => c.id === 'BUI-7' && /PR #5 was behind the base branch; building again/.test(c.body)));
});

test('REQ-LINEAR-41 a list that reaches the open-PR limit says older PRs were not checked', async () => {
  const { dir } = fixtureRepo();
  g(dir, 'remote', 'add', 'origin', tmp('keel-remote-'));
  const prs = Array.from({ length: OPEN_PR_LIMIT }, (_, i) => ({ number: i + 1, headRefName: `feat/x${i}`, mergeable: 'MERGEABLE' }));
  const gh = fakeGh(prs);
  const client = { listIssues: async () => [], comment: async () => {}, review: async () => {}, stateType: async () => 'started' };
  const lines = [];
  const old = process.env.PATH;
  process.env.PATH = `${gh.bin}:${old}`;
  try {
    await poll({ repo: dir, project: 'x', client, config: {}, runFn: () => ({}), log: (l) => lines.push(l) });
  } finally {
    process.env.PATH = old;
  }
  assert.ok(lines.some((l) => l === `conflict check covered only the newest ${OPEN_PR_LIMIT} open PRs; older ones were not checked`));
});
