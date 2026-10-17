import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatReport, report } from '../src/ledger.js';

test('REQ-RUN-38 a findings turn whose re-gate review is unpriced makes the reported cost a lower bound', () => {
  const row = { run: 'r1', card: 'T-1', repo: '/x', tier: 0, attempt: 1, durationMs: 1, usage: null, role: 'fix-findings', cost: 0.1 };
  const text = formatReport(report([{ ...row, outcome: 'fixed', reviewer: 'exec/none/high', reviewUsage: null, reviewCost: null }]));
  assert.match(text, /findings turns: 1 \(fixed 1, unchanged 0, reverted 0\); cost ≥\$0\.10/);
});
