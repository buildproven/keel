import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { formatTouch, githubPrs, humanTouch } from '../src/autonomy.js';
import { formatValue, value } from '../src/value.js';
import { tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

const REPO = '/r/a';
const poll = (issue, outcome, detail = null) => ({ repo: REPO, issue, outcome, detail, at: '2026-10-10T00:00:00Z' });
const pass = (card, head) => ({ repo: REPO, run: card, card, attempt: 1, attemptPass: true, head, workerStatus: 'ok' });
const pr = (id, headOid, state = 'MERGED', authors = []) => ({ head: `keel/${id}`, headOid, state, authors });
const BOT = { type: 'Bot', login: 'linear' };
const USER = { type: 'User', login: 'someone' };

test('REQ-LED-14 an issue Keel built and merged with no human step is untouched', () => {
  const t = humanTouch({
    pollRows: [poll('B-1', 'found'), poll('B-1', 'autoMerge'), poll('B-2', 'filed')],
    ledgerRows: [pass('B-1', 'h1')],
    prsFor: () => [pr('B-1', 'h1', 'MERGED', [BOT])],
  });
  assert.equal(t.issues, 1, 'found and filed rows are not runs');
  assert.equal(t.touched, 0);
  assert.match(formatTouch(t), /^Human touch rate: 0% \(0 of 1 issues; target under 5%\)$/m);
});

test('REQ-LED-14 each human step touches the issue, and the reasons are counted', () => {
  const pollRows = [
    poll('C-1', 'blocked'),
    poll('C-2', 'blocked'),
    poll('C-2', 'autoMerge', 'explicit --issue retry'),
    poll('C-3', 'inReview'),
    poll('C-4', 'autoMerge'),
    poll('C-5', 'autoMerge'),
    poll('C-6', 'autoMerge'),
    poll('C-7', 'autoMerge'),
    poll('C-8', 'deferred'),
    poll('C-9', 'autoMerge'),
  ];
  const ledgerRows = ['C-2', 'C-4', 'C-5', 'C-6', 'C-7', 'C-9'].map((id) => pass(id, `${id}-h`));
  const prs = [
    pr('C-2', 'C-2-h'),
    pr('C-4', 'later-commit'), // someone pushed after the gate certified C-4-h
    pr('C-5', 'C-5-h', 'MERGED', [BOT, USER]),
    pr('C-6', 'C-6-h', 'OPEN'),
    pr('C-7', 'C-7-h', 'CLOSED'),
    pr('C-9', 'C-9-h'),
  ];
  const t = humanTouch({ pollRows, ledgerRows, prsFor: () => prs });
  assert.equal(t.issues, 7, 'C-6 is pending (PR open) and C-8 only deferred');
  assert.equal(t.touched, 6);
  assert.equal(t.pending, 1);
  assert.deepEqual(t.reasons, {
    'stopped for a human': 1,
    'retried by hand': 1,
    'merged by a human': 1,
    'commit after the gate': 1,
    'human review or comment': 1,
    'closed without a merge': 1,
  });
  const text = formatTouch(t);
  assert.match(text, /^Human touch rate: 86% \(6 of 7 issues; target under 5%\)$/m);
  assert.match(
    text,
    /^ {2}Why: stopped for a human 1, retried by hand 1, merged by a human 1, commit after the gate 1, human review or comment 1, closed without a merge 1$/m,
  );
  assert.match(text, /^ {2}Waiting to merge: 1 issue$/m);
});

test('REQ-LED-14 runs that stopped for a human are counted: builder blocked, login, and decisions', () => {
  // Counted by polled issue since REQ-LED-16: each run names its card and repo.
  const ledgerRows = [
    { repo: REPO, card: 'D-2', run: 'a', attempt: 1, workerStatus: 'error' },
    { repo: REPO, card: 'D-2', run: 'a', attempt: 2, workerStatus: 'blocked' },
    { repo: REPO, card: 'D-3', run: 'b', attempt: 1, workerStatus: 'blocked' },
    { repo: REPO, card: 'D-3', run: 'b', attempt: 1, workerStatus: 'approved' }, // allowEdits approved: Keel went on, no human
    { repo: REPO, card: 'D-3', run: 'b', attempt: 1, workerStatus: 'ok' },
    { repo: REPO, card: 'D-4', run: 'c', attempt: 1, workerStatus: 'auth' },
  ];
  const pollRows = [poll('D-1', 'needsReview'), poll('D-2', 'blocked'), poll('D-3', 'inReview'), poll('D-4', 'failed')];
  const t = humanTouch({ pollRows, ledgerRows, prsFor: () => [] });
  assert.deepEqual(t.stops, { issues: 3, blocked: 1, auth: 1, decision: 1 });
  assert.match(formatTouch(t), /^ {2}Stops for a human: 3 issues \(builder blocked 1, login 1, decision 1\)$/m);
});

test('REQ-LED-14 a repo where gh fails says why, and its issues are unknown, never untouched', () => {
  const t = humanTouch({
    pollRows: [poll('E-1', 'autoMerge'), poll('E-2', 'blocked')],
    ledgerRows: [pass('E-1', 'h')],
    prsFor: () => {
      throw new Error('gh: not logged in');
    },
  });
  assert.equal(t.issues, 1, 'only the blocked issue is decided');
  assert.equal(t.touched, 1);
  assert.match(formatTouch(t), /^ {2}Unknown: 1 issue in \/r\/a \(gh: not logged in\)$/m);
});

test('REQ-LED-14 with no polled issue the rate is n/a', () => {
  assert.match(
    formatTouch(humanTouch({ pollRows: [], ledgerRows: [], prsFor: () => [] })),
    /^Human touch rate: n\/a \(no polled issue yet; target under 5%\)$/m,
  );
});

test('REQ-LED-14 GitHub authors are read with their GraphQL type, so a bot is told from a person', () => {
  const bin = tmp('keel-gh-');
  const page = {
    data: {
      repository: {
        pullRequests: {
          nodes: [
            {
              headRefName: 'keel/F-1',
              headRefOid: 'h1',
              state: 'MERGED',
              comments: { nodes: [{ author: { __typename: 'Bot', login: 'linear' } }] },
              reviews: { nodes: [{ author: { __typename: 'User', login: 'brett' } }, { author: null }] },
            },
          ],
        },
      },
    },
  };
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nif [ "$1" = repo ]; then echo o/r; else cat <<'EOF'\n${JSON.stringify([page])}\nEOF\nfi\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const dir = tmp('keel-repo-');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const PATH = process.env.PATH;
  process.env.PATH = `${bin}:${PATH}`;
  try {
    assert.deepEqual(githubPrs(dir), [
      {
        head: 'keel/F-1',
        headOid: 'h1',
        state: 'MERGED',
        authors: [
          { type: 'Bot', login: 'linear' },
          { type: 'User', login: 'brett' },
          { type: 'unknown', login: null },
        ],
      },
    ]);
  } finally {
    process.env.PATH = PATH;
  }
});

test('REQ-LED-14 keel report --value prints the human touch rate from the poll ledger', () => {
  const text = formatValue(value([]));
  assert.match(text, /^Human touch rate: n\/a \(no polled issue yet; target under 5%\)$/m);
});
