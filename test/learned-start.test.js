import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig, parseCard } from '../src/config.js';
import { appendAttempt, readLedger } from '../src/ledger.js';
import { learnedStart, run } from '../src/run.js';
import { commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const FAKE = fileURLToPath(new URL('./fake-worker.js', import.meta.url));
const REPO = '/repo/a';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
  process.env.KEEL_FAKE_LOG = join(tmp('keel-log-'), 'calls.jsonl');
});

/** `n` past runs in `repo` that started at `tier`: the first `passes` passed on attempt 1; the rest failed it and passed one tier up. */
function history({ repo = REPO, tier = 0, n, passes, cost = 0.3, upCost = 0.3, start = 0 }) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const run = `${repo}-${tier}-${start + i}`;
    const at = new Date(Date.UTC(2026, 9, 1, 0, start + i)).toISOString();
    const pass = i < passes;
    rows.push({ run, repo, attempt: 1, tier, cost, attemptPass: pass, at });
    if (!pass) rows.push({ run, repo, attempt: 2, tier: tier + 1, cost: upCost, attemptPass: true, at });
  }
  return rows;
}

const config = fixtureConfig({ tiers: fixtureConfig().tiers });

test('REQ-RUN-21 starts one tier up when the ledger shows the cheap first try does not pay (L ≥ p × H)', () => {
  const rows = history({ n: 10, passes: 2, cost: 0.37, upCost: 0.32 });
  const s = learnedStart(rows, REPO, 0, config);
  assert.equal(s.tier, 1);
  assert.match(s.note, /tier 0 passed first in 2\/10 runs; \$0\.37 ≥ 20% × \$0\.32/);
});

test('REQ-RUN-21 keeps the cheap tier when it pays, and with too little or unpriced data', () => {
  assert.equal(learnedStart(history({ n: 10, passes: 8, cost: 0.1, upCost: 0.5 }), REPO, 0, config).tier, 0);
  assert.equal(learnedStart(history({ n: 4, passes: 0 }), REPO, 0, config).tier, 0, 'fewer than 5 runs: no decision');
  const unpriced = history({ n: 10, passes: 0 }).map((r) => (r.tier === 1 ? { ...r, cost: undefined } : r));
  assert.equal(learnedStart(unpriced, REPO, 0, config).tier, 0, 'no priced attempts one tier up: no decision');
  assert.equal(learnedStart(history({ repo: '/repo/b', n: 10, passes: 0 }), REPO, 0, config).tier, 0, 'another repo is not this one');
  assert.equal(learnedStart(history({ n: 10, passes: 0 }), REPO, 0, { ...config, learnStart: false }).tier, 0, 'learnStart: false');
});

test('REQ-RUN-21 skips more than one tier while each step does not pay, never past the last tier', () => {
  const rows = [
    ...history({ n: 10, passes: 0, cost: 0.4, upCost: 0.3 }),
    ...history({ tier: 1, n: 9, passes: 0, cost: 0.3, upCost: 0.2, start: 50 }),
  ];
  const s = learnedStart(rows, REPO, 0, config);
  assert.equal(s.tier, 2);
  const top = config.tiers.length - 1;
  assert.equal(learnedStart(history({ tier: top, n: 10, passes: 0 }), REPO, top, config).tier, top);
});

test('REQ-RUN-21 probes the skipped tier again after 10 runs that started above it, so the data stays fresh', () => {
  const old = history({ n: 10, passes: 0, cost: 0.4, upCost: 0.3 });
  const above = history({ tier: 1, n: 10, passes: 10, cost: 0.3, upCost: 0.6, start: 100 });
  const s = learnedStart([...old, ...above], REPO, 0, config);
  assert.equal(s.tier, 0);
  assert.match(s.note, /probe/);
  assert.equal(learnedStart([...old, ...above.slice(0, 9)], REPO, 0, config).tier, 1);
});

test('REQ-RUN-21 keel run starts at the learned tier, logs why, and records it on the ledger row', () => {
  const { dir } = fixtureRepo();
  for (const r of history({ repo: resolve(dir), n: 10, passes: 0, cost: 0.4, upCost: 0.3 }))
    appendAttempt({ ...r, workerStatus: 'ok', gatePass: r.attemptPass, usage: null, durationMs: 1 });
  const tier = (m) => ({ provider: 'exec', model: m, effort: 'low', command: ['node', FAKE, 'good'] });
  const card = parseCard('# T-1: fix add\nkind: bug\nsize: S\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n');
  const lines = [];
  const result = run({ repo: dir, card, config: fixtureConfig({ tiers: [tier('cheap'), tier('strong')] }), log: (l) => lines.push(l) });
  assert.equal(result.pass, true);
  assert.equal(result.tier, 1);
  assert.ok(
    lines.some((l) => /start tier 1 \(learned: tier 0 passed first in 0\/10/.test(l)),
    lines.join('\n'),
  );
  const mine = readLedger().filter((r) => r.card === 'T-1');
  assert.deepEqual(
    mine.map((r) => [r.tier, r.ruleTier]),
    [[1, 0]],
  );
  const calls = readFileSync(process.env.KEEL_FAKE_LOG, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l).env.model);
  assert.deepEqual(calls, ['strong']);
});

test('REQ-RUN-21 learnStart is on by default and must be a boolean', () => {
  const { dir } = fixtureRepo();
  commit(dir, { 'keel.json': JSON.stringify({ checks: { t: 'true' }, testCommand: 'true' }) }, 'cfg');
  assert.equal(loadConfig(dir, 'HEAD').learnStart, true);
  commit(dir, { 'keel.json': JSON.stringify({ checks: { t: 'true' }, testCommand: 'true', learnStart: 'yes' }) }, 'cfg2');
  assert.throws(() => loadConfig(dir, 'HEAD'), /"learnStart" must be true or false/);
});

test('REQ-RUN-22 keel run stops with "budget" once the priced cost of the card reaches cardBudgetUsd', () => {
  const { dir } = fixtureRepo();
  const t = { provider: 'exec', model: 'm', effort: 'low', command: ['node', FAKE, 'fix-only'] };
  const card = parseCard('# T-2: fix add\nkind: bug\nsize: S\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n');
  const lines = [];
  const result = run({
    repo: dir,
    card,
    config: fixtureConfig({ tiers: [t, t, t], cardBudgetUsd: 0.015, learnStart: false }),
    log: (l) => lines.push(l),
  });
  assert.equal(result.pass, false);
  assert.equal(result.stopped, 'budget');
  assert.equal(readLedger().filter((r) => r.card === 'T-2').length, 2, 'the third attempt never ran');
  assert.ok(
    lines.some((l) => /card budget reached: \$0\.02 of \$0\.015/.test(l)),
    lines.join('\n'),
  );
});

test('REQ-RUN-22 cardBudgetUsd must be a positive number', () => {
  const { dir } = fixtureRepo();
  commit(dir, { 'keel.json': JSON.stringify({ checks: { t: 'true' }, testCommand: 'true', cardBudgetUsd: 0 }) }, 'cfg');
  assert.throws(() => loadConfig(dir, 'HEAD'), /"cardBudgetUsd" must be a positive number/);
});

test('REQ-RUN-21 only the model failing its first try counts: blocked, quota, network, and auth stops do not lower the pass rate', () => {
  const rows = history({ n: 5, passes: 4, cost: 0.1, upCost: 0.5 });
  const outage = history({ n: 15, passes: 0, cost: 0.1, upCost: 0.5, start: 200 }).map((r) =>
    r.attempt === 1 ? { ...r, workerStatus: ['quota', 'blocked', 'network', 'auth', 'harness-error'][r.run.length % 5] } : r,
  );
  assert.equal(learnedStart([...rows, ...outage], REPO, 0, config).tier, 0);
});

test('REQ-RUN-21 only runs that started above a skipped tier, by learning not by rule, count toward its probe', () => {
  const old = history({ n: 10, passes: 0, cost: 0.4, upCost: 0.3 });
  const forced = history({ tier: 2, n: 12, passes: 12, start: 300 }).map((r) => ({ ...r, ruleTier: 2 }));
  const s = learnedStart([...old, ...forced], REPO, 0, config);
  assert.equal(s.tier, 1);
  assert.match(s.note, /^learned/);
});

test('REQ-RUN-22 the card budget counts held-out authoring, not only build attempts', () => {
  const { dir } = fixtureRepo();
  const author = {
    provider: 'exec',
    model: 'author',
    effort: 'high',
    command: [
      'node',
      '-e',
      `const fs = require('fs'); fs.readFileSync(0); fs.mkdirSync('test', { recursive: true });
fs.writeFileSync('test/held.test.js', "import assert from 'node:assert';\\nimport { add } from '../src/add.js';\\nassert.strictEqual(add(1, 1), 2);\\n");
console.log(JSON.stringify({ total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } }));`,
    ],
  };
  const builder = { provider: 'exec', model: 'm', effort: 'low', command: ['node', FAKE, 'fix-only'] };
  const card = parseCard('# T-3: fix add\nkind: bug\nsize: M\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n');
  const result = run({
    repo: dir,
    card,
    config: fixtureConfig({ tiers: [builder, builder, author], heldOutAuthorTier: 2, cardBudgetUsd: 0.015, learnStart: false }),
  });
  assert.equal(result.stopped, 'budget');
  assert.equal(readLedger().filter((r) => r.card === 'T-3' && r.role !== 'held-out-author').length, 1);
});
