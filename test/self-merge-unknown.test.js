import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { pollLedgerFile, recordPollAttempt } from '../src/linear.js';
import { readJsonl } from '../src/ledger.js';
import { finishSelfMerges } from '../src/merge.js';
import { fixtureRepo, tmp } from './helpers.js';

const PR = 'https://example.test/pr/7';
const SHA = 'a'.repeat(40);
const config = { selfMergeTimeoutMinutes: 30 };

let bin;
let ghLog;
let ghState;
let oldPath;

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
  bin = tmp('keel-bin-');
  ghLog = join(bin, 'calls.jsonl');
  ghState = join(bin, 'state.json');
  writeFileSync(ghState, '{}');
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify(args) + '\\n');
const state = JSON.parse(fs.readFileSync(${JSON.stringify(ghState)}, 'utf8'));
if (args[0] === 'pr' && args[1] === 'view') console.log(JSON.stringify(state.pr));
if (args[0] === 'api') console.log('[]');
if (args[0] === 'pr' && args[1] === 'merge' && state.mergeExit) console.error('merge refused');
process.exit(args[0] === 'pr' && args[1] === 'merge' ? (state.mergeExit ?? 0) : 0);
`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
});

afterEach(() => {
  process.env.PATH = oldPath;
});

const setGh = (state) => writeFileSync(ghState, JSON.stringify(state));
const calls = () =>
  existsSync(ghLog)
    ? readFileSync(ghLog, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    : [];
const mergeCalls = () => calls().filter((args) => args[0] === 'pr' && args[1] === 'merge');

const pr = (mergeable) => ({
  state: 'OPEN',
  isDraft: false,
  headRefOid: SHA,
  mergeable,
  mergeStateStatus: 'UNKNOWN',
  statusCheckRollup: [
    { __typename: 'StatusContext', context: 'keel/gate', state: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'quality', status: 'COMPLETED', conclusion: 'SUCCESS' },
  ],
});

function pending(repo) {
  recordPollAttempt(repo, {
    issue: 'BUI-1631',
    outcome: 'self-merge',
    detail: { pr: PR, sha: SHA, since: new Date().toISOString() },
  });
}

function client() {
  const comments = [];
  return {
    comments,
    stateType: async () => 'completed',
    comment: async (issue, body) => comments.push({ issue, body }),
  };
}

test('REQ-MERGE-2 green checks and MERGEABLE attempt the certified merge when merge state is UNKNOWN', async () => {
  const repo = fixtureRepo().dir;
  pending(repo);
  setGh({ pr: pr('MERGEABLE') });

  const results = await finishSelfMerges({ repo, config, client: client(), log: () => {} });

  assert.deepEqual(mergeCalls(), [['pr', 'merge', PR, '--squash', '--match-head-commit', SHA]]);
  assert.ok(results.some((result) => result.outcome === 'merged'));
});

test('REQ-MERGE-2 UNKNOWN mergeability keeps an UNKNOWN merge state waiting', async () => {
  const repo = fixtureRepo().dir;
  pending(repo);
  setGh({ pr: pr('UNKNOWN') });
  const logs = [];

  const results = await finishSelfMerges({ repo, config, client: client(), log: (line) => logs.push(line) });

  assert.deepEqual(mergeCalls(), []);
  assert.deepEqual(results, []);
  assert.ok(
    logs.some((line) => line.includes('self-merge waits for merge state UNKNOWN')),
    logs.join('\n'),
  );
});

test('REQ-MERGE-3 a refused merge after UNKNOWN is reported as the gh pr merge failure', async () => {
  const repo = fixtureRepo().dir;
  pending(repo);
  setGh({ pr: pr('MERGEABLE'), mergeExit: 1 });
  const linear = client();

  const results = await finishSelfMerges({ repo, config, client: linear, log: () => {} });

  assert.equal(mergeCalls().length, 1);
  assert.match(results.find((result) => result.outcome === 'mergeFailed')?.detail ?? '', /gh pr merge failed: merge refused/);
  assert.match(linear.comments[0].body, /keel: not merged: gh pr merge failed: merge refused/);
  assert.ok(
    readJsonl(pollLedgerFile()).some(
      (row) => row.outcome === 'self-merge-failed' && /gh pr merge failed: merge refused/.test(row.detail.reason),
    ),
  );
});
