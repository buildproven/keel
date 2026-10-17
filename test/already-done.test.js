import assert from 'node:assert/strict';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { parseCard } from '../src/config.js';
import { doneEvidence } from '../src/done.js';
import { attemptedIssueIds } from '../src/linear.js';
import { linearHttpClient } from '../src/linear-http.js';
import { poll } from '../src/poll.js';
import { buildPrompt, run } from '../src/run.js';
import { commit, fixtureConfig, fixtureRepo, g, tmp } from './helpers.js';

const originalFetch = globalThis.fetch;
const PATH = process.env.PATH;
beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-done-state-');
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.PATH = PATH;
  delete process.env.LINEAR_API_KEY;
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

function fakeClient() {
  const comments = [];
  const done = [];
  return {
    comments,
    done: Object.assign(async (id) => done.push(id), { calls: done }),
    listIssues: async () => [issue],
    comment: async (id, body) => comments.push({ id, body }),
    review: async () => {},
    stateType: async () => 'started',
  };
}

const blockedWith = (failure) => () => ({
  pass: false,
  stopped: 'blocked',
  failure,
  branch: 'keel/BUI-1018',
  worktree: '/nonexistent/wt',
});

test('REQ-LINEAR-30 doneEvidence reads the commits and PRs the real reasons name', () => {
  assert.deepEqual(
    doneEvidence(
      'BUI-1018 is already satisfied on main: PR #546 (commit 4616da6) added first-comment posting in scripts/post-social-bulletproof.py.',
    ),
    { commits: ['4616da6'], prs: [546] },
  );
  assert.deepEqual(
    doneEvidence(
      'Already satisfied by the current code: commit a23f762 "ci: security job runs npm ci once and has 20 minutes (#122)" made both changes.',
    ),
    { commits: ['a23f762'], prs: [122] },
  );
  assert.deepEqual(doneEvidence('Already satisfied: nothing to cite.'), { commits: [], prs: [] });
});

test('REQ-LINEAR-30 a claim whose commit is on base and whose base checks are green closes the issue as Done with the evidence', async () => {
  const { dir } = fixtureRepo();
  const sha = commit(dir, { 'src/post.js': 'export const post = () => 1;\n' }, 'feat: first comment');
  const client = fakeClient();
  const r = await poll({
    repo: dir,
    project: 'x',
    client,
    config: fixtureConfig(),
    runFn: blockedWith(`already satisfied: commit ${sha.slice(0, 7)} added it.`),
  });
  assert.equal(r[0].outcome, 'alreadyDone');
  assert.deepEqual(client.done.calls, ['BUI-1018']);
  assert.equal(client.comments.length, 1);
  const body = client.comments[0].body;
  assert.match(body, new RegExp(`commit ${sha.slice(0, 7)}[^\\n]*on base`));
  assert.match(body, /checks green[^\n]*test/);
  assert.match(body, new RegExp(g(dir, 'rev-parse', '--short', 'HEAD')));
  assert.ok(attemptedIssueIds(dir).has('BUI-1018'));
});

test('REQ-LINEAR-30 a merged PR named in KEEL_BLOCKED is evidence, read with gh pr view', async () => {
  const { dir } = fixtureRepo();
  const bin = tmp('keel-gh-');
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh\nif [ "$1 $2 $3" = "pr view 546" ]; then echo '{"state":"MERGED","mergeCommit":{"oid":"abc"}}'; else echo "no pull request $3" >&2; exit 1; fi\n`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  process.env.PATH = `${bin}:${PATH}`;
  const client = fakeClient();
  const r = await poll({
    repo: dir,
    project: 'x',
    client,
    config: fixtureConfig(),
    runFn: blockedWith('BUI-1018 is already satisfied on main: PR #546 added first-comment posting.'),
  });
  assert.equal(r[0].outcome, 'alreadyDone');
  assert.match(client.comments[0].body, /PR #546 merged/);
});

test('REQ-LINEAR-30 without verifiable evidence it stays a blocked stop for a human, with the reason', async () => {
  const cases = [
    ['already satisfied, nothing cited.', /names no commit or PR/],
    ['already satisfied: commit 0123456789abcdef0123456789abcdef01234567 did it.', /0123456789ab[^\n]*not on base/],
  ];
  for (const [failure, why] of cases) {
    process.env.KEEL_STATE_DIR = tmp('keel-done-state-');
    const { dir } = fixtureRepo();
    const client = fakeClient();
    const r = await poll({ repo: dir, project: 'x', client, config: fixtureConfig(), runFn: blockedWith(failure) });
    assert.equal(r[0].outcome, 'blocked');
    assert.deepEqual(client.done.calls, []);
    assert.match(client.comments[0].body, why);
  }
});

test('REQ-LINEAR-30 a commit off the base branch is not evidence, even when it exists', async () => {
  const { dir } = fixtureRepo();
  g(dir, 'checkout', '-q', '-b', 'side');
  const side = commit(dir, { 'src/side.js': 'export const s = 1;\n' }, 'side');
  g(dir, 'checkout', '-q', 'main');
  const client = fakeClient();
  const r = await poll({
    repo: dir,
    project: 'x',
    client,
    config: fixtureConfig(),
    runFn: blockedWith(`already satisfied: commit ${side.slice(0, 7)} did it.`),
  });
  assert.equal(r[0].outcome, 'blocked');
  assert.match(client.comments[0].body, /not on base/);
});

test('REQ-LINEAR-30 red base checks keep it a blocked stop', async () => {
  const { dir } = fixtureRepo();
  const sha = commit(dir, { 'test/red.test.js': "import assert from 'node:assert';\nassert.ok(false);\n" }, 'red');
  const client = fakeClient();
  const r = await poll({
    repo: dir,
    project: 'x',
    client,
    config: fixtureConfig(),
    runFn: blockedWith(`already satisfied: commit ${sha.slice(0, 7)} did it.`),
  });
  assert.equal(r[0].outcome, 'blocked');
  assert.deepEqual(client.done.calls, []);
  assert.match(client.comments[0].body, /check test failed on base/);
});

test('REQ-LINEAR-30 a blocked stop that claims nothing done is unchanged', async () => {
  const { dir } = fixtureRepo();
  const client = fakeClient();
  const r = await poll({ repo: dir, project: 'x', client, config: fixtureConfig(), runFn: blockedWith('the test is defective') });
  assert.equal(r[0].outcome, 'blocked');
  assert.doesNotMatch(client.comments[0].body, /evidence/);
});

const card = () => parseCard('# BUI-9: add a thing\nkind: feature\nsize: S\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n');

test('REQ-LINEAR-30 the builder prompt names KEEL_DONE for a card already satisfied, with the commit or PR', () => {
  assert.match(buildPrompt(card(), fixtureConfig(), null), /already satisfied[^\n]*KEEL_DONE[^\n]*commit[^\n]*PR/);
});

test('REQ-LINEAR-30 Keel reads and removes KEEL_DONE and stops blocked with an already-satisfied reason', () => {
  const { dir } = fixtureRepo();
  const tier = {
    provider: 'exec',
    model: 'exec-done',
    effort: 'low',
    command: [
      'node',
      '-e',
      "require('fs').readFileSync(0); require('fs').writeFileSync('KEEL_DONE', 'commit 4616da6 added it'); console.log(JSON.stringify({ is_error: false, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } }));",
    ],
  };
  const r = run({ repo: dir, card: card(), config: fixtureConfig({ tiers: [tier] }) });
  assert.equal(r.stopped, 'blocked');
  assert.match(r.failure, /^already satisfied: commit 4616da6 added it$/);
  assert.ok(!existsSync(join(r.worktree, 'KEEL_DONE')), 'never committed');
});

test('REQ-LINEAR-30 the HTTP client moves an issue to its team first completed-type state', async () => {
  process.env.LINEAR_API_KEY = 'lin_api_test';
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    if (/states/.test(body.query))
      return {
        ok: true,
        json: async () => ({
          data: {
            issue: {
              team: {
                states: {
                  nodes: [
                    { id: 's1', name: 'In Review', type: 'started' },
                    { id: 'd1', name: 'Done', type: 'completed' },
                    { id: 'd2', name: 'Shipped', type: 'completed' },
                  ],
                },
              },
            },
          },
        }),
      };
    return { ok: true, json: async () => ({ data: { issueUpdate: { success: true } } }) };
  };
  await linearHttpClient().done('BUI-1018');
  assert.deepEqual(calls.at(-1).variables, { id: 'BUI-1018', stateId: 'd1' });
});
