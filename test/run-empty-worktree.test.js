import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseCard } from '../src/config.js';
import { readLedger } from '../src/ledger.js';
import { describeStop, issueStopNote, run } from '../src/run.js';
import { commit, fixtureConfig, fixtureRepo, g, tmp } from './helpers.js';

const FAKE = fileURLToPath(new URL('./fake-worker.js', import.meta.url));
const PRELOAD = fileURLToPath(new URL('./fake-linear-fetch.js', import.meta.url));
const BIN = resolve('bin/keel.js');
const tier = (mode) => ({ provider: 'exec', family: 'exec', model: `m-${mode}`, effort: 'low', command: ['node', FAKE, mode] });
const config = (mode) => fixtureConfig({ tiers: [tier(mode)], learnStart: false, maxAttempts: 1 });
const card = () => parseCard('# T-51: fix add\nkind: bug\nsize: S\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n');
const branches = (dir) => g(dir, 'branch', '--list', 'keel/*');
/** The worktree path run() picks for a card: the repo name, a hash of its path, and the card id. */
const worktreeOf = (dir) =>
  join(
    process.env.KEEL_STATE_DIR,
    'worktrees',
    `${basename(dir)}-${createHash('sha256').update(resolve(dir)).digest('hex').slice(0, 8)}-T-51`,
  );

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
  process.env.KEEL_FAKE_LOG = join(tmp('keel-log-'), 'calls.jsonl');
});

test('REQ-RUN-51 a run that stops before any commit removes its clean worktree and branch', () => {
  const { dir } = fixtureRepo();
  const lines = [];
  const r = run({ repo: dir, card: card(), config: config('auth'), log: (l) => lines.push(l) });
  assert.equal(r.stopped, 'auth');
  assert.equal(r.worktree, null);
  assert.ok(!existsSync(worktreeOf(dir)), 'worktree removed');
  assert.equal(branches(dir), '', 'branch removed');
  assert.ok(
    lines.some((l) => /^removed empty worktree .*stopped before any change/.test(l)),
    lines.join('\n'),
  );
  assert.equal(readLedger().at(-1).workerStatus, 'auth', 'the ledger row stays');
  const stop = describeStop(r);
  assert.match(stop, /^STOPPED \(auth\):\n[\s\S]* no worktree kept$/);
  assert.equal(stop.split(r.failure.trim()).length, 2, 'the failure is printed once');
  const next = run({ repo: dir, card: card(), config: config('good') });
  assert.equal(next.pass, true, next.failure);
});

test('REQ-RUN-51 a quota stop with no change frees its worktree too', () => {
  const { dir } = fixtureRepo();
  const r = run({ repo: dir, card: card(), config: config('quota') });
  assert.equal(r.stopped, 'quota');
  assert.equal(r.worktree, null);
  assert.equal(branches(dir), '');
});

test('REQ-RUN-51 a run that stopped with a change keeps its worktree and branch', () => {
  const { dir } = fixtureRepo();
  const r = run({ repo: dir, card: card(), config: fixtureConfig({ tiers: [tier('fix-only')], learnStart: false, maxAttempts: 1 }) });
  assert.equal(r.stopped, 'max-attempts');
  assert.ok(existsSync(r.worktree));
  assert.match(branches(dir), /keel\/T-51/);
});

test('REQ-RUN-51 a crashed worker that changed nothing keeps its worktree for inspection (REQ-RUN-5)', () => {
  const { dir } = fixtureRepo();
  const r = run({ repo: dir, card: card(), config: config('crash') });
  assert.equal(r.stopped, 'max-attempts');
  assert.ok(existsSync(r.worktree));
});

test('REQ-RUN-51 a blocked run keeps its worktree for inspection (REQ-RUN-13)', () => {
  const { dir } = fixtureRepo();
  const r = run({ repo: dir, card: card(), config: config('blocked') });
  assert.equal(r.stopped, 'blocked');
  assert.ok(existsSync(r.worktree));
});

const leave = (dir, base) => {
  mkdirSync(join(process.env.KEEL_STATE_DIR, 'worktrees'), { recursive: true });
  const wt = worktreeOf(dir);
  g(dir, 'worktree', 'add', '--quiet', '-b', 'keel/T-51', wt, base);
  return wt;
};

test('REQ-RUN-51 a clean worktree at the base does not block the next run', () => {
  const { dir, base } = fixtureRepo();
  leave(dir, base);
  const lines = [];
  const r = run({ repo: dir, card: card(), config: config('good'), log: (l) => lines.push(l) });
  assert.equal(r.pass, true, r.failure);
  assert.ok(
    lines.some((l) => l.startsWith('removed empty worktree ')),
    lines.join('\n'),
  );
});

test('REQ-RUN-51 a clean worktree behind a base that has moved on does not block the next run', () => {
  const { dir, base } = fixtureRepo();
  leave(dir, base);
  commit(dir, { 'docs/note.md': 'moved on\n' }, 'docs: move the base');
  const r = run({ repo: dir, card: card(), config: config('good') });
  assert.equal(r.pass, true, r.failure);
});

test('REQ-RUN-51 a worktree with a commit, an untracked file, or a tracked change still stops the run', () => {
  for (const [name, touch] of [
    ['a commit', (wt) => commit(wt, { 'work.txt': 'kept\n' }, 'wip: human work')],
    ['an untracked file', (wt) => writeFileSync(join(wt, 'scratch.txt'), 'x\n')],
    ['a tracked change', (wt) => writeFileSync(join(wt, 'src/add.js'), 'export const add = 1;\n')],
  ]) {
    const { dir, base } = fixtureRepo();
    const wt = leave(dir, base);
    touch(wt);
    assert.throws(() => run({ repo: dir, card: card(), config: config('good') }), /worktree exists/, name);
    assert.ok(existsSync(wt), `${name} kept`);
    assert.match(branches(dir), /keel\/T-51/, `${name} branch kept`);
  }
});

test('REQ-RUN-51 a worktree on a branch other than the card branch is not removed', () => {
  const { dir, base } = fixtureRepo();
  const wt = leave(dir, base);
  g(wt, 'checkout', '-q', '--detach');
  assert.throws(() => run({ repo: dir, card: card(), config: config('good') }), /worktree exists/);
  assert.ok(existsSync(wt));
});

test('REQ-RUN-51 issueStopNote names the stop class and the first line of the failure', () => {
  assert.equal(issueStopNote({ pass: true }), '');
  assert.equal(issueStopNote(undefined), '');
  assert.equal(issueStopNote({ pass: false, stopped: 'auth', failure: '\n  Not logged in.\nsecond line' }), ' (auth: Not logged in.)');
  assert.equal(issueStopNote({ pass: false, stopped: 'quota', failure: '' }), ' (quota)');
  assert.equal(issueStopNote({ pass: false, stopped: 'quota' }), ' (quota)');
  const long = issueStopNote({ pass: false, stopped: 'max-attempts', failure: 'x'.repeat(500) });
  assert.ok(long.length < 230, long);
});

test('REQ-RUN-51 keel run of a Linear issue prints the stop class and failure on a failed run, and the next run proceeds', () => {
  const { dir: origin } = fixtureRepo();
  const json = { checks: { test: 'true' }, testCommand: 'true', linearProject: 'demo', review: false, learnStart: false, maxAttempts: 1 };
  const keelJson = (mode) => JSON.stringify({ ...json, tiers: [tier(mode)] });
  commit(origin, { 'keel.json': keelJson('auth') }, 'chore: keel config');
  const dir = realpathSync(tmp('keel-clone-'));
  g(dir, 'clone', '-q', origin, '.');
  const logFile = join(tmp('keel-linear-'), 'comments.jsonl');
  const env = {
    ...process.env,
    KEEL_STATE_DIR: process.env.KEEL_STATE_DIR,
    TMPDIR: tmp('keel-tmpdir-'),
    LINEAR_API_KEY: 'lin_api_test',
    NODE_OPTIONS: `--import=${PRELOAD}`,
    KEEL_FAKE_LINEAR: JSON.stringify({
      id: 'BUI-51',
      title: 'fix add',
      description: '- REQ-ADD-1: add shall sum.',
      labels: ['Bug'],
      estimate: 2,
    }),
    KEEL_FAKE_LINEAR_LOG: logFile,
  };
  const keel = () => spawnSync(process.execPath, [BIN, 'run', 'BUI-51'], { cwd: dir, encoding: 'utf8', env });
  const first = keel();
  assert.equal(first.status, 1, first.stderr);
  assert.match(first.stderr, /^keel: BUI-51: failed \(auth: .+\)$/m);
  assert.doesNotMatch(first.stderr, /worktree exists/);
  assert.equal(g(dir, 'branch', '--list', 'keel/*'), '', 'no branch left');
  assert.match(readFileSync(logFile, 'utf8'), /auth/);
  const second = keel();
  assert.doesNotMatch(second.stderr, /worktree exists/, second.stderr);
  assert.match(second.stderr, /^keel: BUI-51: failed \(auth: /m, 'the second run reached the worker again');
});
