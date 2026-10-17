import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig, parseCard } from '../src/config.js';
import { attemptedIssueIds, pollLedgerFile, recordPollAttempt } from '../src/linear.js';
import { readJsonl } from '../src/ledger.js';
import { poll, pollExitCode } from '../src/poll.js';
import { run } from '../src/run.js';
import { fixtureConfig, fixtureRepo, g, tmp } from './helpers.js';

const FAKE = fileURLToPath(new URL('./fake-worker.js', import.meta.url));
const builder = { provider: 'exec', family: 'claude', model: 'exec-good', effort: 'low', command: ['node', FAKE, 'good'] };
const reviewer = {
  provider: 'exec',
  family: 'codex',
  model: 'exec-review',
  effort: 'high',
  command: ['node', '-e', "require('fs').readFileSync(0); console.log('VERDICT: pass')"],
};
const card = () => parseCard('# BUI-9: fix add\nkind: bug\nsize: S\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n');
const URL_ = 'https://example.test/pr/7';
const SHA = 'a'.repeat(40);

let bin;
let ghLog;
let ghState;
let oldPath;

/**
 * A fake `gh` driven by a JSON state file the test rewrites between polls: `pr view` prints `pr`, `api …actions/runs…`
 * prints `runs` (or the pages of `runsPages`), other `api` calls print `checks` (the required-check count, and the
 * allow_auto_merge answer), `pr merge` exits `mergeExit`, `pr edit` exits `editExit`. Every call is logged.
 */
function setGh(state) {
  writeFileSync(ghState, JSON.stringify(state));
}

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
  process.env.KEEL_FAKE_LOG = join(tmp('keel-log-'), 'calls.jsonl');
  bin = tmp('keel-bin-');
  ghLog = join(bin, 'calls.jsonl');
  ghState = join(bin, 'state.json');
  setGh({});
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify(a) + '\\n');
const s = JSON.parse(fs.readFileSync(${JSON.stringify(ghState)}, 'utf8'));
if (a[0] === 'api' && a.some((x) => x.includes('actions/runs'))) {
  // GitHub pages the runs: only --paginate --slurp prints every page, as an array of response objects.
  const pages = s.runsPages ?? [s.runs ?? []];
  if (a.includes('--paginate') && a.includes('--slurp')) console.log(JSON.stringify(pages.map((p) => ({ workflow_runs: p }))));
  else if (a.includes('--jq')) console.log(JSON.stringify(pages[0]));
  else console.log(JSON.stringify({ workflow_runs: pages[0] }));
  process.exit(s.runsExit ?? 0);
}
if (a[0] === 'api') { console.log(s.checks ?? '1'); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'view') { console.log(JSON.stringify(s.pr)); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'create') { console.log(${JSON.stringify(URL_)}); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'merge') { if (s.mergeExit) console.error('merge refused'); process.exit(s.mergeExit ?? 0); }
if (a[0] === 'pr' && a[1] === 'edit') { if (s.editExit) console.error('edit refused'); process.exit(s.editExit ?? 0); }
process.exit(0);
`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
});

afterEach(() => {
  process.env.PATH = oldPath;
});

const ghCalls = () =>
  existsSync(ghLog)
    ? readFileSync(ghLog, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
    : [];
const prCalls = (verb) => ghCalls().filter((a) => a[0] === 'pr' && a[1] === verb);
const pollRows = () => readJsonl(pollLedgerFile());

function repoWithRemote() {
  const { dir } = fixtureRepo();
  const remote = tmp('keel-remote-');
  g(remote, 'init', '-q', '--bare');
  g(dir, 'remote', 'add', 'origin', remote);
  return dir;
}

function fakeClient(issues = []) {
  const calls = [];
  return {
    calls,
    listIssues: async () => issues,
    comment: async (id, body) => calls.push({ id, body }),
    review: async (id) => calls.push({ id, action: 'review' }),
    stateType: async () => 'started',
  };
}

const green = (over = {}) => ({
  state: 'OPEN',
  isDraft: false,
  headRefOid: SHA,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  statusCheckRollup: [
    { __typename: 'StatusContext', context: 'keel/gate', state: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
  ],
  ...over,
});

const pending = (repo, minutesAgo = 1) =>
  recordPollAttempt(repo, {
    issue: 'BUI-1',
    outcome: 'self-merge',
    detail: { pr: URL_, sha: SHA, since: new Date(Date.now() - minutesAgo * 60_000).toISOString() },
  });

const config = { selfMergeTimeoutMinutes: 30, followUpsPerDay: 0 };
const pollMerge = (dir, client, extra = {}) => poll({ repo: dir, project: 'x', client, config, pr: true, merge: true, ...extra });

test('REQ-MERGE-1 --merge without required checks marks the PR for a Keel self-merge: not a draft, the reason in the body', () => {
  setGh({ checks: '0' });
  const r = run({
    repo: repoWithRemote(),
    card: card(),
    config: fixtureConfig({ review: true, tiers: [builder, reviewer] }),
    pr: true,
    merge: true,
  });
  assert.equal(r.pass, true, r.failure);
  assert.equal(r.merge.state, 'off');
  assert.match(r.merge.reason, /no required status checks/);
  assert.equal(r.merge.selfMerge, true);
  assert.deepEqual(prCalls('merge'), [], 'nothing merges during the run');
  const create = prCalls('create')[0];
  assert.ok(!create.includes('--draft'));
  assert.match(create[create.indexOf('--body') + 1], /keel poll --merge merges this certified SHA itself once every check on it passes/);
});

test('REQ-MERGE-1 a refused auto-merge call also falls back to a self-merge, and review off never does', () => {
  setGh({ mergeExit: 1 });
  const refused = run({
    repo: repoWithRemote(),
    card: card(),
    config: fixtureConfig({ review: true, tiers: [builder, reviewer] }),
    pr: true,
    merge: true,
  });
  assert.equal(refused.merge.state, 'failed');
  assert.equal(refused.merge.selfMerge, true);
  setGh({ checks: '0' });
  const off = run({ repo: repoWithRemote(), card: card(), config: fixtureConfig({ tiers: [builder, reviewer] }), pr: true, merge: true });
  assert.equal(off.merge.state, 'off');
  assert.match(off.merge.reason, /review is off/);
  assert.equal(off.merge.selfMerge, undefined);
});

test('REQ-MERGE-1 keel poll records a pending self-merge in the poll ledger, comments, and moves the issue to review', async () => {
  const { dir } = fixtureRepo();
  const issue = { id: 'BUI-1', title: 't', description: '- REQ-1: it shall work.', priority: 2, createdAt: '2026-09-01', labels: ['Bug'] };
  const client = fakeClient([issue]);
  const runFn = () => ({
    pass: true,
    tier: 0,
    attempt: 1,
    branch: 'keel/BUI-1',
    needsReview: false,
    worktree: '/wt',
    receipt: { head: SHA },
    pr: { ok: true, out: URL_ },
    merge: { state: 'off', reason: 'no required status checks on main', selfMerge: true },
  });
  const [result] = await pollMerge(dir, client, { runFn });
  assert.equal(result.outcome, 'selfMerge');
  const row = pollRows().find((r) => r.outcome === 'self-merge');
  assert.equal(row.issue, 'BUI-1');
  assert.equal(row.detail.pr, URL_);
  assert.equal(row.detail.sha, SHA);
  assert.match(client.calls[0].body, /GitHub auto-merge is unavailable \(no required status checks on main\)/);
  assert.match(client.calls[0].body, new RegExp(`merges ${SHA} itself once every check on it passes`));
  assert.equal(client.calls[1].action, 'review');
  assert.deepEqual(prCalls('merge'), []);
});

test('REQ-MERGE-2 a pending self-merge with every check green merges exactly the certified SHA at the next poll', async () => {
  const { dir } = fixtureRepo();
  pending(dir);
  setGh({ pr: green(), runs: [{ name: 'CI', status: 'completed', conclusion: 'success' }] });
  const client = fakeClient();
  const results = await pollMerge(dir, client);
  assert.deepEqual(prCalls('merge'), [['pr', 'merge', URL_, '--squash', '--match-head-commit', SHA]]);
  assert.ok(results.some((r) => r.outcome === 'merged' && r.issue === 'BUI-1'));
  assert.equal(pollRows().at(-1).outcome !== 'self-merge', true);
  assert.ok(pollRows().some((r) => r.outcome === 'self-merged' && r.detail.pr === URL_));
  assert.equal(pollExitCode(results), 0);
  await pollMerge(dir, client);
  assert.equal(prCalls('merge').length, 1, 'a settled self-merge is not tried again');
});

test('REQ-MERGE-2 a pending check leaves the self-merge recorded, and the next poll finishes it', async () => {
  const { dir } = fixtureRepo();
  pending(dir);
  const logs = [];
  setGh({
    pr: green({
      statusCheckRollup: [
        { __typename: 'StatusContext', context: 'keel/gate', state: 'SUCCESS' },
        { __typename: 'CheckRun', name: 'ci', status: 'IN_PROGRESS', conclusion: null },
      ],
    }),
  });
  const first = await pollMerge(dir, fakeClient(), { log: (l) => logs.push(l) });
  assert.deepEqual(prCalls('merge'), []);
  assert.ok(!first.some((r) => r.outcome === 'mergeFailed'));
  assert.ok(
    logs.some((l) => /BUI-1: self-merge waits for ci/.test(l)),
    logs.join('\n'),
  );
  setGh({ pr: green() });
  await pollMerge(dir, fakeClient());
  assert.deepEqual(prCalls('merge'), [['pr', 'merge', URL_, '--squash', '--match-head-commit', SHA]]);
});

test('REQ-MERGE-2 a missing keel/gate status, a queued workflow run, or an unsettled merge state is pending, not a pass', async () => {
  const { dir } = fixtureRepo();
  pending(dir);
  for (const state of [
    { pr: green({ statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] }) },
    { pr: green(), runs: [{ name: 'CI', status: 'queued', conclusion: null }] },
    { pr: green({ mergeStateStatus: 'UNKNOWN' }) },
    { pr: green(), runsExit: 1 },
  ]) {
    setGh(state);
    const logs = [];
    const results = await pollMerge(dir, fakeClient(), { log: (l) => logs.push(l) });
    assert.ok(!results.some((r) => ['merged', 'mergeFailed'].includes(r.outcome)), JSON.stringify(state));
    assert.ok(
      logs.some((l) => l.startsWith('BUI-1: self-merge waits for ')),
      `${JSON.stringify(state)}\n${logs.join('\n')}`,
    );
  }
  assert.deepEqual(prCalls('merge'), []);
});

test('REQ-MERGE-2 self-merge rows are not attempts, and without --merge nothing is merged', async () => {
  const { dir } = fixtureRepo();
  recordPollAttempt(dir, { issue: 'BUI-1', outcome: 'deferred', detail: 'PR #7 conflicted' });
  pending(dir);
  setGh({ pr: green({ state: 'CLOSED' }) });
  await pollMerge(dir, fakeClient());
  assert.ok(pollRows().some((r) => r.outcome === 'self-merge-closed'));
  assert.ok(!attemptedIssueIds(dir).has('BUI-1'), 'the deferred issue stays retryable');
  const other = fixtureRepo().dir;
  pending(other);
  setGh({ pr: green() });
  await poll({ repo: other, project: 'x', client: fakeClient(), config, pr: true });
  assert.deepEqual(prCalls('merge'), []);
});

test('REQ-MERGE-3 a failed check is not merged: the PR stays open with a comment on it and on the issue, and the poll exits 1', async () => {
  const { dir } = fixtureRepo();
  pending(dir);
  setGh({
    pr: green({
      statusCheckRollup: [
        { __typename: 'StatusContext', context: 'keel/gate', state: 'SUCCESS' },
        { __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' },
      ],
    }),
  });
  const client = fakeClient();
  const results = await pollMerge(dir, client);
  assert.deepEqual(prCalls('merge'), []);
  const failed = results.find((r) => r.outcome === 'mergeFailed');
  assert.match(failed.detail, /ci failed/);
  assert.equal(pollExitCode(results), 1);
  const comment = prCalls('comment')[0];
  assert.equal(comment[2], URL_);
  assert.match(comment[comment.indexOf('--body') + 1], /keel: not merged: check ci failed/);
  assert.match(client.calls.find((c) => c.id === 'BUI-1').body, /keel: not merged: check ci failed/);
  assert.ok(pollRows().some((r) => r.outcome === 'self-merge-failed'));
  await pollMerge(dir, fakeClient());
  assert.equal(prCalls('comment').length, 1, 'a settled failure is reported once');
});

test('REQ-MERGE-3 a head a human changed after the gate is never merged', async () => {
  const { dir } = fixtureRepo();
  pending(dir);
  setGh({ pr: green({ headRefOid: 'b'.repeat(40) }) });
  const client = fakeClient();
  const results = await pollMerge(dir, client);
  assert.deepEqual(prCalls('merge'), []);
  assert.match(results.find((r) => r.outcome === 'mergeFailed').detail, new RegExp(`head ${'b'.repeat(40)} is not the certified ${SHA}`));
});

test('REQ-MERGE-3 a branch behind its base, a draft, or a refused merge call is not merged and is reported', async () => {
  for (const [state, reason] of [
    [{ pr: green({ mergeStateStatus: 'BEHIND' }) }, /behind its base/],
    [{ pr: green({ isDraft: true }) }, /draft/],
    [{ pr: green(), mergeExit: 1 }, /gh pr merge failed: merge refused/],
  ]) {
    const { dir } = fixtureRepo();
    pending(dir);
    setGh(state);
    const results = await pollMerge(dir, fakeClient());
    assert.match(results.find((r) => r.outcome === 'mergeFailed')?.detail ?? '', reason, JSON.stringify(state));
  }
  assert.equal(prCalls('merge').length, 1, 'only the refused call reached gh pr merge');
});

test('REQ-MERGE-3 a conflicting PR is left to the conflict rebuild, and a PR merged by someone else settles quietly', async () => {
  const { dir } = fixtureRepo();
  pending(dir);
  setGh({ pr: green({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }) });
  const client = fakeClient();
  let results = await pollMerge(dir, client);
  assert.ok(!results.some((r) => r.outcome === 'mergeFailed'));
  assert.deepEqual(prCalls('comment'), []);
  setGh({ pr: green({ state: 'MERGED' }) });
  results = await pollMerge(dir, client);
  assert.ok(pollRows().some((r) => r.outcome === 'self-merged'));
  assert.deepEqual(prCalls('merge'), []);
  assert.deepEqual(client.calls, []);
});

test('REQ-MERGE-4 checks still pending after selfMergeTimeoutMinutes are a failure, not a pass', async () => {
  const { dir } = fixtureRepo();
  pending(dir, 31);
  setGh({
    pr: green({
      statusCheckRollup: [
        { __typename: 'StatusContext', context: 'keel/gate', state: 'SUCCESS' },
        { __typename: 'StatusContext', context: 'deploy', state: 'PENDING' },
      ],
    }),
  });
  const client = fakeClient();
  const results = await pollMerge(dir, client);
  assert.deepEqual(prCalls('merge'), []);
  assert.match(results.find((r) => r.outcome === 'mergeFailed').detail, /checks not green after 30 minutes: deploy/);
  assert.match(client.calls[0].body, /keel: not merged: checks not green after 30 minutes/);
});

test('REQ-MERGE-4 selfMergeTimeoutMinutes defaults to 30 and must be a positive number', () => {
  const dir = fixtureRepo().dir;
  assert.equal(fixtureConfig().selfMergeTimeoutMinutes, 30);
  for (const bad of [0, -5, '30', null]) {
    g(dir, 'checkout', '-q', 'main');
    writeFileSync(join(dir, 'keel.json'), JSON.stringify({ checks: { t: 'true' }, testCommand: 'true', selfMergeTimeoutMinutes: bad }));
    g(dir, 'add', '-A');
    g(dir, 'commit', '-q', '-m', `bad ${bad}`);
    assert.throws(() => loadConfig(dir, 'HEAD'), /"selfMergeTimeoutMinutes" must be a positive number/, String(bad));
  }
});

test('REQ-MERGE-5 a refused auto-merge call rewrites the PR body: auto-merge off with the reason and the self-merge line', () => {
  setGh({ mergeExit: 1 });
  const logs = [];
  const r = run({
    repo: repoWithRemote(),
    card: card(),
    config: fixtureConfig({ review: true, tiers: [builder, reviewer] }),
    pr: true,
    merge: true,
    log: (l) => logs.push(l),
  });
  assert.equal(r.merge.selfMerge, true);
  const create = prCalls('create')[0];
  assert.match(create[create.indexOf('--body') + 1], /Auto-merge: on/, 'the body is written before GitHub answers');
  const edit = prCalls('edit')[0];
  assert.ok(edit, 'the body is corrected');
  assert.equal(edit[2], URL_);
  const body = edit[edit.indexOf('--body') + 1];
  assert.doesNotMatch(body, /Auto-merge: on/);
  assert.match(body, /Auto-merge: off — merge refused; keel poll --merge merges this certified SHA itself once every check on it passes/);
  setGh({ mergeExit: 1, editExit: 1 });
  run({
    repo: repoWithRemote(),
    card: card(),
    config: fixtureConfig({ review: true, tiers: [builder, reviewer] }),
    pr: true,
    merge: true,
    log: (l) => logs.push(l),
  });
  assert.ok(
    logs.some((l) => /PR body not corrected: edit refused/.test(l)),
    logs.join('\n'),
  );
});

test('REQ-MERGE-6 a branch behind its base fails at once, even while a check is still pending', async () => {
  const { dir } = fixtureRepo();
  pending(dir);
  setGh({
    pr: green({
      mergeStateStatus: 'BEHIND',
      statusCheckRollup: [
        { __typename: 'StatusContext', context: 'keel/gate', state: 'SUCCESS' },
        { __typename: 'CheckRun', name: 'ci', status: 'IN_PROGRESS', conclusion: null },
      ],
    }),
  });
  const client = fakeClient();
  const results = await pollMerge(dir, client);
  assert.match(results.find((r) => r.outcome === 'mergeFailed')?.detail ?? '', /behind its base/);
  assert.ok(pollRows().some((r) => r.outcome === 'self-merge-failed'));
  assert.equal(pollExitCode(results), 1);
  assert.match(client.calls[0].body, /keel: not merged: the branch is behind its base/);
});

test('REQ-MERGE-7 a failed or queued workflow run past the first page of the Actions API blocks the merge', async () => {
  const page1 = Array.from({ length: 30 }, (_, i) => ({ name: `w${i}`, status: 'completed', conclusion: 'success' }));
  for (const [late, expect] of [
    [{ name: 'late', status: 'completed', conclusion: 'failure' }, 'mergeFailed'],
    [{ name: 'late', status: 'queued', conclusion: null }, 'wait'],
  ]) {
    const { dir } = fixtureRepo();
    pending(dir);
    setGh({ pr: green(), runsPages: [page1, [late]] });
    const logs = [];
    const results = await pollMerge(dir, fakeClient(), { log: (l) => logs.push(l) });
    assert.ok(!results.some((r) => r.outcome === 'merged'), JSON.stringify(late));
    if (expect === 'mergeFailed') assert.match(results.find((r) => r.outcome === 'mergeFailed')?.detail ?? '', /workflow late failed/);
    else
      assert.ok(
        logs.some((l) => /self-merge waits for workflow late/.test(l)),
        logs.join('\n'),
      );
  }
  assert.deepEqual(prCalls('merge'), []);
  const call = ghCalls().find((a) => a[0] === 'api' && a.some((x) => x.includes('actions/runs')));
  assert.ok(
    call.some((x) => x.includes('per_page=100')),
    JSON.stringify(call),
  );
});
