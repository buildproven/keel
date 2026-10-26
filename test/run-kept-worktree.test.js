import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseCard } from '../src/config.js';
import { run } from '../src/run.js';
import { commit, fixtureConfig, fixtureRepo, g, tmp } from './helpers.js';

const FAKE = fileURLToPath(new URL('./fake-worker.js', import.meta.url));
const tier = (mode) => ({ provider: 'exec', family: 'exec', model: `m-${mode}`, effort: 'low', command: ['node', FAKE, mode] });
const result = `console.log(JSON.stringify({ total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } }));`;
/** Leaves an edit, then reports the card blocked: the run keeps its worktree with a leftovers commit (REQ-RUN-44). */
const blocker = {
  provider: 'exec',
  family: 'exec',
  model: 'm-blocker',
  effort: 'low',
  command: [
    'node',
    '-e',
    `const fs = require('fs'); fs.writeFileSync('half.txt', 'half done\\n'); fs.writeFileSync('KEEL_BLOCKED', 'needs a decision\\n'); ${result}`,
  ],
};
const config = (mode) => fixtureConfig({ tiers: [mode === 'blocked' ? blocker : tier(mode)], learnStart: false, maxAttempts: 1 });
const card = () => parseCard('# T-48: fix add\nkind: bug\nsize: S\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n');
/** The run lock run() takes for a worktree: the same name under the state dir's locks (REQ-RUN-10). */
const lockOf = (wt) => join(process.env.KEEL_STATE_DIR, 'locks', basename(wt));

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
  process.env.KEEL_FAKE_LOG = join(tmp('keel-log-'), 'calls.jsonl');
});

test('REQ-RUN-48 a retry of a blocked card removes the worktree the blocked run kept and builds from base', () => {
  const { dir, base } = fixtureRepo();
  const blocked = run({ repo: dir, card: card(), config: config('blocked') });
  assert.equal(blocked.stopped, 'blocked');
  assert.equal(g(blocked.worktree, 'log', '-1', '--format=%s'), 'chore(T-48): keel attempt 1 leftovers');
  const lines = [];
  const second = run({ repo: dir, card: card(), config: config('good'), log: (l) => lines.push(l) });
  assert.equal(second.pass, true, second.failure);
  assert.ok(lines.includes(`removed kept worktree ${blocked.worktree} of an earlier blocked run`), lines.join('\n'));
  assert.equal(second.worktree, blocked.worktree);
  assert.equal(g(dir, 'merge-base', base, 'keel/T-48'), base, 'built from base');
  assert.ok(!g(dir, 'ls-tree', '-r', '--name-only', 'keel/T-48').split('\n').includes('half.txt'), 'the blocked attempt is gone');
});

test('REQ-RUN-48 with a live run lock on the kept worktree, the retry refuses with worktree exists and keeps it', () => {
  const { dir } = fixtureRepo();
  const blocked = run({ repo: dir, card: card(), config: config('blocked') });
  mkdirSync(join(process.env.KEEL_STATE_DIR, 'locks'), { recursive: true });
  writeFileSync(`${lockOf(blocked.worktree)}.run-${process.ppid}`, ''); // the test runner's parent is alive
  assert.throws(() => run({ repo: dir, card: card(), config: config('good') }), /worktree exists: .*T-48/);
  assert.ok(existsSync(blocked.worktree), 'a live run keeps its worktree');
  assert.equal(g(blocked.worktree, 'symbolic-ref', '--short', 'HEAD'), 'keel/T-48');
});

test('REQ-RUN-48 a blocked run’s worktree with a commit Keel did not make, or uncommitted work, is never removed', () => {
  const { dir } = fixtureRepo();
  const blocked = run({ repo: dir, card: card(), config: config('blocked') });
  const mine = commit(blocked.worktree, { 'NOTES.md': 'mine\n' }, 'my work');
  assert.throws(() => run({ repo: dir, card: card(), config: config('good') }), /worktree exists/);
  assert.equal(g(dir, 'rev-parse', 'keel/T-48'), mine);
  g(blocked.worktree, 'reset', '-q', '--hard', 'HEAD~1');
  writeFileSync(join(blocked.worktree, 'scratch.txt'), 'in progress\n');
  assert.throws(() => run({ repo: dir, card: card(), config: config('good') }), /worktree exists/);
  assert.ok(existsSync(join(blocked.worktree, 'scratch.txt')), 'uncommitted work stays');
});

test('REQ-RUN-48 a blocked run’s worktree moved off its keel/ branch is never removed', () => {
  const { dir } = fixtureRepo();
  const blocked = run({ repo: dir, card: card(), config: config('blocked') });
  g(blocked.worktree, 'checkout', '-q', '-b', 'mine');
  assert.throws(() => run({ repo: dir, card: card(), config: config('good') }), /worktree exists/);
  assert.equal(g(blocked.worktree, 'symbolic-ref', '--short', 'HEAD'), 'mine');
});

test('REQ-RUN-48 a retry replaces a worktree kept after max attempts and builds from base', () => {
  const { dir } = fixtureRepo();
  const first = run({ repo: dir, card: card(), config: config('crash') });
  assert.equal(first.stopped, 'max-attempts');
  const lines = [];
  const second = run({ repo: dir, card: card(), config: config('good'), log: (line) => lines.push(line) });
  assert.equal(second.pass, true, second.failure);
  assert.ok(lines.includes(`removed kept worktree ${first.worktree} of an earlier blocked run`), lines.join('\n'));
});
