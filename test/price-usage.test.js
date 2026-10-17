import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { report } from '../src/ledger.js';
import { priceUsage, runWorker } from '../src/workers.js';
import { formatValue, value } from '../src/value.js';
import { fixtureConfig, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

const PRICED = { provider: 'exec', model: 'm', effort: 'high', priceInPerM: 4, priceOutPerM: 20, priceCachedPerM: 0.4 };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test('REQ-LED-12 usage is priced from the tier: input, cache writes at 1.25x input, cache reads, and output', () => {
  near(priceUsage(PRICED, { in: 1_000_000, cacheWrite: 1_000_000, out: 100_000, cached: 1_000_000 }), 4 + 5 + 2 + 0.4);
  assert.equal(priceUsage({ ...PRICED, priceCachedPerM: undefined }, { in: 1, out: 1, cached: 5 }), null, 'cache reads need a cache price');
  near(priceUsage({ ...PRICED, priceCachedPerM: undefined }, { in: 1_000_000, out: 0, cached: 0 }), 4);
  assert.equal(priceUsage({ provider: 'codex', model: 'x', effort: 'high' }, { in: 1, out: 1, cached: 0 }), null, 'no price, no number');
  assert.equal(priceUsage(PRICED, null), null, 'no usage, no price');
});

test('REQ-LED-12 a worker that reports usage but no cost is priced from its tier', () => {
  const print = 'console.log(JSON.stringify({ usage: { input_tokens: 1000000, output_tokens: 100000 } }))';
  const config = fixtureConfig({});
  const w = runWorker({ ...PRICED, command: ['node', '-e', print] }, 'p', tmp('keel-w-'), config);
  assert.equal(w.status, 'ok');
  near(w.cost, 4 + 2);
  const unpriced = runWorker({ provider: 'exec', model: 'm', effort: 'high', command: ['node', '-e', print] }, 'p', tmp('keel-w-'), config);
  assert.equal(unpriced.cost, null, 'a tier without prices leaves the cost null, never zero');
});

test('REQ-LED-12 the default tiers carry list prices for every model', () => {
  const prices = DEFAULTS.tiers.map((t) => [t.model, t.priceInPerM, t.priceCachedPerM, t.priceOutPerM]);
  assert.deepEqual(prices, [
    ['claude-sonnet-5-5', 2, 0.1, 10],
    ['claude-opus-5-5', 4, 0.2, 20],
    ['gpt-5.6-sol', 4, 0.4, 20],
  ]);
});

test('REQ-LED-12 the report prices an older Codex row by its model, and counts a row with no usage as unpriced', () => {
  const row = (over) => ({ run: 'r1', card: 'A-1', attempt: 1, tier: 2, attemptPass: true, durationMs: 1, ...over });
  const codex = row({ provider: 'codex', model: 'gpt-5.6-sol', cost: null, usage: { in: 1_000_000, out: 100_000, cached: 1_000_000 } });
  const r = report([codex]);
  near(r.totalCost, 4 + 2 + 0.4);
  assert.equal(r.unpriced, 0);
  const timeout = row({
    run: 'r2',
    card: 'B-1',
    provider: 'claude',
    model: 'claude-sonnet-5-5',
    cost: null,
    usage: null,
    attemptPass: false,
  });
  const r2 = report([codex, timeout]);
  assert.equal(r2.unpriced, 1, 'a Claude timeout with no result stays unpriced');
  assert.match(formatValue(value([codex, timeout])), /^ {2}Not priced: 1 attempt with no usage \(a timeout before any result\)$/m);
});
