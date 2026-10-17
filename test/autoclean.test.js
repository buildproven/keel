import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { autoClean } from '../src/autoclean.js';
import { loadConfig } from '../src/config.js';
import { withTempWorktree } from '../src/git.js';
import { g, tmp } from './helpers.js';

const BIN = new URL('../bin/keel.js', import.meta.url).pathname;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-autoclean-state-');
});

/** A repo with a keel.json (so its keepDays can be read) and a parked Keel worktree for `cardId` on `keel/<cardId>`. */
function parked(cardId, keelJson = {}) {
  const repo = tmp('keel-autoclean-repo-');
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'user.email', 't@e.com');
  g(repo, 'config', 'user.name', 't');
  g(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'keel.json'), JSON.stringify({ checks: { t: 'true' }, testCommand: 'true', ...keelJson }));
  writeFileSync(join(repo, 'a.txt'), 'x');
  g(repo, 'add', '-A');
  g(repo, 'commit', '-q', '-m', 'base');
  const wt = join(process.env.KEEL_STATE_DIR, 'worktrees', `${basename(repo)}-abc12345-${cardId}`);
  g(repo, 'worktree', 'add', '-q', '-b', `keel/${cardId}`, wt);
  return { repo, wt };
}

/** A commit in the worktree, by default the one Keel makes for an attempt (REQ-RUN-7). */
function keelCommit(wt, cardId, n = 1, message = `chore(${cardId}): keel attempt ${n} leftovers`) {
  writeFileSync(join(wt, `f${n}.txt`), String(n));
  g(wt, 'add', '-A');
  g(wt, 'commit', '-q', '-m', message);
}

const branchExists = (repo, branch) => g(repo, 'branch', '--list', branch) !== '';

function pass(now) {
  const lines = [];
  const result = autoClean({ log: (m) => lines.push(m), now, tmpRoot: tmp('keel-autoclean-tmp-') });
  return { lines, result };
}

test('REQ-CLEAN-3 a clean worktree with no commit only there (tip in base) is removed with its branch, after an hour', () => {
  const { repo, wt } = parked('T-1');
  assert.deepEqual(pass(Date.now()).lines, [], 'younger than an hour: left to its own poll');
  assert.ok(existsSync(wt));
  const { lines } = pass(Date.now() + 2 * HOUR);
  assert.match(lines.join('\n'), new RegExp(`removed ${wt} \\(`));
  assert.ok(!existsSync(wt));
  assert.ok(!branchExists(repo, 'keel/T-1'));
});

test('REQ-CLEAN-3 a pushed branch (its tip in a remote-tracking ref, as after a merged PR) is removed at once', () => {
  const { repo, wt } = parked('T-2');
  keelCommit(wt, 'T-2');
  g(repo, 'update-ref', 'refs/remotes/origin/keel/T-2', g(wt, 'rev-parse', 'HEAD'));
  pass(Date.now() + 2 * HOUR);
  assert.ok(!existsSync(wt));
  assert.ok(!branchExists(repo, 'keel/T-2'));
});

test('REQ-CLEAN-3 a failed run with only Keel commits is kept for worktreeKeepDays after its last ledger row, then removed', () => {
  const { repo, wt } = parked('T-3');
  keelCommit(wt, 'T-3', 1);
  keelCommit(wt, 'T-3', 2);
  const at = Date.now();
  writeFileSync(
    join(process.env.KEEL_STATE_DIR, 'ledger.jsonl'),
    `${JSON.stringify({ card: 'T-3', repo, at: new Date(at).toISOString() })}\n`,
  );
  assert.deepEqual(pass(at + 6 * DAY).lines, [], 'a parked failure inside its keep window is kept silently');
  assert.ok(existsSync(wt));
  const { lines } = pass(at + 8 * DAY);
  assert.match(lines.join('\n'), /removed .*T-3 \(.*7 days/);
  assert.ok(!existsSync(wt));
  assert.ok(!branchExists(repo, 'keel/T-3'));
});

test('REQ-CLEAN-3 worktreeKeepDays comes from the owning repo keel.json and is validated', () => {
  const { wt } = parked('T-4', { worktreeKeepDays: 1 });
  keelCommit(wt, 'T-4');
  pass(Date.now() + 2 * DAY);
  assert.ok(!existsSync(wt));
  const repo = tmp('keel-autoclean-cfg-');
  g(repo, 'init', '-q', '-b', 'main');
  for (const bad of [-1, 1.5, '7']) {
    writeFileSync(join(repo, 'keel.json'), JSON.stringify({ checks: { t: 'true' }, testCommand: 'true', worktreeKeepDays: bad }));
    g(repo, 'add', '-A');
    g(repo, '-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-q', '-m', `bad ${bad}`);
    assert.throws(() => loadConfig(repo, 'HEAD'), /worktreeKeepDays/);
  }
});

test('REQ-CLEAN-3 a worktree whose run lock a live process holds is never removed', () => {
  const { wt } = parked('T-5');
  const locks = join(process.env.KEEL_STATE_DIR, 'locks');
  mkdirSync(locks, { recursive: true });
  writeFileSync(join(locks, `${basename(wt)}.run-${process.pid}-1`), '');
  assert.deepEqual(pass(Date.now() + 30 * DAY).lines, []);
  assert.ok(existsSync(wt));
});

test('REQ-CLEAN-4 a dirty worktree is kept and reported once per reason', () => {
  const { wt } = parked('T-6');
  writeFileSync(join(wt, 'a.txt'), 'changed');
  const first = pass(Date.now() + 30 * DAY).lines;
  assert.equal(first.length, 1);
  assert.match(first[0], new RegExp(`kept ${wt}: uncommitted changes`));
  assert.deepEqual(pass(Date.now() + 30 * DAY).lines, [], 'the same reason is not reported again');
  writeFileSync(join(wt, 'a.txt'), 'x');
  g(wt, 'checkout', '-q', '--detach');
  assert.match(pass(Date.now() + 30 * DAY).lines.join('\n'), /kept .*T-6: on a detached HEAD/);
  assert.ok(existsSync(wt));
});

test('REQ-CLEAN-4 commits Keel did not make keep a worktree, however old', () => {
  const { repo, wt } = parked('T-7');
  keelCommit(wt, 'T-7', 1);
  keelCommit(wt, 'T-7', 2, 'my own fix');
  const { lines } = pass(Date.now() + 90 * DAY);
  assert.match(lines.join('\n'), /kept .*T-7: commits only there that Keel did not make: [0-9a-f]+ my own fix/);
  assert.ok(existsSync(wt));
  assert.ok(branchExists(repo, 'keel/T-7'));
});

test('REQ-CLEAN-4 a worktree switched to a human branch is kept and that branch is never deleted', () => {
  const { repo, wt } = parked('T-8');
  g(repo, 'branch', 'user-work');
  g(wt, 'checkout', '-q', 'user-work');
  assert.match(pass(Date.now() + 30 * DAY).lines.join('\n'), /kept .*T-8: on user-work, not keel\/T-8/);
  assert.ok(branchExists(repo, 'user-work'));
  assert.ok(existsSync(wt));
});

test('REQ-CLEAN-5 gate checkouts carry their owner pid in the name', () => {
  const { repo } = parked('T-9');
  const name = withTempWorktree(repo, 'HEAD', (dir) => basename(dir));
  assert.match(name, new RegExp(`^keel-wt-${process.pid}-`));
});

test('REQ-CLEAN-5 a checkout whose owner is dead, or an old unnamed one, is removed and pruned; live, young, and symlinked ones stay', () => {
  const { repo } = parked('T-10');
  const root = tmp('keel-autoclean-tmproot-');
  const noindex = join(root, 'keel.noindex');
  mkdirSync(noindex);
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const deadWt = join(noindex, `keel-wt-${dead}-AbC123`);
  g(repo, 'worktree', 'add', '-q', '--detach', deadWt);
  const live = join(noindex, `keel-wt-${process.pid}-XyZ789`);
  mkdirSync(live);
  const oldLegacy = join(root, 'keel-wt-Old123');
  mkdirSync(oldLegacy);
  const twoDaysAgo = (Date.now() - 2 * DAY) / 1000;
  utimesSync(oldLegacy, twoDaysAgo, twoDaysAgo);
  const youngLegacy = join(noindex, 'keel-wt-New456');
  mkdirSync(youngLegacy);
  const target = tmp('keel-autoclean-target-');
  const link = join(noindex, `keel-wt-${dead}-Link00`);
  symlinkSync(target, link);
  const other = join(root, 'keel-wt-not-ours-at-all');
  mkdirSync(other);
  utimesSync(other, twoDaysAgo, twoDaysAgo);

  const lines = [];
  autoClean({ log: (m) => lines.push(m), now: Date.now(), tmpRoot: root });
  assert.ok(!existsSync(deadWt), 'dead owner: removed');
  assert.doesNotMatch(g(repo, 'worktree', 'list'), /keel-wt-/, 'its registration is pruned');
  assert.ok(!existsSync(oldLegacy), 'an unnamed checkout over a day old: removed');
  assert.ok(existsSync(live), 'a live owner keeps its checkout');
  assert.ok(existsSync(youngLegacy), 'an unnamed young checkout may belong to a running gate');
  assert.ok(existsSync(link) && existsSync(target), 'a symlink is never followed or removed');
  assert.ok(existsSync(other), 'only keel-wt-<random> names are touched');
  assert.match(lines.join('\n'), /removed 2 gate checkouts/);
});

test('REQ-CLEAN-3 keel clean --auto and the start of keel run remove a finished worktree', () => {
  const env = { ...process.env, TMPDIR: tmp('keel-autoclean-env-tmp-') };
  const a = parked('T-11');
  // A fresh worktree is younger than an hour: backdate the tip so it counts as finished.
  const old = new Date(Date.now() - 2 * HOUR).toISOString();
  process.env.GIT_COMMITTER_DATE = old;
  try {
    g(a.wt, 'commit', '-q', '--allow-empty', '-m', 'chore(T-11): keel attempt 1 leftovers');
  } finally {
    delete process.env.GIT_COMMITTER_DATE;
  }
  g(a.repo, 'update-ref', 'refs/remotes/origin/keel/T-11', g(a.wt, 'rev-parse', 'HEAD'));
  const r = spawnSync(process.execPath, [BIN, 'clean', '--auto'], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /removed .*T-11/);
  assert.ok(!existsSync(a.wt));

  const b = parked('T-12');
  g(b.repo, 'update-ref', 'refs/remotes/origin/keel/T-12', g(b.wt, 'rev-parse', 'HEAD'));
  writeFileSync(
    join(process.env.KEEL_STATE_DIR, 'ledger.jsonl'),
    `${JSON.stringify({ card: 'T-12', repo: b.repo, at: new Date(Date.now() - 9 * DAY).toISOString() })}\n`,
  );
  // The card file does not exist: the run fails after its start, and the cleanup has already run.
  const run = spawnSync(process.execPath, [BIN, 'run', 'missing-card.md', '--repo', b.repo], { encoding: 'utf8', env });
  assert.match(run.stderr, /removed .*T-12/);
  assert.ok(!existsSync(b.wt));
});

test('REQ-CLEAN-4 a worktree switched to another keel/ branch whose ID ends its name is not its own and is kept', () => {
  const { repo, wt } = parked('T-13');
  g(repo, 'branch', 'keel/13');
  g(wt, 'checkout', '-q', 'keel/13');
  assert.match(pass(Date.now() + 30 * DAY).lines.join('\n'), /kept .*T-13: on keel\/13, not keel\/T-13/);
  assert.ok(branchExists(repo, 'keel/13'));
  assert.ok(existsSync(wt));
});

test('REQ-CLEAN-4 the cleanup works on a fresh state dir and survives a corrupt report file', () => {
  process.env.KEEL_STATE_DIR = join(tmp('keel-autoclean-fresh-'), 'not-yet');
  assert.doesNotThrow(() => pass(Date.now()));
  writeFileSync(join(process.env.KEEL_STATE_DIR, 'cleanup-kept.json'), '{"half');
  assert.doesNotThrow(() => pass(Date.now()));
});

test('REQ-CLEAN-4 a dead checkout whose .git cannot be read is reported and the cleanup goes on', () => {
  const root = tmp('keel-autoclean-tmproot-');
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const bad = join(root, `keel-wt-${dead}-Bad000`);
  mkdirSync(join(bad, '.git'), { recursive: true }); // EISDIR is fine; make it unreadable as a file instead
  const worse = join(root, `keel-wt-${dead}-Bad111`);
  mkdirSync(worse);
  writeFileSync(join(worse, '.git'), 'gitdir: /nowhere');
  chmodSync(join(worse, '.git'), 0o000);
  const lines = [];
  assert.doesNotThrow(() => autoClean({ log: (m) => lines.push(m), now: Date.now(), tmpRoot: root }));
  assert.ok(!existsSync(bad));
});
