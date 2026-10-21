import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { formatRecurring, recurring } from '../src/recur.js';
import { tmp } from './helpers.js';

const KEEL = fileURLToPath(new URL('../bin/keel.js', import.meta.url));
const NOW = new Date('2026-10-21T12:00:00Z');
const daysAgo = (d) => new Date(NOW.getTime() - d * 86400000).toISOString();
let n = 0;
const head = () => (n++).toString(16).padStart(40, '0');

/** A receipt that failed `stage` with `rules` (none for a command that only exited non-zero). */
const receipt = (card, at, stage, rules = [], extra = {}) => ({
  version: 3,
  card,
  head: head(),
  base: '0'.repeat(40),
  pass: false,
  at,
  results: [
    { name: 'lint', pass: true, problems: [] },
    { name: stage, pass: false, problems: rules.map((rule) => ({ rule })), ...extra },
  ],
});
const passed = (card, at) => ({ version: 3, card, head: head(), pass: true, at, results: [{ name: 'test', pass: true, problems: [] }] });

let dir;
beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
  dir = join(process.env.KEEL_STATE_DIR, 'receipts');
  mkdirSync(dir, { recursive: true });
});
const write = (rs) => rs.forEach((r, i) => writeFileSync(join(dir, `${r.card}-${r.head}-${i}.json`), JSON.stringify(r)));

test('REQ-LED-20 a failure class that failed 3 or more gates of 2 or more cards in the window is listed, most cards first', () => {
  const rows = [
    receipt('A', daysAgo(1), 'locked', ['existing-test-changed']),
    receipt('B', daysAgo(2), 'locked', ['existing-test-changed']),
    receipt('C', daysAgo(3), 'locked', ['existing-test-changed']),
    receipt('A', daysAgo(1), 'lint'),
    receipt('B', daysAgo(1), 'lint'),
    receipt('B', daysAgo(2), 'lint'),
    // one card failing again and again is that card's problem, not a recurring class
    receipt('D', daysAgo(1), 'scope', ['out-of-scope']),
    receipt('D', daysAgo(2), 'scope', ['out-of-scope']),
    receipt('D', daysAgo(3), 'scope', ['out-of-scope']),
    passed('E', daysAgo(1)),
  ];
  const out = recurring(rows, { days: 14, now: NOW });
  assert.deepEqual(
    out.map((c) => [c.cls, c.gates, c.cards]),
    [
      ['locked existing-test-changed', 3, 3],
      ['lint', 3, 2],
    ],
  );
});

test('REQ-LED-20 each class shows its count in the window before, so a prevention shows as a fall', () => {
  const rows = [
    ...['A', 'B', 'C'].map((c) => receipt(c, daysAgo(2), 'red-proof', ['test-passes-on-base'])),
    ...['D', 'E', 'F', 'G', 'H'].map((c) => receipt(c, daysAgo(20), 'red-proof', ['test-passes-on-base'])),
    receipt('I', daysAgo(40), 'red-proof', ['test-passes-on-base']), // outside both windows
  ];
  const [c] = recurring(rows, { days: 14, now: NOW });
  assert.equal(c.gates, 3);
  assert.equal(c.before, 5);
  const text = formatRecurring([c], 14);
  assert.match(text, /red-proof test-passes-on-base: 3 gates, 3 cards \(previous 14 days: 5\)/);
});

test('REQ-LED-20 a review that found no reviewer is classed by why each reviewer was out', () => {
  const out = (statuses) => ({ unavailable: statuses.map((status, i) => ({ reviewer: `r${i}`, status })) });
  const rows = ['A', 'B', 'C'].map((c) => receipt(c, daysAgo(1), 'review', ['review-unavailable'], out(['quota', 'auth', 'auth'])));
  assert.equal(recurring(rows, { days: 14, now: NOW })[0].cls, 'review review-unavailable auth+quota');
});

test('REQ-LED-20 the report ends with the prevention prompt, and says so when nothing recurs', () => {
  const rows = ['A', 'B', 'C'].map((c) => receipt(c, daysAgo(1), 'lint'));
  const text = formatRecurring(recurring(rows, { days: 14, now: NOW }), 14);
  assert.match(text, /^Recurring failures \(last 14 days\)/);
  assert.match(text, /Root cause/);
  assert.match(text, /Prevention/);
  assert.match(formatRecurring([], 14), /none recurred/);
});

test('REQ-LED-20 keel report --recur reads the receipts in the state dir and skips a file that is not a receipt', () => {
  const at = new Date(Date.now() - 86400000).toISOString();
  write(['A', 'B', 'C'].map((c) => receipt(c, at, 'locked', ['verification-file-changed'])));
  writeFileSync(join(dir, 'junk.json'), 'not json');
  const out = execFileSync('node', [KEEL, 'report', '--recur'], { encoding: 'utf8', env: { ...process.env } });
  assert.match(out, /Recurring failures \(last 14 days\)/);
  assert.match(out, /locked verification-file-changed: 3 gates, 3 cards/);
});
