import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { FALLBACK } from '../src/audit.js';
import { DEFAULTS, loadConfig, parseCard } from '../src/config.js';
import { gate } from '../src/gate.js';
import { nextReset, reservedProviders } from '../src/plan.js';
import { learnedStart } from '../src/run.js';
import { FIXED_SRC, REGRESSION_TEST, commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

const card = () => parseCard('# T-1: test card\nkind: bug\nsize: S\n');
const tier = (family, model, script) => ({
  provider: 'exec',
  family,
  model,
  effort: 'high',
  command: ['node', '-e', `require('fs').readFileSync(0); ${script}`],
});
const codex = tier('codex', 'exec-codex', "console.log('VERDICT: pass')");
const claude = tier('claude', 'exec-claude', "console.log('VERDICT: pass')");
const review = (r) => r.results.find((x) => x.name === 'review');

test('REQ-RUN-52 learned routing never starts a card on a last-resort tier, however the costs compare', () => {
  const rows = [];
  for (let i = 0; i < 12; i++) {
    const at = new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString();
    rows.push({ run: `r${i}`, repo: '/r', attempt: 1, tier: 1, cost: 0.3, attemptPass: false, at });
    rows.push({ run: `r${i}`, repo: '/r', attempt: 2, tier: 2, cost: 0.5, attemptPass: true, at });
  }
  assert.equal(learnedStart(rows, '/r', 1, fixtureConfig({ lastResort: ['codex'] })).tier, 1);
  // With codex taken off the last-resort list, the same ledger climbs to it: the guard is the setting, not the data.
  assert.equal(learnedStart(rows, '/r', 1, fixtureConfig({ lastResort: [] })).tier, 2);
});

test('REQ-PLAN-7 a last-resort provider is reserved at lastResortLimits, others at planLimits', () => {
  const plan = {
    claude: { fiveHour: { used: 55, resetsAt: 1 }, week: { used: 55, resetsAt: 2 } },
    codex: { fiveHour: { used: 55, resetsAt: 3 }, week: { used: 10, resetsAt: 4 } },
  };
  const r = reservedProviders(plan, DEFAULTS.planLimits, DEFAULTS.lastResort, DEFAULTS.lastResortLimits);
  assert.deepEqual([...r.keys()], ['codex']);
  assert.match(r.get('codex'), /5h 55% ≥ 50%/);
  assert.ok(nextReset(plan, DEFAULTS.planLimits, DEFAULTS.lastResort, DEFAULTS.lastResortLimits));
  // An unknown window reserves nothing, last resort or not.
  assert.equal(reservedProviders({ codex: null }, DEFAULTS.planLimits, ['codex'], DEFAULTS.lastResortLimits).size, 0);
});

test('REQ-GATE-55 a routine diff is reviewed by the other tier first, and the receipt says so', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC });
  const r = gate({
    repo: dir,
    base,
    card: card(),
    config: fixtureConfig({ review: true, lastResort: ['codex'], tiers: [claude, codex] }),
    reviewer: codex,
  });
  assert.equal(r.pass, true, JSON.stringify(r.results));
  assert.equal(review(r).reviewer, 'exec/exec-claude/high');
  assert.deepEqual(review(r).fallback, { from: 'exec/exec-codex/high', status: 'routine diff' });
});

test('REQ-GATE-55 a diff under a risk path, or over maxLines, is reviewed by the last-resort family', () => {
  for (const [files, over] of [
    [{ ...REGRESSION_TEST, ...FIXED_SRC, 'src/auth-token.js': 'export const t = 1;\n' }, {}],
    [{ ...REGRESSION_TEST, ...FIXED_SRC }, { routineReview: { maxLines: 1, riskPaths: [] } }],
  ]) {
    const { dir, base } = fixtureRepo();
    commit(dir, files);
    const r = gate({
      repo: dir,
      base,
      card: card(),
      config: fixtureConfig({ review: true, lastResort: ['codex'], tiers: [claude, codex], ...over }),
      reviewer: codex,
    });
    assert.equal(review(r).reviewer, 'exec/exec-codex/high', JSON.stringify(review(r)));
    assert.equal(review(r).fallback, undefined);
  }
});

test('REQ-GATE-55 a binary change is never routine, since its size is unknown', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC, 'assets/logo.bin': 'GIF89a\0\0\0\0' });
  const r = gate({
    repo: dir,
    base,
    card: card(),
    config: fixtureConfig({ review: true, lastResort: ['codex'], tiers: [claude, codex] }),
    reviewer: codex,
  });
  assert.equal(review(r).reviewer, 'exec/exec-codex/high', JSON.stringify(review(r)));
  assert.equal(review(r).fallback, undefined);
});

test('REQ-GATE-55 a routine review is off when routineReview is null or reviewFallback is off', () => {
  for (const over of [{ routineReview: null }, { reviewFallback: false }]) {
    const { dir, base } = fixtureRepo();
    commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC });
    const r = gate({
      repo: dir,
      base,
      card: card(),
      config: fixtureConfig({ review: true, lastResort: ['codex'], tiers: [claude, codex], ...over }),
      reviewer: codex,
    });
    assert.equal(review(r).reviewer, 'exec/exec-codex/high');
  }
});

test('REQ-GATE-55 keel audit leaves a routine-diff review alone but still re-reviews an outage fallback', () => {
  assert.equal(FALLBACK.exec('passed; review by exec/exec-claude/high (fallback: exec/exec-codex/high routine diff)'), null);
  assert.equal(FALLBACK.exec('passed; review by x (fallback: exec/exec-codex/high quota)')?.[1], 'exec/exec-codex/high');
});

test('REQ-PLAN-7 lastResort, lastResortLimits and routineReview are validated when keel.json loads', () => {
  const load = (cfg) => {
    const { dir } = fixtureRepo();
    return loadConfig(dir, commit(dir, { 'keel.json': JSON.stringify({ checks: { test: 'npm test' }, testCommand: 'npm test', ...cfg }) }));
  };
  assert.deepEqual(load({}).lastResort, ['codex']);
  assert.deepEqual(load({ lastResort: [] }).lastResort, []);
  assert.equal(load({ routineReview: null }).routineReview, null);
  assert.throws(() => load({ lastResort: ['gpt'] }), /lastResort/);
  assert.throws(() => load({ lastResortLimits: { fiveHour: 0, week: 50 } }), /lastResortLimits/);
  assert.throws(() => load({ routineReview: { maxLines: 0, riskPaths: [] } }), /routineReview/);
});
