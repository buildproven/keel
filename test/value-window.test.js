import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { appendJsonl } from '../src/ledger.js';
import { value } from '../src/value.js';
import { tmp } from './helpers.js';

const KEEL = fileURLToPath(new URL('../bin/keel.js', import.meta.url));
const DAY_MS = 86400000;
const ago = (days) => new Date(Date.now() - days * DAY_MS).toISOString();

let state;
beforeEach(() => {
  state = tmp('keel-state-');
  process.env.KEEL_STATE_DIR = state;
});

const row = (over) => ({ attempt: 1, tier: 0, attemptPass: true, workerStatus: 'ok', durationMs: 1, repo: '/r/a', ...over });
const old = row({ run: 'r-old', card: 'OLD-1', cost: 1, usage: { in: 1000, out: 100, cached: 0 }, at: ago(40) });
const recent = row({ run: 'r-new', card: 'NEW-1', cost: 0.5, usage: { in: 2000, out: 200, cached: 0 }, at: ago(2) });
const oldTurns = [
  { ...row({ run: 'r-ref', card: 'OLD-2', attempt: 0, role: 'refine', outcome: 'card', cost: 0.2 }), at: ago(40) },
  { ...row({ run: 'r-old', card: 'OLD-1', role: 'fix-findings', findings: 'fixed', cost: 0.3 }), at: ago(40) },
];

function writeState() {
  for (const r of [old, ...oldTurns, recent]) appendJsonl(join(state, 'ledger.jsonl'), r);
  const gate = (at, ms) => ({ repo: '/r/a', card: 'C', head: 'h', pass: true, at, waitMs: 0, checks: { test: ms } });
  appendJsonl(join(state, 'gate-times.jsonl'), gate(ago(40), 600_000));
  appendJsonl(join(state, 'gate-times.jsonl'), gate(ago(2), 60_000));
}

const keel = (...args) =>
  spawnSync(process.execPath, [KEEL, ...args], { encoding: 'utf8', env: { ...process.env, KEEL_STATE_DIR: state } });

test('REQ-LED-19 spend and routing count only rows inside the window', () => {
  const v = value([old, recent], { prsFor: () => [] });
  assert.equal(v.spend.total, 1);
  assert.equal(v.spend.accepted, 1);
  assert.equal(v.spend.costPerAccepted, 0.5);
  assert.deepEqual(
    v.routing.map((r) => [r.repo, r.routed]),
    [['/r/a', 0.5]],
  );

  writeState();
  const out = keel('report', '--value');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^Finished cards: 1 of 1 \(100%\)$/m);
  assert.match(out.stdout, /^Cost per finished card: builder \$0\.50 \+ review \$0\.00 = \$0\.50$/m);
  assert.match(out.stdout, /^ {2}\/r\/a: routed \$0\.50;/m);
  assert.doesNotMatch(out.stdout, /refine turns:/);
  assert.doesNotMatch(out.stdout, /findings turns:/);
  assert.match(out.stdout, /^ {2}\/r\/a: test 60s \(1 of 1 gates\)$/m);
  assert.match(out.stdout, /^Window: last 30 days \(since \d{4}-\d{2}-\d{2}\)$/m);

  // Without --value the ledger summary stays all-time.
  const all = keel('report');
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /refine turns: 1/);
  assert.match(all.stdout, /test 5m30s \(2 of 2 gates\)/);
});

test('REQ-LED-19 --days sets the window', () => {
  const v = value([old, recent], { windowDays: 1, prsFor: () => [] });
  assert.equal(v.spend.total, 0);
  assert.deepEqual(v.routing, []);
  assert.equal(value([old, recent], { windowDays: 45, prsFor: () => [] }).spend.total, 2);

  writeState();
  const one = keel('report', '--value', '--days', '1');
  assert.equal(one.status, 0, one.stderr);
  assert.match(one.stdout, /^Finished cards: 0 of 0$/m);
  assert.match(one.stdout, /^slowest check per repo: no timed gates yet$/m);
  assert.match(one.stdout, /^ {2}Window: last 1 days/m);

  const wide = keel('report', '--value', '--days', '45');
  assert.equal(wide.status, 0, wide.stderr);
  assert.match(wide.stdout, /^Finished cards: 2 of 2 \(100%\)$/m);
  assert.match(wide.stdout, /refine turns: 1/);
  assert.match(wide.stdout, /^Window: last 45 days/m);
});

test('REQ-LED-19 --days rejects a non-integer', () => {
  for (const days of ['1.5', '0', '-3', 'abc', '', ' 7', '1e1', '0x5']) {
    const out = keel('report', '--value', `--days=${days}`);
    assert.equal(out.status, 2, `--days ${JSON.stringify(days)}: ${out.stderr}`);
    assert.match(out.stderr, /^keel: --days must be a positive integer$/m);
  }
  const noValue = keel('report', '--days', '7');
  assert.equal(noValue.status, 2, noValue.stderr);
  assert.match(noValue.stderr, /^keel: --days is an option of report --value only$/m);
});
