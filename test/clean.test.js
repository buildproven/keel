import assert from 'node:assert/strict';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { listParkedWorktrees, removeParkedWorktree } from '../src/clean.js';
import { g, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-clean-state-');
});

function fixtureRepoWithWorktree(cardId) {
  const repo = tmp('keel-clean-repo-');
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'user.email', 't@e.com');
  g(repo, 'config', 'user.name', 't');
  g(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'a.txt'), 'x');
  g(repo, 'add', '-A');
  g(repo, 'commit', '-q', '-m', 'base');
  const wtDir = join(process.env.KEEL_STATE_DIR, 'worktrees', `${basename(repo)}-abc123-${cardId}`);
  g(repo, 'worktree', 'add', '-q', '-b', `keel/${cardId}`, wtDir);
  return { repo, wtDir };
}

test('REQ-CLEAN-1 listParkedWorktrees finds every worktree keel has created, across repos', () => {
  const { wtDir: wt1 } = fixtureRepoWithWorktree('BUI-1');
  const { wtDir: wt2 } = fixtureRepoWithWorktree('BUI-2');
  const found = listParkedWorktrees()
    .map((w) => w.path)
    .sort();
  assert.deepEqual(found, [wt1, wt2].sort());
});

test('REQ-CLEAN-1 listParkedWorktrees reports the repo, branch, and whether it is clean', () => {
  const { repo, wtDir } = fixtureRepoWithWorktree('BUI-3');
  const [entry] = listParkedWorktrees();
  assert.equal(entry.path, wtDir);
  assert.equal(entry.branch, 'keel/BUI-3');
  assert.equal(entry.repo, realpathSync(repo), 'git resolves symlinks (e.g. macOS /tmp -> /private/tmp), so the comparison must too');
  assert.equal(entry.clean, true);
});

test('REQ-CLEAN-2 removeParkedWorktree removes the worktree and its branch', () => {
  const { repo, wtDir } = fixtureRepoWithWorktree('BUI-4');
  removeParkedWorktree({ repo, path: wtDir, branch: 'keel/BUI-4' });
  assert.ok(!existsSync(wtDir));
  assert.ok(!g(repo, 'branch', '--list', 'keel/BUI-4').trim());
});

test('REQ-CLEAN-2 removeParkedWorktree refuses a worktree with uncommitted changes unless forced', () => {
  const { repo, wtDir } = fixtureRepoWithWorktree('BUI-5');
  writeFileSync(join(wtDir, 'uncommitted.txt'), 'x');
  assert.throws(() => removeParkedWorktree({ repo, path: wtDir, branch: 'keel/BUI-5' }), /uncommitted|dirty/i);
  assert.ok(existsSync(wtDir), 'not removed without --force');
  removeParkedWorktree({ repo, path: wtDir, branch: 'keel/BUI-5', force: true });
  assert.ok(!existsSync(wtDir), 'removed with --force');
});
