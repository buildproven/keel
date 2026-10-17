import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, loadConfig, parseCard } from '../src/config.js';
import { appendAttempt, readLedger, spentToday } from '../src/ledger.js';
import { poll } from '../src/poll.js';
import { run } from '../src/run.js';
import { commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const NOW = new Date('2026-09-29T15:00:00Z');
const row = (over = {}) => ({ repo: '/r/a', cost: 1, at: '2026-09-29T01:00:00.000Z', ...over });

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-budget-state-');
});

test('REQ-LINEAR-9 spentToday sums this repo, today (UTC), and counts unpriced rows', () => {
  const rows = [
    row({ cost: 0.5 }),
    row({ cost: 1.25, at: '2026-09-29T23:59:59.000Z' }),
    row({ cost: 9, repo: '/r/other' }),
    row({ cost: 9, at: '2026-09-28T23:59:59.000Z' }),
    row({ cost: null }),
    row({ cost: undefined }),
  ];
  assert.deepEqual(spentToday(rows, '/r/a', NOW), { usd: 1.75, unpriced: 2 });
});

test('REQ-LINEAR-9 a ledger row records the repo it ran in', () => {
  const { dir } = fixtureRepo();
  const tierOk = {
    provider: 'exec',
    model: 'm',
    effort: 'low',
    command: ['node', fileURLToPath(new URL('./fake-worker.js', import.meta.url)), 'good'],
  };
  process.env.KEEL_FAKE_LOG = join(tmp('keel-log-'), 'calls.jsonl');
  const c = parseCard('# T-9: fix add\nkind: chore\nsize: S\n');
  run({ repo: dir, card: c, config: fixtureConfig({ tiers: [tierOk] }) });
  assert.ok(readLedger().length > 0);
  for (const r of readLedger()) assert.equal(r.repo, dir);
});

const issue = {
  id: 'BUI-1',
  title: 't',
  description: '- REQ-1: x shall y.',
  priority: 2,
  createdAt: '2026-09-01',
  labels: ['Bug'],
  estimate: null,
};
const client = (events, issues = [issue]) => ({
  listIssues: async () => issues,
  comment: async (id, body) => events.push({ id, body }),
  review: async (id) => events.push({ id, action: 'review' }),
  stateType: async () => 'started',
});

test('REQ-LINEAR-9 poll stops at the ceiling: runs nothing, comments nothing, reports budget', async () => {
  const { dir } = fixtureRepo();
  appendAttempt({ run: 'r1', card: 'X-1', repo: dir, cost: 4.2, workerStatus: 'ok', gatePass: true, usage: null });
  const events = [];
  let ran = 0;
  const results = await poll({
    repo: dir,
    project: 'p',
    client: client(events),
    config: fixtureConfig({ dailyBudgetUsd: 4 }),
    runFn: () => {
      ran += 1;
      return { pass: true };
    },
  });
  assert.equal(ran, 0);
  assert.deepEqual(events, []);
  assert.equal(results[0].outcome, 'budget');
  assert.equal(results[0].spent, 4.2);
});

test('REQ-LINEAR-9 poll runs while spend is under the ceiling, and unlimited when unset', async () => {
  const { dir } = fixtureRepo();
  appendAttempt({ run: 'r1', card: 'X-1', repo: dir, cost: 1, workerStatus: 'ok', gatePass: true, usage: null });
  for (const [n, dailyBudgetUsd] of [10, null].entries()) {
    let ran = 0;
    const events = [];
    await poll({
      repo: dir,
      project: 'p',
      client: client(events, [{ ...issue, id: `BUI-${n + 10}` }]),
      config: fixtureConfig({ dailyBudgetUsd }),
      runFn: () => {
        ran += 1;
        return { pass: false, stopped: 'maxAttempts', failure: 'x', worktree: '/w' };
      },
      limit: 1,
    });
    assert.equal(ran, 1, `dailyBudgetUsd=${dailyBudgetUsd}`);
  }
});

test('REQ-LINEAR-9 dailyBudgetUsd defaults to none and must be a positive number', () => {
  assert.equal(DEFAULTS.dailyBudgetUsd, null);
  const { dir } = fixtureRepo();
  const at = (extra) => {
    commit(dir, { 'keel.json': JSON.stringify({ checks: { test: 'true' }, testCommand: 'true', ...extra }) }, 'cfg');
    return 'HEAD';
  };
  for (const bad of [0, -1, '5', true]) assert.throws(() => loadConfig(dir, at({ dailyBudgetUsd: bad })), /dailyBudgetUsd/);
  assert.equal(loadConfig(dir, at({ dailyBudgetUsd: 2.5 })).dailyBudgetUsd, 2.5);
  assert.ok(readFileSync(new URL('../docs/DESIGN.md', import.meta.url), 'utf8').includes('REQ-LINEAR-9'));
});
