import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatReport, report } from '../src/ledger.js';

const attempt = (over = {}) => ({
  run: 'r1',
  card: 'A-1',
  attempt: 1,
  tier: 0,
  attemptPass: true,
  usage: { in: 1000, out: 500, cached: 0 },
  cost: 0.25,
  durationMs: 1000,
  gateMs: 0,
  ...over,
});

test('REQ-LED-4 a run sums its cost and totals count failed runs', () => {
  const rows = [
    attempt({ run: 'r1', attemptPass: true, cost: 0.25 }),
    attempt({ run: 'r2', card: 'B-1', attemptPass: false, cost: 1 }),
    attempt({ run: 'r2', card: 'B-1', attempt: 2, attemptPass: false, cost: 0.5 }),
  ];
  const rep = report(rows);
  assert.deepEqual(
    rep.cards.map((c) => c.cost),
    [0.25, 1.5],
  );
  assert.equal(rep.accepted, 1);
  assert.equal(rep.totalCost, 1.75);
  assert.equal(rep.costPerAccepted, 1.75);
  assert.equal(rep.tokensPerAccepted, 4500);
});

test('REQ-LED-4 the report prints cost per run and a per-accepted footer', () => {
  const out = formatReport(report([attempt({ cost: 0.25 }), attempt({ run: 'r2', card: 'B-1', attemptPass: false, cost: 1 })]));
  assert.match(out, /A-1 +attempts=1 passTier=0 tokens=1500 cached=0 time=1s cost=\$0\.25/);
  assert.match(out, /B-1 +attempts=1 passTier=FAIL .* cost=\$1\.00/);
  assert.match(out, /passed 1\/2; passed on tier 0: 50%/);
  assert.match(out, /accepted 1; tokens per accepted: 3000; cost per accepted: \$1\.25/);
});

test('REQ-LED-4 an unpriced attempt makes the run n/a and the footer a lower bound', () => {
  const rows = [attempt({ cost: 0.5 }), attempt({ run: 'r2', card: 'C-1', cost: null, usage: null, attemptPass: true })];
  const out = formatReport(report(rows));
  assert.match(out, /C-1 .* cost=n\/a/);
  assert.match(out, /cost per accepted: ≥\$0\.25 \(1 attempt unpriced\)/);
});

test('REQ-LED-4 with no accepted card the per-accepted figures are n/a', () => {
  const out = formatReport(report([attempt({ attemptPass: false, cost: 2 })]));
  assert.match(out, /accepted 0; tokens per accepted: n\/a; cost per accepted: n\/a/);
});

test('REQ-LED-5 the report gives median time per accepted card and median gate time per attempt', () => {
  const rows = [
    attempt({ run: 'r1', durationMs: 60000, gateMs: 10000 }),
    attempt({ run: 'r2', card: 'B-1', durationMs: 120000, gateMs: 20000 }),
    attempt({ run: 'r3', card: 'C-1', durationMs: 600000, gateMs: 30000 }),
    attempt({ run: 'r4', card: 'D-1', attemptPass: false, durationMs: 900000, gateMs: 50000 }),
  ];
  const rep = report(rows);
  assert.equal(rep.medianAcceptedMs, 140000); // worker + gate per accepted run: 70s, 140s, 630s
  assert.equal(rep.medianGateMs, 25000);
  const out = formatReport(rep);
  assert.match(out, /median time per accepted card: 2m; median gate: 25s/);
});

test('REQ-LED-5 with no accepted card or gate time the medians are n/a', () => {
  const rep = report([attempt({ attemptPass: false, gateMs: undefined })]);
  assert.equal(rep.medianAcceptedMs, null);
  assert.equal(rep.medianGateMs, null);
  assert.match(formatReport(rep), /median time per accepted card: n\/a; median gate: n\/a/);
});
