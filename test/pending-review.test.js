import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseCard } from '../src/config.js';
import { readLedger } from '../src/ledger.js';
import { poll } from '../src/poll.js';
import { learnedStart, run } from '../src/run.js';
import { commit, fixtureConfig, fixtureRepo, g, tmp } from './helpers.js';

const FAKE = fileURLToPath(new URL('./fake-worker.js', import.meta.url));
const builder = { provider: 'exec', family: 'claude', model: 'exec-good', effort: 'low', command: ['node', FAKE, 'good'] };
const strong = { ...builder, model: 'exec-strong', effort: 'high' };
// A reviewer that answers with no verdict is unavailable (REQ-GATE-21), like one out of quota.
const down = {
  provider: 'exec',
  family: 'codex',
  model: 'exec-review',
  effort: 'high',
  command: ['node', '-e', "require('fs').readFileSync(0)"],
};
const up = { ...down, command: ['node', '-e', "require('fs').readFileSync(0); console.log('VERDICT: pass')"] };
const blocks = {
  ...down,
  command: ['node', '-e', "require('fs').readFileSync(0); console.log('FINDING high src/add.js:1 wrong'); console.log('VERDICT: block')"],
};
const card = () => parseCard('# BUI-9: fix add\nkind: bug\nsize: S\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n');
const config = (reviewer, tiers = [builder]) =>
  fixtureConfig({ review: true, reviewFallback: false, maxAttempts: 2, tiers: [...tiers, reviewer] });
const builds = () =>
  existsSync(process.env.KEEL_FAKE_LOG) ? readFileSync(process.env.KEEL_FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).length : 0;

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
  process.env.KEEL_FAKE_LOG = join(tmp('keel-log-'), 'calls.jsonl');
});

test('REQ-RUN-24 a run stopped only by an unavailable reviewer keeps its branch and records the head as pendingReview', () => {
  const { dir } = fixtureRepo();
  const r = run({ repo: dir, card: card(), config: config(down) });
  assert.equal(r.stopped, 'review-unavailable');
  assert.equal(r.pendingReview, true);
  assert.ok(existsSync(r.worktree));
  const row = readLedger().at(-1);
  assert.equal(row.pendingReview, true);
  assert.equal(row.head, g(dir, 'rev-parse', 'keel/BUI-9'));
});

test('REQ-RUN-25 the next run of that card gates the kept head again and passes without building', () => {
  const { dir } = fixtureRepo();
  const first = run({ repo: dir, card: card(), config: config(down) });
  const head = readLedger().at(-1).head;
  assert.equal(builds(), 1);
  const second = run({ repo: dir, card: card(), config: config(up) });
  assert.equal(second.pass, true, second.failure);
  assert.equal(builds(), 1, 'no second build');
  assert.equal(second.receipt.head, head);
  assert.equal(second.worktree, first.worktree);
  const row = readLedger().at(-1);
  assert.equal(row.resumed, true);
  assert.equal(row.gatePass, true);
});

test('REQ-RUN-25 when the kept head fails review, the run builds on from the next tier with the findings', () => {
  const { dir } = fixtureRepo();
  run({ repo: dir, card: card(), config: config(down, [builder, strong]) });
  const second = run({ repo: dir, card: card(), config: config(blocks, [builder, strong]) });
  assert.equal(second.pass, false);
  const calls = readFileSync(process.env.KEEL_FAKE_LOG, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.equal(calls.length, 2, 'one new build after the re-gate');
  assert.equal(calls[1].env.model, 'exec-strong');
  assert.match(calls[1].prompt, /"rule":"review-finding".*"path":"src\/add\.js".*"text":"wrong"/);
});

test('REQ-RUN-25 a kept head on an old base is removed and the card is built again', () => {
  const { dir } = fixtureRepo();
  const first = run({ repo: dir, card: card(), config: config(down) });
  commit(dir, { 'README.md': 'moved\n' }, 'base moved');
  const second = run({ repo: dir, card: card(), config: config(up) });
  assert.equal(second.pass, true, second.failure);
  assert.equal(builds(), 2);
  assert.notEqual(second.receipt.head, readLedger().find((r) => r.pendingReview).head);
  assert.equal(second.worktree, first.worktree);
});

test('REQ-RUN-25 a kept head built for an older text of the card is removed and the card is built again', () => {
  const { dir } = fixtureRepo();
  run({ repo: dir, card: card(), config: config(down) });
  const edited = parseCard(
    '# BUI-9: fix add\nkind: bug\nsize: S\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n- REQ-ADD-2: add(0, 0) is 0.\n',
  );
  const second = run({ repo: dir, card: edited, config: config(up) });
  assert.equal(second.pass, true, second.failure);
  assert.equal(builds(), 2);
});

test('REQ-LINEAR-19 a deferral whose build is pending review keeps the worktree and says so', async () => {
  const { dir } = fixtureRepo();
  const wt = join(tmp('keel-wt-'), 'wt');
  g(dir, 'worktree', 'add', '-q', '-b', 'keel/BUI-7', wt);
  const comments = [];
  const client = {
    listIssues: async () => [
      { id: 'BUI-7', title: 't', description: '- REQ-1: it shall work.', priority: 2, createdAt: '2026-09-01', labels: [], estimate: null },
    ],
    comment: async (id, body) => comments.push(body),
    review: async () => {},
    stateType: async () => 'started',
  };
  const runFn = () => ({
    pass: false,
    stopped: 'review-unavailable',
    pendingReview: true,
    branch: 'keel/BUI-7',
    worktree: wt,
    failure: 'limit',
  });
  const [r] = await poll({ repo: dir, project: 'x', client, config: {}, runFn });
  assert.equal(r.outcome, 'deferred');
  assert.ok(existsSync(wt));
  assert.match(comments[0], /build passed every other stage and is kept/);
});

test('REQ-RUN-25 a kept head built under another tier ladder is removed and the card is built again', () => {
  const { dir } = fixtureRepo();
  run({ repo: dir, card: card(), config: config(down) });
  const second = run({ repo: dir, card: card(), config: config(up, [strong]) });
  assert.equal(second.pass, true, second.failure);
  assert.equal(builds(), 2);
});

test('REQ-RUN-25 a kept worktree whose HEAD moved off the kept head is removed and the card is built again', () => {
  const { dir } = fixtureRepo();
  const first = run({ repo: dir, card: card(), config: config(down) });
  g(first.worktree, 'checkout', '-q', '--detach', 'HEAD~1');
  const second = run({ repo: dir, card: card(), config: config(up) });
  assert.equal(second.pass, true, second.failure);
  assert.equal(builds(), 2);
});

test('REQ-RUN-25 learned routing ignores resumed attempts in the priced samples too', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) {
    const at = new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString();
    const pass = i < 2;
    rows.push({ run: `r${i}`, repo: '/repo/a', attempt: 1, tier: 0, cost: 0.37, attemptPass: pass, at });
    if (!pass) rows.push({ run: `r${i}`, repo: '/repo/a', attempt: 2, tier: 1, cost: 0.32, attemptPass: true, at });
  }
  const tiers = fixtureConfig().tiers;
  const cfg = fixtureConfig({ tiers });
  assert.equal(learnedStart(rows, '/repo/a', 0, cfg).tier, 1);
  const resumed = Array.from({ length: 100 }, (_, i) => ({
    run: `z${i}`,
    repo: '/repo/a',
    attempt: 1,
    tier: 0,
    cost: 0,
    resumed: true,
    attemptPass: true,
    at: new Date(Date.UTC(2026, 9, 2, 0, i)).toISOString(),
  }));
  assert.equal(learnedStart([...rows, ...resumed], '/repo/a', 0, cfg).tier, 1);
});

test('REQ-RUN-25 a kept branch whose worktree was removed is deleted and the card is built again', () => {
  const { dir } = fixtureRepo();
  const first = run({ repo: dir, card: card(), config: config(down) });
  g(dir, 'worktree', 'remove', '--force', first.worktree);
  const second = run({ repo: dir, card: card(), config: config(up) });
  assert.equal(second.pass, true, second.failure);
  assert.equal(builds(), 2);
});

test('REQ-RUN-25 a kept branch with commits Keel did not make is never deleted: the run stops and names the worktree', () => {
  const { dir } = fixtureRepo();
  const first = run({ repo: dir, card: card(), config: config(down) });
  const mine = commit(first.worktree, { 'NOTES.md': 'mine\n' }, 'my work');
  assert.throws(() => run({ repo: dir, card: card(), config: config(up) }), /worktree exists/);
  assert.equal(g(dir, 'rev-parse', 'keel/BUI-9'), mine);
});

test('REQ-RUN-25 a kept worktree at the kept head whose branch ref was deleted is removed and the card is built again', () => {
  const { dir } = fixtureRepo();
  const first = run({ repo: dir, card: card(), config: config(down) });
  g(first.worktree, 'checkout', '-q', '--detach');
  g(dir, 'branch', '-D', 'keel/BUI-9');
  const second = run({ repo: dir, card: card(), config: config(up) });
  assert.equal(second.pass, true, second.failure);
  assert.equal(builds(), 2);
});

test('REQ-RUN-21 a first try that waited only for review is not a failed first try', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) {
    const at = new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString();
    rows.push({ run: `r${i}`, repo: '/repo/a', attempt: 1, tier: 0, cost: 0.1, attemptPass: true, at });
    rows.push({ run: `r${i}`, repo: '/repo/a', attempt: 1, tier: 1, cost: 0.3, attemptPass: true, at, ruleTier: 1 });
  }
  const outage = Array.from({ length: 30 }, (_, i) => ({
    run: `p${i}`,
    repo: '/repo/a',
    attempt: 1,
    tier: 0,
    cost: 0.1,
    workerStatus: 'ok',
    attemptPass: false,
    pendingReview: true,
    at: new Date(Date.UTC(2026, 9, 2, 0, i)).toISOString(),
  }));
  const cfg = fixtureConfig({ tiers: fixtureConfig().tiers });
  assert.equal(learnedStart([...rows, ...outage], '/repo/a', 0, cfg).tier, 0);
});
