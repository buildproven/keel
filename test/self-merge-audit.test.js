import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseCard } from '../src/config.js';
import { pollLedgerFile, recordPollAttempt } from '../src/linear.js';
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
 * A fake `gh` driven by a JSON state file: `pr view` prints `pr`; `api …actions/runs…` pages `runsPages` as GitHub
 * does, printing the first page only, or every page (one JSON array a line) with `--paginate`; other `api` calls print
 * `checks`; `pr merge` exits `mergeExit`; `pr edit` exits `editExit`. Every call is logged.
 */
const setGh = (state) => writeFileSync(ghState, JSON.stringify(state));

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
  const pages = s.runsPages ?? [[]];
  for (const p of a.includes('--paginate') ? pages : pages.slice(0, 1)) console.log(JSON.stringify(p));
  process.exit(0);
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

function repoWithRemote() {
  const { dir } = fixtureRepo();
  const remote = tmp('keel-remote-');
  g(remote, 'init', '-q', '--bare');
  g(dir, 'remote', 'add', 'origin', remote);
  return dir;
}

function fakeClient() {
  const calls = [];
  return {
    calls,
    listIssues: async () => [],
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

const pending = (repo) =>
  recordPollAttempt(repo, {
    issue: 'BUI-1',
    outcome: 'self-merge',
    detail: { pr: URL_, sha: SHA, since: new Date(Date.now() - 60_000).toISOString() },
  });

const config = { selfMergeTimeoutMinutes: 30, followUpsPerDay: 0 };
const pollMerge = (dir, client, extra = {}) => poll({ repo: dir, project: 'x', client, config, pr: true, merge: true, ...extra });
const runMerge = (log) =>
  run({
    repo: repoWithRemote(),
    card: card(),
    config: fixtureConfig({ review: true, tiers: [builder, reviewer] }),
    pr: true,
    merge: true,
    log,
  });

test('REQ-MERGE-5 a refused auto-merge call rewrites the PR body: auto-merge off with the reason and the self-merge line', () => {
  setGh({ mergeExit: 1 });
  const logs = [];
  const r = runMerge((l) => logs.push(l));
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
  runMerge((l) => logs.push(l));
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
  assert.ok(readJsonl(pollLedgerFile()).some((r) => r.outcome === 'self-merge-failed'));
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
