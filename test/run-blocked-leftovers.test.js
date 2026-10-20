import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { autoClean } from '../src/autoclean.js';
import { parseCard } from '../src/config.js';
import { stateDir } from '../src/ledger.js';
import { run } from '../src/run.js';
import { BUGGY, fixtureConfig, fixtureRepo, g, tmp } from './helpers.js';

const card = () => parseCard('# T-40: fix add\nkind: bug\nsize: S\n\n## Requirements\n- REQ-ADD-1: add(a, b) shall return a + b.\n');
const LEFTOVERS = 'chore(T-40): keel attempt 1 leftovers';
const EDIT = 'export const add = (a, b) => a + b; // half done\n';
const edit = `require('fs').writeFileSync('src/add.js', ${JSON.stringify(EDIT)}); require('fs').writeFileSync('notes.txt', 'new file\\n');`;
const result = `console.log(JSON.stringify({ total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } }));`;
const tier = (script) => ({ provider: 'exec', model: 'exec-left', effort: 'low', command: ['node', '-e', script] });
/** Edits a tracked file and adds an untracked one, then reports the card blocked. */
const blocker = tier(`${edit} require('fs').writeFileSync('KEEL_BLOCKED', 'the card needs a decision\\n'); ${result}`);
/** Edits, then hangs past workerTimeoutSec. */
const sleeper = tier(`${edit} setTimeout(() => {}, 60000);`);
const config = (t) => fixtureConfig({ tiers: [t], maxAttempts: 1, workerTimeoutSec: 1 });
const HOUR = 3600 * 1000;

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

test('REQ-RUN-44 a blocked worker’s edits are committed as attempt leftovers and the worktree is left clean', () => {
  const { dir } = fixtureRepo();
  const r = run({ repo: dir, card: card(), config: config(blocker) });
  assert.equal(r.stopped, 'blocked');
  assert.equal(g(r.worktree, 'status', '--porcelain'), '');
  assert.equal(g(r.worktree, 'log', '-1', '--format=%s'), LEFTOVERS);
  assert.equal(g(r.worktree, 'symbolic-ref', '--short', 'HEAD'), 'keel/T-40');
  assert.equal(g(r.worktree, 'show', 'HEAD:src/add.js'), EDIT.trim());
  assert.equal(g(r.worktree, 'show', 'HEAD:notes.txt'), 'new file');
  assert.ok(!g(r.worktree, 'ls-tree', '-r', '--name-only', 'HEAD').includes('KEEL_BLOCKED'), 'KEEL_BLOCKED is never committed');
});

test('REQ-RUN-44 a worker that times out after editing leaves a clean worktree with its leftovers committed', () => {
  const { dir } = fixtureRepo();
  const r = run({ repo: dir, card: card(), config: config(sleeper) });
  assert.equal(r.pass, false);
  assert.equal(g(r.worktree, 'status', '--porcelain'), '');
  assert.equal(g(r.worktree, 'log', '-1', '--format=%s'), LEFTOVERS);
  assert.equal(g(r.worktree, 'show', 'HEAD:src/add.js'), EDIT.trim());
});

/** A repo whose pre-commit hook rejects every commit Keel makes in its worktrees. */
const hookedRepo = () => {
  const { dir, base } = fixtureRepo();
  const hook = join(dir, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\necho rejected by hook >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  return { dir, base };
};

for (const [name, worker] of [
  ['blocked', blocker],
  ['timed-out', sleeper],
]) {
  test(`REQ-RUN-45 when a hook rejects the leftovers commit of a ${name} worker, the diff is saved as a patch and the worktree reset`, () => {
    const { dir, base } = hookedRepo();
    const lines = [];
    const r = run({ repo: dir, card: card(), config: config(worker), log: (l) => lines.push(l) });
    assert.equal(r.pass, false);
    assert.equal(g(r.worktree, 'status', '--porcelain'), '');
    assert.equal(g(r.worktree, 'rev-parse', 'HEAD'), base);
    const patch = join(stateDir(), 'leftovers', 'T-40-attempt-1.patch');
    assert.ok(existsSync(patch), `no patch at ${patch}`);
    const text = readFileSync(patch, 'utf8');
    assert.match(text, /half done/);
    assert.match(text, /notes\.txt/, 'an untracked file is in the patch too');
    assert.ok(!text.includes('KEEL_BLOCKED'), 'the block reason is not part of the work');
    assert.ok(
      lines.some((l) => l.includes(patch)),
      `the patch path is printed:\n${lines.join('\n')}`,
    );
    // The patch restores the work on the base.
    g(r.worktree, 'apply', patch);
    assert.equal(readFileSync(join(r.worktree, 'src/add.js'), 'utf8'), EDIT);
  });
}

test('REQ-RUN-45 a second run of the same card never overwrites an earlier leftovers patch', () => {
  const { dir } = hookedRepo();
  const first = run({ repo: dir, card: card(), config: config(blocker) });
  g(dir, 'worktree', 'remove', '--force', first.worktree);
  g(dir, 'branch', '-D', first.branch);
  const lines = [];
  run({ repo: dir, card: card(), config: config(blocker), log: (l) => lines.push(l) });
  const leftovers = join(stateDir(), 'leftovers');
  assert.ok(existsSync(join(leftovers, 'T-40-attempt-1.patch')));
  const second = join(leftovers, 'T-40-attempt-1-2.patch');
  assert.ok(existsSync(second), `no second patch at ${second}`);
  assert.ok(lines.some((l) => l.includes(second)));
});

test('REQ-CLEAN-6 autoclean removes the parked worktree of a blocked run by the worktreeKeepDays age rule', () => {
  const { dir } = fixtureRepo({
    ...BUGGY,
    'keel.json': JSON.stringify({ checks: { t: 'true' }, testCommand: 'true', worktreeKeepDays: 0 }),
  });
  const r = run({ repo: dir, card: card(), config: config(blocker) });
  assert.equal(r.stopped, 'blocked');
  const lines = [];
  const cleaned = autoClean({ now: Date.now() + 2 * HOUR, log: (l) => lines.push(l), tmpRoot: tmp('keel-tmproot-') });
  assert.deepEqual(cleaned.removed, [r.worktree], lines.join('\n'));
  assert.ok(!existsSync(r.worktree));
  assert.equal(g(dir, 'branch', '--list', r.branch), '');
});
