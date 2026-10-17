import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { formatTouch, humanTouch } from '../src/autonomy.js';
import { formatValue, value } from '../src/value.js';
import { tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-autonomy-state-');
});

const REPO = '/r/a';
const NOW = new Date('2026-10-14T12:00:00Z');
const row = (issue, outcome, at = '2026-10-10T00:00:00Z', detail = null) => ({ repo: REPO, issue, outcome, detail, at });
const byHand = (issue, outcome, at) => row(issue, outcome, at, 'explicit --issue retry');
const pass = (card, head) => ({ repo: REPO, run: card, card, attempt: 1, attemptPass: true, head, workerStatus: 'ok' });
const merged = (id, headOid) => ({ head: `keel/${id}`, headOid, state: 'MERGED', authors: [] });

test('REQ-LED-16 a first run started by hand that merges clean is a human start, not a touch; a later --issue run is a retry', () => {
  const t = humanTouch({
    pollRows: [
      byHand('S-1', 'autoMerge'), // started by hand, merged clean
      row('S-2', 'deferred'),
      byHand('S-2', 'autoMerge'), // a deferral is not a run: still a first run by hand
      byHand('S-3', 'blocked'), // started by hand, then stopped
      row('S-4', 'blocked'),
      byHand('S-4', 'autoMerge'), // retried after a stop
    ],
    ledgerRows: [pass('S-1', 'h1'), pass('S-2', 'h2'), pass('S-4', 'h4')],
    prsFor: () => [merged('S-1', 'h1'), merged('S-2', 'h2'), merged('S-4', 'h4')],
    windowDays: 30,
    now: NOW,
  });
  assert.equal(t.issues, 4);
  assert.equal(t.touched, 2);
  assert.deepEqual(t.reasons, { 'stopped for a human': 1, 'retried by hand': 1 });
  assert.deepEqual(t.started, { issues: 3, clean: 2 });
  const text = formatTouch(t);
  assert.match(text, /^Human touch rate: 50% \(2 of 4 issues; target under 5%\)$/m);
  assert.match(text, /^ {2}Started by hand: 3 issues \(2 merged with no other human step\)$/m);
});

test('REQ-LED-16 stops for a human are counted by issue, among polled issues only', () => {
  const ledgerRows = [
    { repo: REPO, run: 'r1', card: 'P-1', attempt: 1, workerStatus: 'blocked' },
    { repo: REPO, run: 'r2', card: 'P-1', attempt: 1, workerStatus: 'blocked' }, // same issue, second run
    { repo: REPO, run: 'r3', card: 'P-2', attempt: 1, workerStatus: 'error' },
    { repo: REPO, run: 'r3', card: 'P-2', attempt: 2, workerStatus: 'auth' },
    { repo: REPO, run: 'r4', card: 'DEP-1', attempt: 1, workerStatus: 'blocked' }, // a hand-written card, never polled
    { repo: REPO, run: 'r5', card: 'P-4', attempt: 1, workerStatus: 'blocked' },
    { repo: REPO, run: 'r5', card: 'P-4', attempt: 1, workerStatus: 'approved' }, // allowEdits approved: no human
    { repo: REPO, run: 'r5', card: 'P-4', attempt: 1, workerStatus: 'ok' },
  ];
  const t = humanTouch({
    pollRows: [row('P-1', 'blocked'), row('P-1', 'blocked'), row('P-2', 'failed'), row('P-3', 'needsReview'), row('P-4', 'inReview')],
    ledgerRows,
    prsFor: () => [],
    windowDays: 30,
    now: NOW,
  });
  assert.deepEqual(t.stops, { issues: 3, blocked: 1, auth: 1, decision: 1 });
  assert.match(formatTouch(t), /^ {2}Stops for a human: 3 issues \(builder blocked 1, login 1, decision 1\)$/m);
});

test('REQ-LED-16 legacy outcomes are left out: closed rows, and inReview before --merge existed', () => {
  const t = humanTouch({
    pollRows: [
      row('L-1', 'closed', '2026-10-01T00:00:00Z'),
      row('L-2', 'inReview', '2026-10-05T23:00:00Z'),
      row('L-3', 'inReview', '2026-10-06T01:00:00Z'),
    ],
    ledgerRows: [],
    prsFor: () => [],
    windowDays: 30,
    now: NOW,
  });
  assert.equal(t.issues, 1);
  assert.deepEqual(t.reasons, { 'merged by a human': 1 });
});

test('REQ-LED-16 only issues whose latest poll row is in the window count, and the window is printed', () => {
  const t = humanTouch({
    pollRows: [
      row('W-1', 'blocked', '2026-09-01T00:00:00Z'),
      row('W-2', 'blocked', '2026-09-01T00:00:00Z'),
      byHand('W-2', 'failed', '2026-10-13T00:00:00Z'),
    ],
    ledgerRows: [],
    prsFor: () => [],
    windowDays: 30,
    now: NOW,
  });
  assert.equal(t.issues, 1, 'W-1 ended before the window');
  assert.deepEqual(t.reasons, { 'retried by hand': 1 }, 'an in-window issue keeps its earlier rows');
  assert.match(formatTouch(t), /^ {2}Window: last 30 days \(since 2026-09-14\)$/m);
});

test('REQ-LED-16 not-keel issues are left out and counted; an issue Keel proved already done is untouched', () => {
  const t = humanTouch({
    pollRows: [row('N-1', 'notKeel'), row('N-2', 'alreadyDone')],
    ledgerRows: [],
    prsFor: () => [],
    windowDays: 30,
    now: NOW,
  });
  assert.equal(t.issues, 1);
  assert.equal(t.touched, 0);
  assert.equal(t.notKeel, 1);
  assert.match(formatTouch(t), /^ {2}Not keel work: 1 issue$/m);
});

test('REQ-LED-16 keel report --value uses a 30-day window by default and prints it', () => {
  const text = formatValue(value([]));
  assert.match(text, /^ {2}Window: last 30 days \(since \d{4}-\d{2}-\d{2}\)$/m);
});

test('REQ-LED-16 a stale follow-up row is not a run: it neither adds an issue nor moves one', () => {
  const t = humanTouch({
    pollRows: [row(null, 'stale'), row('Z-1', 'deferred'), row('Z-1', 'stale', '2026-10-13T00:00:00Z')],
    ledgerRows: [],
    prsFor: () => [],
    windowDays: 30,
    now: NOW,
  });
  assert.equal(t.issues, 0);
  assert.equal(t.touched, 0);
});

test('REQ-LED-16 self-merge bookkeeping rows are not runs; a failed self-merge is a stop for a human', () => {
  const t = humanTouch({
    pollRows: [
      row('M-1', 'selfMerge'),
      row('M-1', 'self-merge'),
      row('M-1', 'self-merged'),
      row('M-2', 'selfMerge'),
      row('M-2', 'self-merge'),
      row('M-2', 'self-merge-failed'),
    ],
    ledgerRows: [pass('M-1', 'm1'), pass('M-2', 'm2')],
    prsFor: () => [merged('M-1', 'm1'), { head: 'keel/M-2', headOid: 'm2', state: 'OPEN', authors: [] }],
    windowDays: 30,
    now: NOW,
  });
  assert.equal(t.issues, 2);
  assert.equal(t.touched, 1);
  assert.deepEqual(t.reasons, { 'stopped for a human': 1 });
});
