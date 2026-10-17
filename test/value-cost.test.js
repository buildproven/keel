import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { appendAttempt } from '../src/ledger.js';
import { formatValue, routedCost, value } from '../src/value.js';
import { commit, fixtureRepo, tmp } from './helpers.js';

const KEEL = fileURLToPath(new URL('../bin/keel.js', import.meta.url));

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

const TIERS = [
  { provider: 'claude', model: 'cheap', effort: 'low', priceInPerM: 3, priceOutPerM: 15, priceCachedPerM: 0.3 },
  { provider: 'claude', model: 'top', effort: 'high', priceInPerM: 15, priceOutPerM: 75, priceCachedPerM: 1.5 },
];
const run = (over) => ({
  run: 'r1',
  repo: '/r/a',
  tier: 0,
  cost: 0.5,
  usage: { in: 1_000_000, out: 100_000, cached: 5 },
  attemptPass: true,
  at: new Date().toISOString(),
  ...over,
});
const withTiers = (tiers) => () => ({ tiers });

test('REQ-LED-9 sums the routed cost and prices the same tokens at the top tier, labelled estimate', () => {
  const rows = [run({}), run({ attempt: 2, cost: 0.25, usage: { in: 2_000_000, out: 0, cached: 0 } })];
  const [r] = routedCost(rows, withTiers(TIERS));
  assert.equal(r.repo, '/r/a');
  assert.equal(r.routed, 0.75);
  assert.ok(Math.abs(r.top - (3 * 15 + 5e-6 * 1.5 + 0.1 * 75)) < 1e-9, '3M in at $15 + 5 cached at $1.5 + 0.1M out at $75');
  assert.ok(!r.incomplete);
  const text = formatValue({ ...value([]), routing: [r] });
  assert.match(text, /\/r\/a: routed \$0\.75; top tier \(estimate\) \$52\.50$/m);
});

test('REQ-LED-9 the estimate prices cache reads too, so all-top-tier attempts estimate their routed cost', () => {
  // Claude's total_cost_usd includes cache reads; the estimate must cover the same tokens.
  const usage = { in: 100_000, out: 20_000, cached: 4_000_000 };
  const cost = (100_000 * 15 + 20_000 * 75 + 4_000_000 * 1.5) / 1e6;
  const [r] = routedCost([run({ tier: 1, cost, usage })], withTiers(TIERS));
  assert.ok(Math.abs(r.top - r.routed) < 1e-9, `top ${r.top} equals routed ${r.routed}`);
});

test('REQ-LED-9 cache reads without a top-tier cache price print n/a, not a low number', () => {
  const top = { provider: 'claude', model: 'top', effort: 'high', priceInPerM: 15, priceOutPerM: 75 };
  const [r] = routedCost([run({})], withTiers([TIERS[0], top]));
  assert.equal(r.top, null);
  assert.match(formatValue({ ...value([]), routing: [r] }), /top tier \(estimate\) n\/a \(top tier has no priceCachedPerM/m);
  const [none] = routedCost([run({ usage: { in: 1_000_000, out: 0, cached: 0 } })], withTiers([TIERS[0], top]));
  assert.equal(none.top, 15, 'no cache reads need no cache price');
});

test('REQ-LED-9 a top tier without prices prints n/a, never $0.00', () => {
  const [r] = routedCost([run({})], withTiers([TIERS[0], { provider: 'claude', model: 'top', effort: 'high' }]));
  assert.equal(r.top, null);
  const text = formatValue({ ...value([]), routing: [r] });
  assert.match(text, /top tier \(estimate\) n\/a \(top tier has no priceInPerM/m);
  assert.doesNotMatch(text, /\$0\.00/);
});

test('REQ-LED-9 an attempt with no usage makes the top-tier estimate a lower bound', () => {
  const [r] = routedCost([run({}), run({ attempt: 2, usage: null })], withTiers(TIERS));
  assert.equal(r.incomplete, true);
  assert.match(formatValue({ ...value([]), routing: [r] }), /top tier \(estimate\) ≥\$/);
});

test('REQ-LED-9 a repo whose keel.json cannot be read says why instead of a number', () => {
  const [r] = routedCost([run({ repo: '/no/such/repo' })], () => {
    throw new Error('keel.json: unreadable');
  });
  assert.equal(r.top, null);
  assert.match(
    formatValue({ ...value([]), routing: [r] }),
    /\/no\/such\/repo: routed \$0\.50; top tier \(estimate\) n\/a \(keel\.json: unreadable\)$/m,
  );
});

test('REQ-LED-9 tier prices must be non-negative numbers', () => {
  const { dir } = fixtureRepo();
  const cfg = (tier) => commit(dir, { 'keel.json': JSON.stringify({ checks: { t: 'true' }, testCommand: 'true', tiers: [tier] }) }, 'cfg');
  const ok = cfg({ provider: 'claude', model: 'm', effort: 'low', priceInPerM: 3, priceOutPerM: 15 });
  assert.equal(loadConfig(dir, ok).tiers[0].priceInPerM, 3);
  const bad = cfg({ provider: 'claude', model: 'm', effort: 'low', priceInPerM: -1 });
  assert.throws(() => loadConfig(dir, bad), /priceInPerM/);
  const text = cfg({ provider: 'claude', model: 'm', effort: 'low', priceOutPerM: 'free' });
  assert.throws(() => loadConfig(dir, text), /priceOutPerM/);
  const cached = cfg({ provider: 'claude', model: 'm', effort: 'low', priceCachedPerM: -0.1 });
  assert.throws(() => loadConfig(dir, cached), /priceCachedPerM/);
});

test('REQ-LED-9 keel report --value prints the routed and top-tier cost per repo', () => {
  const { dir } = fixtureRepo();
  commit(
    dir,
    { 'keel.json': JSON.stringify({ checks: { t: 'true' }, testCommand: 'true', tiers: TIERS.slice(0, 1).concat(TIERS[1]) }) },
    'cfg',
  );
  appendAttempt({ ...run({ repo: dir, card: 'c1' }), workerStatus: 'ok', gatePass: true, durationMs: 1 });
  const out = execFileSync('node', [KEEL, 'report', '--value'], { encoding: 'utf8', env: { ...process.env }, cwd: dir });
  assert.match(out, new RegExp(`${dir}: routed \\$0\\.50; top tier \\(estimate\\) \\$22\\.50`));
});
