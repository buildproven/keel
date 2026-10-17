import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { listParkedWorktrees, removeParkedWorktree } from '../src/clean.js';
import { g, tmp } from './helpers.js';

const BIN = new URL('../bin/keel.js', import.meta.url).pathname;

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-clean-state-');
});

/** A repo with a human branch `user-work` (one unmerged commit) and a Keel worktree for `cardId`. */
function repoWithUserBranch(cardId) {
  const repo = tmp('keel-clean-repo-');
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'user.email', 't@e.com');
  g(repo, 'config', 'user.name', 't');
  g(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'a.txt'), 'x');
  g(repo, 'add', '-A');
  g(repo, 'commit', '-q', '-m', 'base');
  g(repo, 'checkout', '-q', '-b', 'user-work');
  writeFileSync(join(repo, 'notes.txt'), 'unpushed human work\n');
  g(repo, 'add', '-A');
  g(repo, 'commit', '-q', '-m', 'my work');
  g(repo, 'checkout', '-q', 'main');
  const wt = join(process.env.KEEL_STATE_DIR, 'worktrees', `${basename(repo)}-abc12345-${cardId}`);
  g(repo, 'worktree', 'add', '-q', '-b', `keel/${cardId}`, wt);
  return { repo, wt };
}

test('REQ-CLEAN-2 keel clean --force never deletes a branch Keel did not make; a worktree moved off its keel/ branch is skipped and reported', () => {
  const { repo, wt } = repoWithUserBranch('T-8');
  g(wt, 'checkout', '-q', 'user-work'); // a worker left its branch for a human one
  const r = spawnSync(process.execPath, [BIN, 'clean', '--force'], { encoding: 'utf8', env: process.env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /skipped \(on user-work, not keel\/T-8\)/);
  assert.equal(g(repo, 'branch', '--list', '--format=%(refname:short)', 'user-work'), 'user-work', 'the human branch is kept');
});

test('REQ-CLEAN-1 a detached worktree is listed, not its own; clean --force skips it, and no non-keel branch is ever deleted', () => {
  const { repo, wt } = repoWithUserBranch('T-9');
  g(wt, 'checkout', '-q', '--detach');
  const [w] = listParkedWorktrees();
  assert.equal(w.branch, null);
  assert.equal(w.own, false);
  const r = spawnSync(process.execPath, [BIN, 'clean', '--force'], { encoding: 'utf8', env: process.env });
  assert.match(r.stderr, /skipped \(on a detached HEAD, not keel\/T-9\)/);
  assert.match(g(repo, 'worktree', 'list'), /T-9/);
  assert.throws(() => removeParkedWorktree({ repo, path: wt, branch: 'user-work', force: true }), /not a keel\/ branch/);
  assert.equal(g(repo, 'branch', '--list', '--format=%(refname:short)', 'user-work'), 'user-work');
});

test('REQ-CLEAN-2 a worktree on its own keel/ branch is still removed with that branch', () => {
  const { repo, wt } = repoWithUserBranch('T-10');
  const [w] = listParkedWorktrees();
  assert.equal(w.own, true);
  removeParkedWorktree(w);
  assert.equal(g(repo, 'branch', '--list', 'keel/T-10'), '');
  assert.doesNotMatch(g(repo, 'worktree', 'list'), new RegExp(basename(wt)));
});
