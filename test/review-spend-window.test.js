import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { withReviewUsage } from '../src/value.js';
import { tmp } from './helpers.js';

let receipts;
beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
  receipts = join(process.env.KEEL_STATE_DIR, 'receipts');
  mkdirSync(receipts, { recursive: true });
});

const receipt = (ms, usage) =>
  writeFileSync(
    join(receipts, `A-1-abc-${ms}.json`),
    JSON.stringify({ card: 'A-1', head: 'abc', results: [{ name: 'review', usage, reviewer: 'codex/gpt-5.6-sol/high' }] }),
  );
const row = (at, gateMs, over) => ({
  run: 'r1',
  card: 'A-1',
  attempt: 1,
  tier: 0,
  attemptPass: true,
  head: 'abc',
  gateMs,
  reviewer: 'codex/gpt-5.6-sol/high',
  reviewCost: null,
  at: new Date(at).toISOString(),
  ...over,
});

test('REQ-LED-13 a hand gate of the same card and head shortly before the attempt is not charged to it', () => {
  const at = Date.parse('2026-10-10T12:00:00Z');
  const gateMs = 120_000;
  receipt(at - gateMs - 30_000, { in: 9999, out: 0, cached: 0 }); // keel gate by hand, 30 s before the attempt's gate
  receipt(at - 1_000, { in: 200, out: 20, cached: 5 }); // the attempt's own gate
  const [filled] = withReviewUsage([row(at, gateMs)]);
  assert.deepEqual(filled.reviewUsage, { in: 200, out: 20, cached: 5 });
});

test('REQ-LED-13 a receipt that only a hand gate before the attempt wrote leaves the row without review usage', () => {
  const at = Date.parse('2026-10-10T12:00:00Z');
  receipt(at - 60_000 - 1, { in: 9999, out: 0, cached: 0 });
  const [kept] = withReviewUsage([row(at, 60_000)]);
  assert.equal(kept.reviewUsage, undefined);
});

test('REQ-LED-13 two attempts gating the same head are each charged only their own receipts', () => {
  const first = Date.parse('2026-10-10T12:00:00Z');
  receipt(first - 5_000, { in: 100, out: 10, cached: 0 }); // attempt 1's gate
  const second = first + 20_000 + 40_000; // attempt 2's gate starts 20 s after attempt 1's row and takes 40 s
  receipt(second - 2_000, { in: 300, out: 30, cached: 0 }); // attempt 2's gate
  const [a, b] = withReviewUsage([row(first, 50_000), row(second, 40_000, { attempt: 2 })]);
  assert.deepEqual(a.reviewUsage, { in: 100, out: 10, cached: 0 });
  assert.deepEqual(b.reviewUsage, { in: 300, out: 30, cached: 0 });
});
