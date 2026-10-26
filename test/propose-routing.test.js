import assert from 'node:assert/strict';
import { test } from 'node:test';
import { learnedStart } from '../src/run.js';
import { fixtureConfig } from './helpers.js';

const REPO = '/repo/a';
const config = fixtureConfig({ tiers: fixtureConfig().tiers });

test('REQ-PROPOSE-4 propose turns are not attempts of a tier, so they never move the learned start tier', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) {
    const run = `r${i}`;
    rows.push({ run, repo: REPO, attempt: 1, tier: 0, cost: 0.37, attemptPass: i < 2, at: `2026-10-01T00:${10 + i}:00Z` });
    if (i >= 2) rows.push({ run, repo: REPO, attempt: 2, tier: 1, cost: 0.32, attemptPass: true, at: `2026-10-01T00:${10 + i}:30Z` });
  }
  assert.equal(learnedStart(rows, REPO, 0, config).tier, 1, 'without propose rows the cheap tier does not pay');
  // Costly propose turns on tier 1 would raise its mean attempt cost and make tier 0 look like it pays.
  const proposes = Array.from({ length: 20 }, (_, i) => ({
    run: `propose-${i}`,
    repo: REPO,
    role: 'propose',
    attempt: 0,
    tier: 1,
    cost: 5,
    attemptPass: false,
    at: `2026-10-02T00:${10 + i}:00Z`,
  }));
  assert.equal(learnedStart([...rows, ...proposes], REPO, 0, config).tier, 1);
});
