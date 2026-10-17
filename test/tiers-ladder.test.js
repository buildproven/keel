import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS, loadConfig } from '../src/config.js';
import { learnedStart, tierLabel } from '../src/run.js';
import { commit, fixtureConfig, fixtureRepo } from './helpers.js';

const SONNET_LOW = { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'low' };
const SONNET = { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high' };
const OPUS = { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' };
const REPO = '/repo/ladder';

test('REQ-RUN-35 the default ladder starts at Sonnet high: no low-effort Sonnet tier', () => {
  assert.deepEqual(
    DEFAULTS.tiers.map((t) => `${t.provider}:${t.model}:${t.effort}`),
    ['claude:claude-sonnet-5-5:high', 'claude:claude-opus-5-5:high', 'codex:gpt-5.6-sol:high'],
  );
  assert.deepEqual(DEFAULTS.startTier, { L: 1, protected: 0 }, 'L still starts at Opus, protected at Sonnet high');
  const { dir } = fixtureRepo();
  commit(dir, { 'keel.json': JSON.stringify({ checks: { t: 'true' }, testCommand: 'true' }) }, 'cfg');
  assert.equal(loadConfig(dir, 'HEAD').heldOutAuthorTier, 2, 'Codex writes held-out tests');
});

/** Past runs written under the old four-tier ladder: each row names its tier index and its model. */
function oldRuns({ first, up, n, passes, start = 0 }) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const run = `old-${first.effort}-${start + i}`;
    const at = new Date(Date.UTC(2026, 9, 1, 0, start + i)).toISOString();
    const pass = i < passes;
    rows.push({ run, repo: REPO, attempt: 1, ...first.row, cost: 0.4, attemptPass: pass, at });
    if (!pass) rows.push({ run, repo: REPO, attempt: 2, ...up.row, cost: 0.3, attemptPass: true, at });
  }
  return rows;
}
const at = (tier, index) => ({ ...tier, row: { tier: index, ...tier } });

test('REQ-RUN-35 REQ-RUN-21 learned routing reads ledger rows by model and effort, not by the tier index they were written with', () => {
  const config = fixtureConfig({ tiers: DEFAULTS.tiers });
  // Sonnet low, once tier 0, never passed first: that says nothing about today's tier 0 (Sonnet high).
  const low = oldRuns({ first: at(SONNET_LOW, 0), up: at(SONNET, 1), n: 10, passes: 0 });
  assert.equal(learnedStart(low, REPO, 0, config).tier, 0);
  // Sonnet high, once tier 1, never paid against Opus (once tier 2): today that is tier 0 against tier 1.
  const high = oldRuns({ first: at(SONNET, 1), up: at(OPUS, 2), n: 10, passes: 0, start: 100 });
  const s = learnedStart(high, REPO, 0, config);
  assert.equal(s.tier, 1);
  assert.match(s.note, /tier 0 passed first in 0\/10 runs/);
});

test('REQ-RUN-35 REQ-RUN-21 an old row without ruleLabel keeps how far learning moved it, so the probe still comes', () => {
  const config = fixtureConfig({ tiers: DEFAULTS.tiers });
  // Under the old ladder, Sonnet high (index 1) failed first and Opus (index 2) paid, so learning moved runs up.
  const high = oldRuns({ first: at(SONNET, 1), up: at(OPUS, 2), n: 10, passes: 0 }).map((r) => ({ ...r, ruleTier: 1 }));
  // Ten later runs started at Opus (old index 2) by learning from the rule tier, Sonnet high (old index 1).
  const above = oldRuns({ first: at(OPUS, 2), up: at(OPUS, 2), n: 10, passes: 10, start: 100 }).map((r) => ({ ...r, ruleTier: 1 }));
  const s = learnedStart([...high, ...above], REPO, 0, config);
  assert.equal(s.tier, 0);
  assert.match(s.note, /probe/);
});

test('REQ-RUN-35 exec tiers that differ only by command are told apart; rows of a ladder with twin labels keep their index', () => {
  const exec = (cmd) => ({ provider: 'exec', command: [cmd] });
  const config = fixtureConfig({ tiers: [exec('cheap'), exec('strong')] });
  const rows = [];
  for (let i = 0; i < 10; i++) {
    const run = `x-${i}`;
    const atTime = new Date(Date.UTC(2026, 9, 2, 0, i)).toISOString();
    rows.push({
      run,
      repo: REPO,
      attempt: 1,
      tier: 0,
      provider: 'exec',
      tierLabel: tierLabel(exec('cheap')),
      cost: 0.4,
      attemptPass: false,
      at: atTime,
    });
    rows.push({
      run,
      repo: REPO,
      attempt: 2,
      tier: 1,
      provider: 'exec',
      tierLabel: tierLabel(exec('strong')),
      cost: 0.3,
      attemptPass: true,
      at: atTime,
    });
  }
  assert.notEqual(tierLabel(exec('cheap')), tierLabel(exec('strong')));
  assert.equal(learnedStart(rows, REPO, 0, config).tier, 1);
  const twins = fixtureConfig({ tiers: [SONNET, SONNET, OPUS] });
  const byIndex = oldRuns({ first: at(SONNET, 0), up: at(SONNET, 1), n: 10, passes: 0 });
  assert.equal(learnedStart(byIndex, REPO, 0, twins).tier, 1, 'twin labels: the index decides');
});
