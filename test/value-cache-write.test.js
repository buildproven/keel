import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routedCost } from '../src/value.js';

const TIERS = [
  { provider: 'claude', model: 'cheap', effort: 'low', priceInPerM: 3, priceOutPerM: 15, priceCachedPerM: 0.3 },
  { provider: 'claude', model: 'top', effort: 'high', priceInPerM: 15, priceOutPerM: 75, priceCachedPerM: 1.5 },
];

test('REQ-LED-9 the estimate prices cache writes at 1.25x the input price', () => {
  // Claude bills cache_creation_input_tokens at 1.25x input; an all-top-tier history must estimate its routed cost.
  const usage = { in: 100_000, cacheWrite: 1_000_000, out: 20_000, cached: 0 };
  const cost = (100_000 * 15 + 1_000_000 * 15 * 1.25 + 20_000 * 75) / 1e6;
  const row = { run: 'r1', repo: '/r/a', tier: 1, cost, usage, attemptPass: true, at: new Date().toISOString() };
  const [r] = routedCost([row], () => ({ tiers: TIERS }));
  assert.ok(Math.abs(r.top - r.routed) < 1e-9, `top ${r.top} equals routed ${r.routed}`);
});
